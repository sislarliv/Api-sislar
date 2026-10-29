import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { audit, notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { assertEvolutionTransition, assertNotTooFuture } from "../lib/evolutionRules.js";
import { HttpError } from "../lib/httpError.js";
import { offset, pageMeta, pageSchema } from "../lib/paging.js";
import { idParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const uploadDir = fileURLToPath(new URL("../../uploads", import.meta.url));
mkdirSync(uploadDir, { recursive: true });

const fileTypes = new Map([
  ["application/pdf", ".pdf"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename(_req, file, callback) {
      callback(null, `${randomUUID()}${fileTypes.get(file.mimetype)}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!fileTypes.has(file.mimetype)) {
      callback(new HttpError(422, "Tipo de arquivo não aceito. Use PDF, JPG, PNG ou DOCX."));
      return;
    }
    callback(null, true);
  },
});

const patientParams = z.object({ patientId: z.string().regex(/^[A-Za-z0-9_-]+$/) });
const statusSchema = z.enum(["estavel", "observacao", "cuidado_especial", "hospital"]);

function groupCare(fields) {
  const sections = [];
  for (const field of fields) {
    let section = sections.find((item) => item.id === field.section_id);
    if (!section) {
      section = { id: field.section_id, title: field.section_title, fields: [] };
      sections.push(section);
    }
    section.fields.push({ label: field.label, value: field.value });
  }
  return sections;
}

async function patientOr404(id) {
  const patient = await prisma.patients.findUnique({ where: { id } });
  if (!patient) notFound("Prontuário não encontrado.");
  return patient;
}

router.use(requireAuth);

router.get(
  "/",
  requirePerm("prontuario.view"),
  validate(pageSchema.extend({
    q: z.string().trim().max(80).optional(),
    status: statusSchema.optional(),
    wing: z.string().trim().max(40).optional(),
    tag: z.string().trim().max(40).optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, wing, tag } = req.query;
    const where = {
      ...(status ? { status } : {}),
      ...(wing ? { wing } : {}),
      ...(tag ? { patient_tags: { some: { tag } } } : {}),
      ...(q ? {
        OR: ["name", "treatment", "code", "room"].map((field) => ({
          [field]: { contains: q, mode: "insensitive" },
        })),
      } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.patients.count({ where }),
      prisma.patients.findMany({
        where,
        include: { patient_tags: true },
        orderBy: { name: "asc" },
        skip: offset(page, limit),
        take: limit,
      }),
    ]);
    res.json({
      data: rows.map((row) => {
        const { patient_tags, ...patient } = row;
        return present({ ...patient, tags: patient_tags.map((item) => item.tag) });
      }),
      meta: pageMeta(page, limit, total),
    });
  }),
);

router.get(
  "/:patientId",
  requirePerm("prontuario.view"),
  validate(patientParams, "params"),
  asyncHandler(async (req, res) => {
    const patient = await prisma.patients.findUnique({
      where: { id: req.params.patientId },
      include: {
        patient_tags: { orderBy: { tag: "asc" } },
        patient_alerts: { orderBy: { id: "asc" } },
        patient_contacts: { orderBy: [{ is_primary: "desc" }, { name: "asc" }] },
        patient_care_fields: { orderBy: { sort_order: "asc" } },
      },
    });
    if (!patient) notFound("Prontuário não encontrado.");
    const { patient_tags, patient_alerts, patient_contacts, patient_care_fields, ...rest } = patient;
    res.json({
      ...present(rest),
      tags: patient_tags.map((item) => item.tag),
      alerts: present(patient_alerts),
      contacts: present(patient_contacts),
      careData: groupCare(patient_care_fields),
    });
  }),
);

router.patch(
  "/:patientId",
  requirePerm("dados.edit"),
  validate(patientParams, "params"),
  validate(z.object({
    treatment: z.string().trim().min(2).max(80).optional(),
    wing: z.string().trim().min(2).max(40).optional(),
    room: z.string().trim().min(1).max(10).optional(),
    bed: z.enum(["A", "B"]).optional(),
    status: statusSchema.optional(),
  }).refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.")),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const data = { updated_at: new Date() };
    for (const key of ["treatment", "wing", "room", "bed", "status"]) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    const row = await prisma.patients.update({ where: { id: req.params.patientId }, data });
    res.json(present(row));
  }),
);

router.get("/:patientId/ficha", requirePerm("ficha.export"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  const patient = await prisma.patients.findUnique({
    where: { id: req.params.patientId },
    include: { patient_alerts: true, patient_contacts: true },
  });
  if (!patient) notFound("Prontuário não encontrado.");
  res.json({
    exportedAt: new Date().toISOString(),
    patient: present(patient),
    alerts: present(patient.patient_alerts),
    contacts: present(patient.patient_contacts),
  });
}));

router.post(
  "/:patientId/contatos",
  requirePerm("dados.edit"),
  validate(patientParams, "params"),
  validate(z.object({
    name: z.string().trim().min(3).max(120),
    relation: z.string().trim().min(2).max(40),
    phone: z.string().trim().min(8).max(20),
    isPrimary: z.boolean().optional(),
  })),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const created = await prisma.$transaction(async (tx) => {
      if (req.body.isPrimary) {
        await tx.patient_contacts.updateMany({ where: { patient_id: req.params.patientId }, data: { is_primary: false } });
      }
      return tx.patient_contacts.create({
        data: {
          patient_id: req.params.patientId,
          name: req.body.name,
          relation: req.body.relation,
          phone: req.body.phone,
          is_primary: req.body.isPrimary ?? false,
        },
      });
    });
    res.status(201).json(present(created));
  }),
);

router.delete(
  "/:patientId/contatos/:id",
  requirePerm("dados.edit"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  asyncHandler(async (req, res) => {
    const deleted = await prisma.patient_contacts.deleteMany({
      where: { id: req.params.id, patient_id: req.params.patientId },
    });
    if (!deleted.count) notFound();
    res.json({ id: req.params.id, deleted: true });
  }),
);

const evolutionBody = z.object({
  at: z.coerce.date().optional(),
  type: z.enum(["rotina", "reavaliacao", "cuidado", "intercorrencia"]),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(8000),
  notes: z.string().trim().max(2000).nullish(),
  alimentacao: z.string().trim().max(80).nullish(),
  hidratacao: z.string().trim().max(80).nullish(),
  sono: z.string().trim().max(80).nullish(),
  humor: z.string().trim().max(80).nullish(),
  mobilidade: z.string().trim().max(80).nullish(),
  pele: z.string().trim().max(80).nullish(),
  status: z.enum(["rascunho", "finalizado"]).optional(),
});

router.get(
  "/:patientId/evolucoes",
  requirePerm("evolucao.view"),
  validate(patientParams, "params"),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const rows = await prisma.evolutions.findMany({
      where: { patient_id: req.params.patientId },
      include: { users: { select: { name: true } } },
      orderBy: { at: "desc" },
    });
    res.json({
      data: rows.map((row) => present({ ...row, author_name: row.users.name, users: undefined })),
    });
  }),
);

router.post(
  "/:patientId/evolucoes",
  requirePerm("evolucao.create"),
  validate(patientParams, "params"),
  validate(evolutionBody),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const at = assertNotTooFuture(req.body.at ?? new Date(), "Data da evolução");
    const status = req.body.status ?? "rascunho";
    const row = await prisma.evolutions.create({
      data: {
        patient_id: req.params.patientId,
        at,
        author_id: req.user.id,
        type: req.body.type,
        title: req.body.title,
        description: req.body.description,
        notes: req.body.notes ?? null,
        alimentacao: req.body.alimentacao ?? null,
        hidratacao: req.body.hidratacao ?? null,
        sono: req.body.sono ?? null,
        humor: req.body.humor ?? null,
        mobilidade: req.body.mobilidade ?? null,
        pele: req.body.pele ?? null,
        status,
        closed_at: status === "finalizado" ? at : null,
      },
    });
    res.status(201).json(present(row));
  }),
);

router.patch(
  "/:patientId/evolucoes/:id",
  requirePerm("evolucao.create"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  validate(evolutionBody.partial().refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.")),
  asyncHandler(async (req, res) => {
    const current = await prisma.evolutions.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
    if (!current) notFound();
    assertEvolutionTransition(current.status, "update");
    const data = { at: req.body.at ? assertNotTooFuture(req.body.at, "Data da evolução") : current.at };
    for (const key of ["type", "title", "description", "notes", "alimentacao", "hidratacao", "sono", "humor", "mobilidade", "pele"]) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    const row = await prisma.evolutions.update({ where: { id: current.id }, data });
    res.json(present(row));
  }),
);

router.post(
  "/:patientId/evolucoes/:id/finalizar",
  requirePerm("evolucao.create"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  asyncHandler(async (req, res) => {
    const current = await prisma.evolutions.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
    if (!current) notFound();
    assertEvolutionTransition(current.status, "finalize");
    const row = await prisma.evolutions.update({
      where: { id: current.id },
      data: { status: "finalizado", closed_at: current.closed_at ?? new Date() },
    });
    res.json(present(row));
  }),
);

router.post(
  "/:patientId/evolucoes/:id/corrigir",
  requirePerm("evolucao.correct"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  validate(z.object({
    reason: z.string().trim().min(5).max(500),
    description: z.string().trim().min(10).max(8000),
  })),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.evolutions.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
      if (!current) notFound();
      assertEvolutionTransition(current.status, "correct");
      await tx.evolution_corrections.create({
        data: {
          evolution_id: current.id,
          by_id: req.user.id,
          reason: req.body.reason,
          previous_description: current.description,
        },
      });
      const updated = await tx.evolutions.update({
        where: { id: current.id },
        data: { description: req.body.description },
      });
      await audit(tx, { userId: req.user.id, action: "corrigir", entity: "evolucao", entityId: current.id, payload: { reason: req.body.reason } });
      return updated;
    });
    res.json(present(row));
  }),
);

router.get(
  "/:patientId/evolucoes/:id/correcoes",
  requirePerm("evolucao.view"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.evolution_corrections.findMany({
      where: { evolution_id: req.params.id },
      include: { users: { select: { name: true } } },
      orderBy: { at: "asc" },
    });
    res.json({
      data: rows.map((row) => present({ ...row, by_name: row.users.name, users: undefined })),
    });
  }),
);

const vitalBody = z.object({
  kind: z.enum(["pa", "glicemia"]),
  at: z.coerce.date().optional(),
  systolic: z.number().int().min(40).max(250).optional(),
  diastolic: z.number().int().min(20).max(150).optional(),
  pulse: z.number().int().min(30).max(220).optional(),
  glucose: z.number().int().min(20).max(600).optional(),
  context: z.string().trim().min(2).max(120),
}).superRefine((body, ctx) => {
  if (body.kind === "pa") {
    if (body.systolic == null || body.diastolic == null || body.pulse == null) {
      ctx.addIssue({ code: "custom", message: "Informe sistólica, diastólica e pulso.", path: ["systolic"] });
    } else if (body.systolic <= body.diastolic) {
      ctx.addIssue({ code: "custom", message: "A sistólica precisa ser maior que a diastólica.", path: ["systolic"] });
    }
    if (body.glucose != null) ctx.addIssue({ code: "custom", message: "Glicemia não entra na pressão.", path: ["glucose"] });
  }
  if (body.kind === "glicemia") {
    if (body.glucose == null) ctx.addIssue({ code: "custom", message: "Informe a glicemia.", path: ["glucose"] });
    if (body.systolic != null || body.diastolic != null || body.pulse != null) {
      ctx.addIssue({ code: "custom", message: "Pressão não entra na glicemia.", path: ["systolic"] });
    }
  }
});

router.get(
  "/:patientId/sinais-vitais",
  requirePerm("vitais.view"),
  validate(patientParams, "params"),
  validate(z.object({ kind: z.enum(["pa", "glicemia"]).optional() }), "query"),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const rows = await prisma.vitals.findMany({
      where: { patient_id: req.params.patientId, ...(req.query.kind ? { kind: req.query.kind } : {}) },
      orderBy: { at: "desc" },
    });
    res.json({ data: present(rows) });
  }),
);

router.post(
  "/:patientId/sinais-vitais",
  requirePerm("vitais.create"),
  validate(patientParams, "params"),
  validate(vitalBody),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const at = assertNotTooFuture(req.body.at ?? new Date(), "Data da aferição");
    const row = await prisma.vitals.create({
      data: {
        patient_id: req.params.patientId,
        kind: req.body.kind,
        at,
        systolic: req.body.kind === "pa" ? req.body.systolic : null,
        diastolic: req.body.kind === "pa" ? req.body.diastolic : null,
        pulse: req.body.kind === "pa" ? req.body.pulse : null,
        glucose: req.body.kind === "glicemia" ? req.body.glucose : null,
        context: req.body.context,
        author_id: req.user.id,
      },
    });
    res.status(201).json(present(row));
  }),
);

router.get("/:patientId/ocorrencias", requirePerm("ocorrencia.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  const rows = await prisma.occurrences.findMany({ where: { patient_id: req.params.patientId }, orderBy: { at: "desc" } });
  res.json({ data: present(rows) });
}));

router.post(
  "/:patientId/ocorrencias",
  requirePerm("ocorrencia.create"),
  validate(patientParams, "params"),
  validate(z.object({
    category: z.string().trim().min(2).max(60),
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(4000),
    at: z.coerce.date().optional(),
    responsibleId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    priority: z.enum(["normal", "atencao"]).optional(),
  })),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const at = assertNotTooFuture(req.body.at ?? new Date(), "Data da ocorrência");
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.occurrences.create({
        data: {
          patient_id: req.params.patientId,
          category: req.body.category,
          title: req.body.title,
          description: req.body.description,
          at,
          author_id: req.user.id,
          responsible_id: req.body.responsibleId,
          status: "aberta",
          priority: req.body.priority ?? "normal",
        },
      });
      await tx.occurrence_history.create({
        data: { occurrence_id: row.id, by_id: req.user.id, action: "abertura", text: "Ocorrência registrada pela equipe." },
      });
      return row;
    });
    res.status(201).json(present(created));
  }),
);

router.post(
  "/:patientId/ocorrencias/:id/acompanhamentos",
  requirePerm("ocorrencia.followup"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  validate(z.object({ text: z.string().trim().min(5).max(2000) })),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.occurrences.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
      if (!current) notFound();
      if (current.status === "encerrada") throw new HttpError(409, "Ocorrência encerrada não recebe acompanhamento.");
      await tx.occurrences.update({ where: { id: current.id }, data: { status: "acompanhamento" } });
      return tx.occurrence_history.create({
        data: { occurrence_id: current.id, by_id: req.user.id, action: "acompanhamento", text: req.body.text },
      });
    });
    res.status(201).json(present(row));
  }),
);

router.post(
  "/:patientId/ocorrencias/:id/encerrar",
  requirePerm("ocorrencia.close"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  validate(z.object({ text: z.string().trim().min(5).max(2000), notes: z.string().trim().max(2000).optional() })),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.occurrences.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
      if (!current) notFound();
      if (current.status === "encerrada") throw new HttpError(409, "Ocorrência já está encerrada.");
      const updated = await tx.occurrences.update({
        where: { id: current.id },
        data: { status: "encerrada", notes: req.body.notes ?? current.notes },
      });
      await tx.occurrence_history.create({
        data: { occurrence_id: current.id, by_id: req.user.id, action: "encerramento", text: req.body.text },
      });
      return updated;
    });
    res.json(present(row));
  }),
);

router.get("/:patientId/documentos", requirePerm("documento.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  const rows = await prisma.documents.findMany({
    where: { patient_id: req.params.patientId },
    select: { id: true, name: true, type: true, at: true, author_id: true, status: true, ext: true, size_kb: true, description: true, archived_at: true },
    orderBy: { at: "desc" },
  });
  res.json({ data: present(rows) });
}));

router.post(
  "/:patientId/documentos",
  requirePerm("documento.upload"),
  validate(patientParams, "params"),
  (req, res, next) => {
    upload.single("arquivo")(req, res, (error) => {
      if (!error) return next();
      if (error instanceof HttpError) return next(error);
      if (error.code === "LIMIT_FILE_SIZE") return next(new HttpError(422, "Arquivo acima de 8 MB."));
      return next(new HttpError(422, "Não foi possível receber o arquivo."));
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file || req.file.size === 0) throw new HttpError(422, "Anexe um arquivo.");
    const type = z.string().trim().min(2).max(80).safeParse(req.body.type);
    if (!type.success) throw new HttpError(422, "Informe o tipo do documento.");
    await patientOr404(req.params.patientId);
    const row = await prisma.documents.create({
      data: {
        patient_id: req.params.patientId,
        name: path.basename(req.file.originalname || "documento").slice(0, 180),
        type: type.data,
        author_id: req.user.id,
        status: "vigente",
        ext: path.extname(req.file.filename).slice(1),
        size_kb: Math.max(1, Math.ceil(req.file.size / 1024)),
        description: req.body.description ?? null,
        storage_path: req.file.filename,
      },
      select: { id: true, name: true, type: true, at: true, status: true, ext: true, size_kb: true, description: true },
    });
    res.status(201).json(present(row));
  }),
);

router.get(
  "/:patientId/documentos/:id/download",
  requirePerm("documento.download"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  asyncHandler(async (req, res) => {
    const row = await prisma.documents.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
    if (!row) notFound();
    res.download(path.join(uploadDir, path.basename(row.storage_path)), row.name);
  }),
);

router.post(
  "/:patientId/documentos/:id/arquivar",
  requirePerm("documento.archive"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  asyncHandler(async (req, res) => {
    const current = await prisma.documents.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
    if (!current) notFound();
    if (current.status === "arquivado") throw new HttpError(409, "Documento já está arquivado.");
    const row = await prisma.documents.update({
      where: { id: current.id },
      data: { status: "arquivado", archived_at: new Date(), archived_by_id: req.user.id },
      select: { id: true, status: true, archived_at: true },
    });
    res.json(present(row));
  }),
);

router.get("/:patientId/planos", requirePerm("plano.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  const plans = await prisma.care_plans.findMany({ where: { patient_id: req.params.patientId }, orderBy: { start_date: "desc" } });
  res.json({ data: present(plans) });
}));

router.post(
  "/:patientId/planos",
  requirePerm("plano.create"),
  validate(patientParams, "params"),
  validate(z.object({
    title: z.string().trim().min(3).max(160),
    area: z.string().trim().min(2).max(60),
    objective: z.string().trim().min(10).max(2000),
    responsibleId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    status: z.enum(["ativo", "encerrado", "futuro"]).optional(),
    actions: z.array(z.object({
      title: z.string().trim().min(3).max(200),
      responsibleId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      frequency: z.string().trim().min(2).max(40),
    })).min(1).max(20),
  })),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const created = await prisma.$transaction(async (tx) => {
      const plan = await tx.care_plans.create({
        data: {
          patient_id: req.params.patientId,
          title: req.body.title,
          area: req.body.area,
          objective: req.body.objective,
          responsible_id: req.body.responsibleId,
          start_date: new Date(req.body.startDate),
          end_date: req.body.endDate ? new Date(req.body.endDate) : null,
          status: req.body.status ?? "ativo",
        },
      });
      await tx.care_plan_actions.createMany({
        data: req.body.actions.map((action) => ({
          plan_id: plan.id,
          title: action.title,
          responsible_id: action.responsibleId,
          frequency: action.frequency,
        })),
      });
      return plan;
    });
    res.status(201).json(present(created));
  }),
);

router.post(
  "/:patientId/planos/:id/atualizacoes",
  requirePerm("plano.edit"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  validate(z.object({ text: z.string().trim().min(5).max(2000) })),
  asyncHandler(async (req, res) => {
    const plan = await prisma.care_plans.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
    if (!plan) notFound();
    const row = await prisma.care_plan_updates.create({
      data: { plan_id: plan.id, by_id: req.user.id, text: req.body.text },
    });
    res.status(201).json(present(row));
  }),
);

export default router;

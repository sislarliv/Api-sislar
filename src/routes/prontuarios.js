import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
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
const dateFilter = z.coerce.date().optional();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "Data inválida.",
);

function can(req, permission) {
  return req.user.permissions.includes(permission);
}

function atFilter({ from, to }) {
  return from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
}

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

const clinicalPermissions = ["clinico.view", "clinico.edit"];

router.get("/acesso/perfis", requirePerm("usuarios.manage"), asyncHandler(async (_req, res) => {
  const roles = await prisma.roles.findMany({
    include: { role_permissions: { where: { permission_code: { in: clinicalPermissions } }, select: { permission_code: true } } },
    orderBy: { label: "asc" },
  });
  res.json({ data: roles.map(({ role_permissions, ...role }) => ({
    ...role,
    view: role.id === "admin" || role_permissions.some((item) => item.permission_code === "clinico.view"),
    edit: role.id === "admin" || role_permissions.some((item) => item.permission_code === "clinico.edit"),
  })) });
}));

router.put(
  "/acesso/perfis/:roleId",
  requirePerm("usuarios.manage"),
  validate(z.object({ roleId: idParam.shape.id }), "params"),
  validate(z.object({ view: z.boolean(), edit: z.boolean() }).strict().refine((body) => !body.edit || body.view, { path: ["edit"], message: "Edição exige visualização." })),
  asyncHandler(async (req, res) => {
    if (req.params.roleId === "admin") throw new HttpError(422, "O administrador mantém acesso clínico integral.");
    const access = await prisma.$transaction(async (tx) => {
      const role = await tx.roles.findUnique({ where: { id: req.params.roleId }, select: { id: true, label: true } });
      if (!role) notFound("Perfil não encontrado.");
      const previous = await tx.role_permissions.findMany({ where: { role_id: role.id, permission_code: { in: clinicalPermissions } }, select: { permission_code: true } });
      await tx.role_permissions.deleteMany({ where: { role_id: role.id, permission_code: { in: clinicalPermissions } } });
      const codes = [req.body.view ? "clinico.view" : null, req.body.edit ? "clinico.edit" : null].filter(Boolean);
      if (codes.length) await tx.role_permissions.createMany({ data: codes.map((permission_code) => ({ role_id: role.id, permission_code })) });
      await audit(tx, { userId: req.user.id, action: "configurar_permissoes", entity: "perfil_prontuario", entityId: role.id, payload: { previous: previous.map((item) => item.permission_code), current: codes } });
      return { roleId: role.id, label: role.label, view: req.body.view, edit: req.body.edit };
    });
    res.json(access);
  }),
);

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
        patient_alerts: { where: { active: true, context: { in: ["prontuario", "ambos"] } }, orderBy: { id: "asc" } },
        patient_contacts: { orderBy: [{ is_primary: "desc" }, { name: "asc" }] },
        ...(can(req, "clinico.view") ? { patient_care_fields: { orderBy: { sort_order: "asc" } } } : {}),
      },
    });
    if (!patient) notFound("Prontuário não encontrado.");
    const { patient_tags, patient_alerts, patient_contacts, patient_care_fields, ...rest } = patient;
    res.json({
      ...present(rest),
      tags: patient_tags.map((item) => item.tag),
      alerts: present(patient_alerts),
      contacts: present(patient_contacts),
      ...(can(req, "clinico.view") ? { careData: groupCare(patient_care_fields) } : {}),
    });
  }),
);

const careSectionsBody = z.object({
  sections: z.array(z.object({
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    title: z.string().trim().min(2).max(100),
    fields: z.array(z.object({
      label: z.string().trim().min(2).max(100),
      value: z.string().trim().min(1).max(2000),
    }).strict()).min(1).max(30),
  }).strict()).min(1).max(12),
}).strict().superRefine(({ sections }, ctx) => {
  const ids = new Set();
  for (const [sectionIndex, section] of sections.entries()) {
    if (ids.has(section.id)) ctx.addIssue({ code: "custom", path: ["sections", sectionIndex, "id"], message: "Seção duplicada." });
    ids.add(section.id);
    const labels = new Set();
    for (const [fieldIndex, field] of section.fields.entries()) {
      const label = field.label.toLocaleLowerCase("pt-BR");
      if (labels.has(label)) ctx.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "label"], message: "Campo duplicado na seção." });
      labels.add(label);
    }
  }
});

router.get("/:patientId/dados-clinicos", requirePerm("clinico.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  await patientOr404(req.params.patientId);
  const fields = await prisma.patient_care_fields.findMany({
    where: { patient_id: req.params.patientId }, orderBy: { sort_order: "asc" },
  });
  res.json({ sections: groupCare(fields) });
}));

router.put(
  "/:patientId/dados-clinicos",
  requirePerm("clinico.edit"),
  validate(patientParams, "params"),
  validate(careSectionsBody),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const fields = req.body.sections.flatMap((section) => section.fields.map((field) => ({
      patient_id: req.params.patientId,
      section_id: section.id,
      section_title: section.title,
      label: field.label,
      value: field.value,
    }))).map((field, sort_order) => ({ ...field, sort_order }));
    await prisma.$transaction(async (tx) => {
      const previous = await tx.patient_care_fields.findMany({
        where: { patient_id: req.params.patientId }, orderBy: { sort_order: "asc" },
      });
      await tx.patient_care_fields.deleteMany({ where: { patient_id: req.params.patientId } });
      await tx.patient_care_fields.createMany({ data: fields });
      await audit(tx, { userId: req.user.id, action: "atualizar", entity: "dados_clinicos", entityId: req.params.patientId,
        payload: { previous: groupCare(previous), current: req.body.sections } });
    }, { isolationLevel: "Serializable" });
    res.json({ sections: req.body.sections });
  }),
);

router.get("/:patientId/dados-clinicos/historico", requirePerm("clinico.view"),
  validate(patientParams, "params"), validate(pageSchema, "query"), asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const where = { entity: "dados_clinicos", entity_id: req.params.patientId, action: "atualizar" };
    const [total, rows] = await Promise.all([
      prisma.audit_log.count({ where }),
      prisma.audit_log.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }],
        skip: offset(req.query.page, req.query.limit), take: req.query.limit,
        include: { users: { select: { name: true } } },
      }),
    ]);
    res.json({ data: rows.map((row) => present({ id: row.id, at: row.at,
      by_id: row.user_id, by_name: row.users?.name ?? null,
      previous: row.payload.previous ?? null, current: row.payload.current ?? null })),
    meta: pageMeta(req.query.page, req.query.limit, total) });
  }));

router.get("/:patientId/completo", requirePerm("prontuario.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  const patient = await prisma.patients.findUnique({
    where: { id: req.params.patientId },
    include: { patient_tags: true, patient_alerts: { where: { active: true, context: { in: ["prontuario", "ambos"] } } }, patient_contacts: true },
  });
  if (!patient) notFound("Prontuário não encontrado.");
  const { patient_tags, patient_alerts, patient_contacts, ...identity } = patient;
  const sections = {
    identificacao: {
      ...present(identity),
      tags: patient_tags.map(({ tag }) => tag),
      alerts: present(patient_alerts),
      contacts: present(patient_contacts),
    },
  };
  const loaders = [
    ["dadosClinicos", "clinico.view", async () => groupCare(await prisma.patient_care_fields.findMany({ where: { patient_id: patient.id }, orderBy: { sort_order: "asc" } }))],
    ["evolucoes", "evolucao.view", async () => present(await prisma.evolutions.findMany({ where: { patient_id: patient.id }, orderBy: [{ at: "desc" }, { id: "desc" }] }))],
    ["sinaisVitais", "vitais.view", async () => present(await prisma.vitals.findMany({ where: { patient_id: patient.id }, orderBy: [{ at: "desc" }, { id: "desc" }] }))],
    ["ocorrencias", "ocorrencia.view", async () => present(await prisma.occurrences.findMany({ where: { patient_id: patient.id }, orderBy: [{ at: "desc" }, { id: "desc" }] }))],
    ["documentos", "documento.view", async () => present(await prisma.documents.findMany({ where: { patient_id: patient.id }, select: { id: true, name: true, type: true, at: true, author_id: true, status: true, ext: true, size_kb: true, description: true, linked_record_type: true, linked_record_id: true }, orderBy: [{ at: "desc" }, { id: "desc" }] }))],
    ["planos", "plano.view", async () => present(await prisma.care_plans.findMany({ where: { patient_id: patient.id }, include: { care_plan_actions: true, care_plan_updates: { orderBy: { at: "desc" } } }, orderBy: { start_date: "desc" } }))],
    ["atendimentos", "modulo.agenda", async () => present(await prisma.appointments.findMany({ where: { patient_id: patient.id }, orderBy: [{ at: "desc" }, { id: "desc" }] }))],
  ];
  const loaded = await Promise.all(loaders.filter(([, permission]) => can(req, permission)).map(async ([key, , loader]) => [key, await loader()]));
  for (const [key, value] of loaded) sections[key] = value;
  res.json({ patientId: patient.id, sections });
}));

const timelineQuery = pageSchema.extend({
  from: dateFilter,
  to: dateFilter,
  type: z.enum(["evolucao", "sinal_vital", "ocorrencia", "documento", "plano", "atendimento"]).optional(),
}).refine(({ from, to }) => !from || !to || from <= to, { path: ["to"], message: "Período inválido." });

router.get(
  "/:patientId/linha-do-tempo",
  requirePerm("prontuario.view"),
  validate(patientParams, "params"),
  validate(timelineQuery, "query"),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const { page, limit, from, to, type } = req.query;
    const patientId = req.params.patientId;
    const period = atFilter({ from, to });
    const loaders = [
      ["evolucao", "evolucao.view", async () => (await prisma.evolutions.findMany({ where: { patient_id: patientId, ...period }, select: { id: true, at: true, type: true, title: true, author_id: true } })).map((row) => ({ id: row.id, type: "evolucao", at: row.at, title: row.title, subtype: row.type, authorId: row.author_id }))],
      ["sinal_vital", "vitais.view", async () => (await prisma.vitals.findMany({ where: { patient_id: patientId, ...period }, select: { id: true, at: true, kind: true, author_id: true } })).map((row) => ({ id: row.id, type: "sinal_vital", at: row.at, title: row.kind === "pa" ? "Pressão arterial" : "Glicemia", subtype: row.kind, authorId: row.author_id }))],
      ["ocorrencia", "ocorrencia.view", async () => (await prisma.occurrences.findMany({ where: { patient_id: patientId, ...period }, select: { id: true, at: true, title: true, category: true, author_id: true } })).map((row) => ({ id: row.id, type: "ocorrencia", at: row.at, title: row.title, subtype: row.category, authorId: row.author_id }))],
      ["documento", "documento.view", async () => (await prisma.documents.findMany({ where: { patient_id: patientId, ...period }, select: { id: true, at: true, name: true, type: true, author_id: true } })).map((row) => ({ id: row.id, type: "documento", at: row.at, title: row.name, subtype: row.type, authorId: row.author_id }))],
      ["plano", "plano.view", async () => (await prisma.care_plans.findMany({ where: { patient_id: patientId, ...((from || to) ? { start_date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) }, select: { id: true, start_date: true, title: true, area: true, responsible_id: true } })).map((row) => ({ id: row.id, type: "plano", at: row.start_date, title: row.title, subtype: row.area, authorId: row.responsible_id }))],
      ["atendimento", "modulo.agenda", async () => (await prisma.appointments.findMany({ where: { patient_id: patientId, ...period }, select: { id: true, at: true, specialty: true, professional_id: true } })).map((row) => ({ id: row.id, type: "atendimento", at: row.at, title: row.specialty, authorId: row.professional_id }))],
    ];
    const active = loaders.filter(([kind, permission]) => can(req, permission) && (!type || type === kind));
    const rows = (await Promise.all(active.map(([, , load]) => load()))).flat();
    rows.sort((a, b) => b.at.getTime() - a.at.getTime() || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    res.json({ data: rows.slice(offset(page, limit), offset(page, limit) + limit).map(present), meta: pageMeta(page, limit, rows.length) });
  }),
);

router.get("/:patientId/ficha", requirePerm("ficha.export"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  const exportedAt = new Date().toISOString();
  const ficha = await prisma.$transaction(async (tx) => {
    const patient = await tx.patients.findUnique({
      where: { id: req.params.patientId },
      select: { id: true, code: true, name: true, treatment: true, sex: true, birth_date: true, admission_date: true, wing: true, room: true, bed: true, status: true, active: true, presence_status: true, presence_detail: true, patient_alerts: { where: { active: true, context: { in: ["prontuario", "ambos"] } } }, patient_contacts: true },
    });
    if (!patient) notFound("Prontuário não encontrado.");
    const { patient_alerts, patient_contacts, ...identity } = patient;
    const data = {
      exportedAt,
      patient: present(identity),
      alerts: present(patient_alerts),
      contacts: present(patient_contacts),
    };
    if (can(req, "clinico.view")) {
      data.careData = groupCare(await tx.patient_care_fields.findMany({ where: { patient_id: patient.id }, orderBy: { sort_order: "asc" } }));
    }
    if (can(req, "evolucao.view")) {
      data.latestEvolution = present(await tx.evolutions.findFirst({ where: { patient_id: patient.id }, orderBy: { at: "desc" } }));
    }
    if (can(req, "vitais.view")) {
      data.latestVitals = present(await tx.vitals.findMany({ where: { patient_id: patient.id }, orderBy: { at: "desc" }, take: 2 }));
    }
    await audit(tx, { userId: req.user.id, action: "exportar", entity: "ficha_idoso", entityId: patient.id, payload: { exportedAt, fields: Object.keys(data) } });
    return data;
  });
  res.setHeader("Content-Disposition", `attachment; filename="ficha-${req.params.patientId}.json"`);
  res.json(ficha);
}));

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
const evolutionQuery = pageSchema.extend({
  from: dateFilter,
  to: dateFilter,
  authorId: idParam.shape.id.optional(),
  type: z.enum(["rotina", "reavaliacao", "cuidado", "intercorrencia"]).optional(),
}).refine(({ from, to }) => !from || !to || from <= to, { path: ["to"], message: "Período inválido." });

router.get(
  "/:patientId/evolucoes",
  requirePerm("evolucao.view"),
  validate(patientParams, "params"),
  validate(evolutionQuery, "query"),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const { page, limit, from, to, authorId, type } = req.query;
    const where = { patient_id: req.params.patientId, ...atFilter({ from, to }), ...(authorId ? { author_id: authorId } : {}), ...(type ? { type } : {}) };
    const [total, rows] = await Promise.all([
      prisma.evolutions.count({ where }),
      prisma.evolutions.findMany({
        where,
        include: { users: { select: { name: true } } },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        skip: offset(page, limit),
        take: limit,
      }),
    ]);
    res.json({
      data: rows.map((row) => present({ ...row, author_name: row.users.name, users: undefined })),
      meta: pageMeta(page, limit, total),
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
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.evolutions.create({
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
      await audit(tx, { userId: req.user.id, action: "criar", entity: "evolucao", entityId: created.id, payload: { patientId: req.params.patientId, status } });
      return created;
    });
    res.status(201).json(present(row));
  }),
);

router.patch(
  "/:patientId/evolucoes/:id",
  requirePerm("evolucao.create"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  validate(evolutionBody.omit({ status: true }).partial().strict().refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.")),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.evolutions.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
      if (!current) notFound();
      assertEvolutionTransition(current.status, "update");
      const data = { at: req.body.at ? assertNotTooFuture(req.body.at, "Data da evolução") : current.at };
      for (const key of ["type", "title", "description", "notes", "alimentacao", "hidratacao", "sono", "humor", "mobilidade", "pele"]) {
        if (req.body[key] !== undefined) data[key] = req.body[key];
      }
      const changed = await tx.evolutions.updateMany({ where: { id: current.id, status: "rascunho" }, data });
      if (!changed.count) throw new HttpError(409, "Evolução finalizada não pode ser alterada. Registre uma correção.");
      const updated = await tx.evolutions.findUnique({ where: { id: current.id } });
      await audit(tx, { userId: req.user.id, action: "editar", entity: "evolucao", entityId: current.id, payload: { fields: Object.keys(req.body) } });
      return updated;
    });
    res.json(present(row));
  }),
);

router.post(
  "/:patientId/evolucoes/:id/finalizar",
  requirePerm("evolucao.create"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.evolutions.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
      if (!current) notFound();
      assertEvolutionTransition(current.status, "finalize");
      const changed = await tx.evolutions.updateMany({ where: { id: current.id, status: "rascunho" }, data: { status: "finalizado", closed_at: new Date() } });
      if (!changed.count) throw new HttpError(409, "Evolução finalizada não pode ser alterada. Registre uma correção.");
      const updated = await tx.evolutions.findUnique({ where: { id: current.id } });
      await audit(tx, { userId: req.user.id, action: "finalizar", entity: "evolucao", entityId: current.id, payload: { patientId: req.params.patientId } });
      return updated;
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
      if (req.body.description === current.description) throw new HttpError(422, "A correção precisa alterar a descrição.");
      const changed = await tx.evolutions.updateMany({
        where: { id: current.id, status: "finalizado", description: current.description },
        data: { description: req.body.description },
      });
      if (!changed.count) throw new HttpError(409, "A evolução foi corrigida por outra pessoa. Recarregue e tente novamente.");
      await tx.evolution_corrections.create({
        data: {
          evolution_id: current.id,
          by_id: req.user.id,
          reason: req.body.reason,
          previous_description: current.description,
        },
      });
      const updated = await tx.evolutions.findUnique({ where: { id: current.id } });
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
    const evolution = await prisma.evolutions.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId }, select: { id: true } });
    if (!evolution) notFound();
    const rows = await prisma.evolution_corrections.findMany({
      where: { evolution_id: evolution.id },
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
const vitalQuery = z.object({
  kind: z.enum(["pa", "glicemia"]).optional(),
  from: dateFilter,
  to: dateFilter,
}).refine(({ from, to }) => !from || !to || from <= to, { path: ["to"], message: "Período inválido." });

router.get(
  "/:patientId/sinais-vitais",
  requirePerm("vitais.view"),
  validate(patientParams, "params"),
  validate(vitalQuery, "query"),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const rows = await prisma.vitals.findMany({
      where: { patient_id: req.params.patientId, ...(req.query.kind ? { kind: req.query.kind } : {}), ...atFilter(req.query) },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    res.json({ data: present(rows) });
  }),
);

router.get(
  "/:patientId/sinais-vitais/grafico",
  requirePerm("vitais.view"),
  validate(patientParams, "params"),
  validate(vitalQuery, "query"),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const where = { patient_id: req.params.patientId, ...(req.query.kind ? { kind: req.query.kind } : {}), ...atFilter(req.query) };
    const rows = await prisma.vitals.findMany({ where, orderBy: [{ at: "asc" }, { id: "asc" }] });
    res.json({
      period: { from: req.query.from?.toISOString() ?? null, to: req.query.to?.toISOString() ?? null },
      points: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        at: row.at.toISOString(),
        context: row.context,
        authorId: row.author_id,
        ...(row.kind === "pa" ? { systolic: row.systolic, diastolic: row.diastolic, pulse: row.pulse } : { glucose: row.glucose }),
      })),
    });
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
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.vitals.create({
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
      await audit(tx, { userId: req.user.id, action: "criar", entity: "sinal_vital", entityId: created.id, payload: { patientId: req.params.patientId, kind: req.body.kind } });
      return created;
    });
    res.status(201).json(present(row));
  }),
);

router.get("/:patientId/ocorrencias", requirePerm("ocorrencia.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  await patientOr404(req.params.patientId);
  const rows = await prisma.occurrences.findMany({ where: { patient_id: req.params.patientId }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  res.json({ data: present(rows) });
}));

router.get("/:patientId/ocorrencias/:id", requirePerm("ocorrencia.view"), validate(patientParams.extend({ id: idParam.shape.id }), "params"), asyncHandler(async (req, res) => {
  const row = await prisma.occurrences.findFirst({
    where: { id: req.params.id, patient_id: req.params.patientId },
    include: { occurrence_history: { orderBy: { at: "asc" } } },
  });
  if (!row) notFound();
  res.json(present(row));
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
      const responsible = await tx.users.findFirst({ where: { id: req.body.responsibleId, active: true }, select: { id: true } });
      if (!responsible) throw new HttpError(422, "Responsável inexistente ou inativo.");
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
      await audit(tx, { userId: req.user.id, action: "criar", entity: "ocorrencia", entityId: row.id, payload: { patientId: req.params.patientId, category: req.body.category } });
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
      const changed = await tx.occurrences.updateMany({
        where: { id: current.id, status: { not: "encerrada" } }, data: { status: "acompanhamento" },
      });
      if (!changed.count) throw new HttpError(409, "Ocorrência encerrada não recebe acompanhamento.");
      const history = await tx.occurrence_history.create({
        data: { occurrence_id: current.id, by_id: req.user.id, action: "acompanhamento", text: req.body.text },
      });
      await audit(tx, { userId: req.user.id, action: "acompanhar", entity: "ocorrencia", entityId: current.id, payload: { patientId: req.params.patientId } });
      return history;
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
      const changed = await tx.occurrences.updateMany({
        where: { id: current.id, status: { not: "encerrada" } },
        data: { status: "encerrada", notes: req.body.notes ?? current.notes },
      });
      if (!changed.count) throw new HttpError(409, "Ocorrência já está encerrada.");
      const updated = await tx.occurrences.findUnique({ where: { id: current.id } });
      await tx.occurrence_history.create({
        data: { occurrence_id: current.id, by_id: req.user.id, action: "encerramento", text: req.body.text },
      });
      await audit(tx, { userId: req.user.id, action: "encerrar", entity: "ocorrencia", entityId: current.id, payload: { patientId: req.params.patientId } });
      return updated;
    });
    res.json(present(row));
  }),
);

router.get("/:patientId/documentos", requirePerm("documento.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  await patientOr404(req.params.patientId);
  const rows = await prisma.documents.findMany({
    where: { patient_id: req.params.patientId },
    select: { id: true, name: true, type: true, at: true, author_id: true, status: true, ext: true, size_kb: true, description: true, archived_at: true, linked_record_type: true, linked_record_id: true },
    orderBy: { at: "desc" },
  });
  res.json({ data: present(rows) });
}));

const documentBody = z.object({
  type: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).optional(),
  linkedRecordType: z.enum(["evolucao", "ocorrencia", "plano"]).optional(),
  linkedRecordId: idParam.shape.id.optional(),
}).superRefine((body, ctx) => {
  if (Boolean(body.linkedRecordType) !== Boolean(body.linkedRecordId)) {
    ctx.addIssue({ code: "custom", path: ["linkedRecordId"], message: "Informe tipo e identificador do registro vinculado." });
  }
});

async function assertLinkedRecord(tx, type, id, patientId) {
  if (!type) return;
  const model = { evolucao: "evolutions", ocorrencia: "occurrences", plano: "care_plans" }[type];
  const record = await tx[model].findFirst({ where: { id, patient_id: patientId }, select: { id: true } });
  if (!record) throw new HttpError(422, "Registro vinculado não pertence ao prontuário.");
}

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
    if (!req.file || req.file.size === 0) {
      if (req.file?.path) await unlink(req.file.path).catch(() => {});
      throw new HttpError(422, "Anexe um arquivo.");
    }
    try {
      const parsed = documentBody.safeParse(req.body);
      if (!parsed.success) throw new HttpError(422, "Metadados do documento inválidos.", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
      await patientOr404(req.params.patientId);
      const body = parsed.data;
      const row = await prisma.$transaction(async (tx) => {
        await assertLinkedRecord(tx, body.linkedRecordType, body.linkedRecordId, req.params.patientId);
        const created = await tx.documents.create({
          data: {
            patient_id: req.params.patientId,
            name: path.basename(req.file.originalname || "documento").slice(0, 180),
            type: body.type,
            author_id: req.user.id,
            status: "vigente",
            ext: path.extname(req.file.filename).slice(1),
            size_kb: Math.max(1, Math.ceil(req.file.size / 1024)),
            description: body.description ?? null,
            linked_record_type: body.linkedRecordType ?? null,
            linked_record_id: body.linkedRecordId ?? null,
            storage_path: req.file.filename,
          },
          select: { id: true, name: true, type: true, at: true, status: true, ext: true, size_kb: true, description: true, linked_record_type: true, linked_record_id: true },
        });
        await audit(tx, { userId: req.user.id, action: "anexar", entity: "documento", entityId: created.id, payload: { patientId: req.params.patientId, linkedRecordType: body.linkedRecordType ?? null, linkedRecordId: body.linkedRecordId ?? null } });
        return created;
      });
      res.status(201).json(present(row));
    } catch (error) {
      await unlink(req.file.path).catch(() => {});
      throw error;
    }
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
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.documents.update({
        where: { id: current.id },
        data: { status: "arquivado", archived_at: new Date(), archived_by_id: req.user.id },
        select: { id: true, status: true, archived_at: true },
      });
      await audit(tx, { userId: req.user.id, action: "arquivar", entity: "documento", entityId: current.id, payload: { patientId: req.params.patientId } });
      return updated;
    });
    res.json(present(row));
  }),
);

router.get("/:patientId/planos", requirePerm("plano.view"), validate(patientParams, "params"), asyncHandler(async (req, res) => {
  await patientOr404(req.params.patientId);
  const plans = await prisma.care_plans.findMany({ where: { patient_id: req.params.patientId }, orderBy: { start_date: "desc" } });
  res.json({ data: present(plans) });
}));

router.get("/:patientId/planos/:id", requirePerm("plano.view"), validate(patientParams.extend({ id: idParam.shape.id }), "params"), asyncHandler(async (req, res) => {
  const plan = await prisma.care_plans.findFirst({
    where: { id: req.params.id, patient_id: req.params.patientId },
    include: { care_plan_actions: true, care_plan_updates: { orderBy: { at: "desc" } } },
  });
  if (!plan) notFound();
  res.json(present(plan));
}));

const planBody = z.object({
  title: z.string().trim().min(3).max(160),
  area: z.string().trim().min(2).max(60),
  objective: z.string().trim().min(10).max(2000),
  responsibleId: idParam.shape.id,
  startDate: dateOnly,
  endDate: dateOnly.nullish(),
  status: z.enum(["ativo", "encerrado", "futuro"]).optional(),
  actions: z.array(z.object({
    title: z.string().trim().min(3).max(200),
    responsibleId: idParam.shape.id,
    frequency: z.string().trim().min(2).max(40),
  })).max(20).default([]),
}).strict().refine(({ startDate, endDate }) => !endDate || endDate >= startDate, { path: ["endDate"], message: "Data final anterior ao início." });

router.post(
  "/:patientId/planos",
  requirePerm("plano.create"),
  validate(patientParams, "params"),
  validate(planBody),
  asyncHandler(async (req, res) => {
    await patientOr404(req.params.patientId);
    const created = await prisma.$transaction(async (tx) => {
      const people = [...new Set([req.body.responsibleId, ...req.body.actions.map((action) => action.responsibleId)])];
      const valid = await tx.users.count({ where: { id: { in: people }, active: true } });
      if (valid !== people.length) throw new HttpError(422, "Responsável inválido ou inativo.");
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
      if (req.body.actions.length) {
        await tx.care_plan_actions.createMany({
          data: req.body.actions.map((action) => ({
            plan_id: plan.id,
            title: action.title,
            responsible_id: action.responsibleId,
            frequency: action.frequency,
          })),
        });
      }
      await audit(tx, { userId: req.user.id, action: "criar", entity: "plano_cuidado", entityId: plan.id, payload: { patientId: req.params.patientId, area: req.body.area } });
      return plan;
    });
    res.status(201).json(present(created));
  }),
);

const planRevisionBody = z.object({
  reason: z.string().trim().min(5).max(500),
  title: z.string().trim().min(3).max(160).optional(),
  area: z.string().trim().min(2).max(60).optional(),
  objective: z.string().trim().min(10).max(2000).optional(),
  responsibleId: idParam.shape.id.optional(),
  startDate: dateOnly.optional(),
  endDate: dateOnly.nullish(),
  status: z.enum(["ativo", "encerrado", "futuro"]).optional(),
}).strict().refine((body) => Object.keys(body).some((key) => key !== "reason"), { message: "Informe uma alteração." });

router.patch(
  "/:patientId/planos/:id",
  requirePerm("plano.edit"),
  validate(patientParams.extend({ id: idParam.shape.id }), "params"),
  validate(planRevisionBody),
  asyncHandler(async (req, res) => {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.care_plans.findFirst({ where: { id: req.params.id, patient_id: req.params.patientId } });
      if (!current) notFound();
      const startDate = req.body.startDate ?? present(current.start_date);
      const endDate = req.body.endDate === undefined ? present(current.end_date) : req.body.endDate;
      if (endDate && endDate < startDate) throw new HttpError(422, "Data final anterior ao início.");
      if (req.body.responsibleId) {
        const responsible = await tx.users.findFirst({ where: { id: req.body.responsibleId, active: true }, select: { id: true } });
        if (!responsible) throw new HttpError(422, "Responsável inválido ou inativo.");
      }
      const data = {};
      for (const key of ["title", "area", "objective", "status"]) if (req.body[key] !== undefined) data[key] = req.body[key];
      if (req.body.responsibleId !== undefined) data.responsible_id = req.body.responsibleId;
      if (req.body.startDate !== undefined) data.start_date = new Date(req.body.startDate);
      if (req.body.endDate !== undefined) data.end_date = req.body.endDate ? new Date(req.body.endDate) : null;
      const plan = await tx.care_plans.update({ where: { id: current.id }, data });
      await tx.care_plan_updates.create({ data: { plan_id: current.id, by_id: req.user.id, text: req.body.reason, previous_data: present(current), new_data: present(plan) } });
      await audit(tx, { userId: req.user.id, action: "revisar", entity: "plano_cuidado", entityId: current.id, payload: { patientId: req.params.patientId, fields: Object.keys(data) } });
      return plan;
    }, { isolationLevel: "Serializable" });
    res.json(present(updated));
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
    const row = await prisma.$transaction(async (tx) => {
      const update = await tx.care_plan_updates.create({
        data: { plan_id: plan.id, by_id: req.user.id, text: req.body.text },
      });
      await audit(tx, { userId: req.user.id, action: "registrar_atualizacao", entity: "plano_cuidado", entityId: plan.id, payload: { patientId: req.params.patientId } });
      return update;
    });
    res.status(201).json(present(row));
  }),
);

export default router;

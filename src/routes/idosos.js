import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { offset, pageMeta, pageSchema } from "../lib/paging.js";
import { idParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const clinicalStatus = z.enum(["estavel", "observacao", "cuidado_especial", "hospital"]);
const presenceStatus = z.enum(["leito", "atendimento", "atividade", "externo", "outro"]);
const noticeContext = z.enum(["cadastro", "prontuario", "ambos"]);
const noticeKind = z.enum(["alergia", "mobilidade", "alimentacao", "comportamento", "outro"]);
const patientIdParam = idParam;
const childIdParam = z.object({ id: idParam.shape.id, childId: idParam.shape.id });

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.").refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Data inválida.");

const locationFields = {
  wing: z.string().trim().min(2).max(60),
  room: z.string().trim().min(1).max(20),
  bed: z.string().trim().min(1).max(20),
};

const registrationFields = {
  name: z.string().trim().min(3).max(160),
  treatment: z.string().trim().min(2).max(80),
  sex: z.enum(["F", "M"]),
  birthDate: calendarDate,
  admissionDate: calendarDate,
  status: clinicalStatus,
  presenceStatus,
  presenceDetail: z.string().trim().max(160).nullish(),
  active: z.boolean(),
};

function institutionToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function checkDatesAndPresence(body, ctx) {
  const today = institutionToday();
  for (const field of ["birthDate", "admissionDate"]) {
    if (body[field] && body[field] > today) {
      ctx.addIssue({ code: "custom", path: [field], message: "A data não pode estar no futuro." });
    }
  }
  if (body.birthDate && body.admissionDate && body.admissionDate < body.birthDate) {
    ctx.addIssue({ code: "custom", path: ["admissionDate"], message: "A admissão não pode anteceder o nascimento." });
  }
  if (body.presenceStatus === "outro" && !body.presenceDetail?.trim()) {
    ctx.addIssue({ code: "custom", path: ["presenceDetail"], message: "Descreva a situação 'outro'." });
  }
}

const createBody = z.object({
  ...registrationFields,
  ...locationFields,
  status: clinicalStatus.default("estavel"),
  presenceStatus: presenceStatus.default("leito"),
  active: z.boolean().default(true),
}).superRefine(checkDatesAndPresence);

const editBody = z.object({
  name: registrationFields.name.optional(),
  treatment: registrationFields.treatment.optional(),
  sex: registrationFields.sex.optional(),
  birthDate: calendarDate.optional(),
  admissionDate: calendarDate.optional(),
  status: clinicalStatus.optional(),
  presenceStatus: presenceStatus.optional(),
  presenceDetail: registrationFields.presenceDetail,
  active: z.boolean().optional(),
}).refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.").superRefine(checkDatesAndPresence);

const contactBody = z.object({
  name: z.string().trim().min(2).max(120),
  relation: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(7).max(30),
  priority: z.number().int().min(1).max(99).optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullish(),
});

const noticeBody = z.object({
  label: z.string().trim().min(2).max(160),
  kind: noticeKind,
  detail: z.string().trim().max(1000).nullish(),
  context: noticeContext.default("ambos"),
  active: z.boolean().default(true),
});

async function patientOr404(tx, id) {
  const patient = await tx.patients.findUnique({ where: { id } });
  if (!patient) notFound("Idoso não encontrado.");
  return patient;
}

async function assertAvailableBed(tx, location, excludePatientId, requireUnoccupied = true) {
  const room = await tx.rooms.findUnique({
    where: { wing_number: { wing: location.wing, number: location.room } },
    include: { beds: { where: { label: location.bed } } },
  });
  if (!room?.active || !room.beds[0]?.active) {
    throw new HttpError(422, "Quarto ou leito inexistente ou inativo.");
  }
  if (!requireUnoccupied) return;
  const occupied = await tx.patients.findFirst({
    where: {
      wing: location.wing, room: location.room, bed: location.bed, active: true,
      ...(excludePatientId ? { id: { not: excludePatientId } } : {}),
    },
    select: { id: true },
  });
  if (occupied) throw new HttpError(409, "Leito já ocupado por outro idoso ativo.");
}

function patientWhere(query) {
  const { q, status, presenceStatus: presence, active, wing, room, bed } = query;
  return {
    ...(status ? { status } : {}),
    ...(presence ? { presence_status: presence } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(wing ? { wing } : {}),
    ...(room ? { room } : {}),
    ...(bed ? { bed } : {}),
    ...(q ? {
      OR: ["name", "treatment", "code", "room"].map((field) => ({
        [field]: { contains: q, mode: "insensitive" },
      })),
    } : {}),
  };
}

router.use(requireAuth);

router.get(
  "/",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(pageSchema.extend({
    q: z.string().trim().max(80).optional(),
    status: clinicalStatus.optional(),
    presenceStatus: presenceStatus.optional(),
    active: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
    wing: z.string().trim().max(60).optional(),
    room: z.string().trim().max(20).optional(),
    bed: z.string().trim().max(20).optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const where = patientWhere(req.query);
    const [total, rows] = await Promise.all([
      prisma.patients.count({ where }),
      prisma.patients.findMany({ where, orderBy: { name: "asc" }, skip: offset(page, limit), take: limit }),
    ]);
    res.json({ data: present(rows), meta: pageMeta(page, limit, total) });
  }),
);

router.post(
  "/",
  requirePerm("cadastro.idosos.manage"),
  validate(createBody),
  asyncHandler(async (req, res) => {
    const body = req.body;
    if (body.status !== "estavel" && !req.user.permissions.includes("dados.edit")) {
      throw new HttpError(403, "Sem permissão para definir a situação clínica.");
    }
    const id = randomUUID();
    const code = `LIV-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await prisma.$transaction(async (tx) => {
      await assertAvailableBed(tx, body, undefined, body.active);
      const row = await tx.patients.create({
        data: {
          id, code,
          name: body.name, treatment: body.treatment, sex: body.sex,
          birth_date: new Date(`${body.birthDate}T00:00:00.000Z`),
          admission_date: new Date(`${body.admissionDate}T00:00:00.000Z`),
          wing: body.wing, room: body.room, bed: body.bed,
          status: body.status, active: body.active,
          presence_status: body.presenceStatus,
          presence_detail: body.presenceDetail ?? null,
        },
      });
      await tx.patient_location_history.create({
        data: { patient_id: id, by_id: req.user.id, wing: body.wing, room: body.room, bed: body.bed, reason: "Localização inicial do cadastro" },
      });
      await audit(tx, { userId: req.user.id, action: "criar", entity: "idoso", entityId: id, payload: { code } });
      return row;
    });
    res.status(201).json(present(created));
  }),
);

router.get(
  "/:id",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(patientIdParam, "params"),
  asyncHandler(async (req, res) => {
    const row = await prisma.patients.findUnique({
      where: { id: req.params.id },
      include: {
        patient_contacts: { orderBy: [{ priority: "asc" }, { name: "asc" }] },
        patient_alerts: { where: { active: true, context: { in: ["cadastro", "ambos"] } }, orderBy: { label: "asc" } },
      },
    });
    if (!row) notFound("Idoso não encontrado.");
    const { patient_contacts, patient_alerts, ...patient } = row;
    res.json({ ...present(patient), contacts: present(patient_contacts), alerts: present(patient_alerts) });
  }),
);

router.get(
  "/:id/resumo",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(patientIdParam, "params"),
  asyncHandler(async (req, res) => {
    const row = await prisma.patients.findUnique({
      where: { id: req.params.id },
      include: {
        patient_contacts: { orderBy: [{ priority: "asc" }, { name: "asc" }] },
        patient_alerts: { where: { active: true, context: { in: ["cadastro", "ambos"] } } },
      },
    });
    if (!row) notFound("Idoso não encontrado.");
    res.json({
      id: row.id, code: row.code, name: row.name, treatment: row.treatment,
      birthDate: present(row.birth_date), active: row.active, status: row.status,
      presenceStatus: row.presence_status, presenceDetail: row.presence_detail,
      location: { wing: row.wing, room: row.room, bed: row.bed },
      contacts: present(row.patient_contacts), alerts: present(row.patient_alerts),
    });
  }),
);

router.patch(
  "/:id",
  requirePerm("cadastro.idosos.manage"),
  validate(patientIdParam, "params"),
  validate(editBody),
  asyncHandler(async (req, res) => {
    if (req.body.status !== undefined && !req.user.permissions.includes("dados.edit")) {
      throw new HttpError(403, "Sem permissão para alterar a situação clínica.");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const current = await patientOr404(tx, req.params.id);
      const body = req.body;
      const birthDate = body.birthDate ?? present(current.birth_date);
      const admissionDate = body.admissionDate ?? present(current.admission_date);
      if (admissionDate < birthDate) throw new HttpError(422, "A admissão não pode anteceder o nascimento.");
      if (birthDate > institutionToday() || admissionDate > institutionToday()) {
        throw new HttpError(422, "Nascimento e admissão não podem estar no futuro.");
      }
      const nextPresence = body.presenceStatus ?? current.presence_status;
      const nextDetail = body.presenceDetail !== undefined
        ? body.presenceDetail
        : body.presenceStatus !== undefined && body.presenceStatus !== current.presence_status
          ? null
          : current.presence_detail;
      if (nextPresence === "outro" && !nextDetail?.trim()) {
        throw new HttpError(422, "Descreva a situação 'outro'.");
      }
      if (body.active === true && !current.active) await assertAvailableBed(tx, current, current.id);
      const data = { updated_at: new Date() };
      const mapping = {
        name: "name", treatment: "treatment", sex: "sex", status: "status",
        presenceStatus: "presence_status", presenceDetail: "presence_detail", active: "active",
      };
      for (const [field, column] of Object.entries(mapping)) {
        if (body[field] !== undefined) data[column] = body[field];
      }
      if (body.presenceStatus !== undefined && body.presenceDetail === undefined) data.presence_detail = nextDetail;
      if (body.birthDate) data.birth_date = new Date(`${body.birthDate}T00:00:00.000Z`);
      if (body.admissionDate) data.admission_date = new Date(`${body.admissionDate}T00:00:00.000Z`);
      const before = {};
      const after = {};
      for (const [column, value] of Object.entries(data)) {
        if (column === "updated_at") continue;
        const oldValue = present(current[column]);
        const newValue = present(value);
        if (oldValue !== newValue) { before[column] = oldValue; after[column] = newValue; }
      }
      const row = await tx.patients.update({ where: { id: current.id }, data });
      if (Object.keys(after).length) {
        await audit(tx, { userId: req.user.id, action: "atualizar", entity: "idoso", entityId: current.id, payload: { before, after } });
      }
      return row;
    });
    res.json(present(updated));
  }),
);

router.get(
  "/:id/historico",
  requirePerm("cadastro.idosos.manage"),
  validate(patientIdParam, "params"),
  asyncHandler(async (req, res) => {
    await patientOr404(prisma, req.params.id);
    const rows = await prisma.audit_log.findMany({
      where: { entity: "idoso", entity_id: req.params.id },
      orderBy: { at: "desc" },
    });
    res.json({ data: present(rows) });
  }),
);

router.get(
  "/:id/transferencias",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(patientIdParam, "params"),
  asyncHandler(async (req, res) => {
    const patient = await patientOr404(prisma, req.params.id);
    const rows = await prisma.patient_location_history.findMany({
      where: { patient_id: patient.id }, orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    res.json({ current: { wing: patient.wing, room: patient.room, bed: patient.bed }, data: present(rows) });
  }),
);

router.post(
  "/:id/transferencias",
  requirePerm("cadastro.idosos.manage"),
  validate(patientIdParam, "params"),
  validate(z.object({ ...locationFields, reason: z.string().trim().min(5).max(500) })),
  asyncHandler(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      const patient = await patientOr404(tx, req.params.id);
      if (!patient.active) throw new HttpError(422, "Ative o cadastro antes da transferência.");
      const { wing, room, bed, reason } = req.body;
      if (wing === patient.wing && room === patient.room && bed === patient.bed) {
        throw new HttpError(409, "O idoso já está neste leito.");
      }
      await assertAvailableBed(tx, req.body, patient.id);
      const updated = await tx.patients.update({
        where: { id: patient.id }, data: { wing, room, bed, updated_at: new Date() },
      });
      const history = await tx.patient_location_history.create({
        data: { patient_id: patient.id, by_id: req.user.id, wing, room, bed, reason },
      });
      await audit(tx, {
        userId: req.user.id, action: "transferir", entity: "idoso", entityId: patient.id,
        payload: { from: { wing: patient.wing, room: patient.room, bed: patient.bed }, to: { wing, room, bed }, reason },
      });
      return { patient: present(updated), transfer: present(history) };
    });
    res.status(201).json(result);
  }),
);

router.get(
  "/:id/contatos",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(patientIdParam, "params"),
  asyncHandler(async (req, res) => {
    await patientOr404(prisma, req.params.id);
    const rows = await prisma.patient_contacts.findMany({
      where: { patient_id: req.params.id }, orderBy: [{ priority: "asc" }, { name: "asc" }],
    });
    res.json({ data: present(rows) });
  }),
);

router.post(
  "/:id/contatos",
  requirePerm("cadastro.idosos.manage"),
  validate(patientIdParam, "params"),
  validate(contactBody),
  asyncHandler(async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      await patientOr404(tx, req.params.id);
      const existing = await tx.patient_contacts.findMany({ where: { patient_id: req.params.id } });
      const isPrimary = req.body.isPrimary ?? existing.length === 0;
      if (isPrimary) await tx.patient_contacts.updateMany({ where: { patient_id: req.params.id }, data: { is_primary: false } });
      const priority = req.body.priority ?? Math.min(99, Math.max(0, ...existing.map((item) => item.priority)) + 1);
      const row = await tx.patient_contacts.create({
        data: {
          patient_id: req.params.id, name: req.body.name, relation: req.body.relation,
          phone: req.body.phone, priority, is_primary: isPrimary, notes: req.body.notes ?? null,
        },
      });
      await audit(tx, { userId: req.user.id, action: "criar_contato", entity: "idoso", entityId: req.params.id, payload: { contactId: row.id } });
      return row;
    });
    res.status(201).json(present(created));
  }),
);

router.patch(
  "/:id/contatos/:childId",
  requirePerm("cadastro.idosos.manage"),
  validate(childIdParam, "params"),
  validate(contactBody.partial().refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.")),
  asyncHandler(async (req, res) => {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.patient_contacts.findFirst({ where: { id: req.params.childId, patient_id: req.params.id } });
      if (!current) notFound("Contato não encontrado.");
      if (req.body.isPrimary === true) {
        await tx.patient_contacts.updateMany({ where: { patient_id: req.params.id }, data: { is_primary: false } });
      }
      const data = {};
      for (const [field, column] of Object.entries({ name: "name", relation: "relation", phone: "phone", priority: "priority", isPrimary: "is_primary", notes: "notes" })) {
        if (req.body[field] !== undefined) data[column] = req.body[field];
      }
      const row = await tx.patient_contacts.update({ where: { id: current.id }, data });
      await audit(tx, { userId: req.user.id, action: "atualizar_contato", entity: "idoso", entityId: req.params.id, payload: { contactId: row.id } });
      return row;
    });
    res.json(present(updated));
  }),
);

router.delete(
  "/:id/contatos/:childId",
  requirePerm("cadastro.idosos.manage"),
  validate(childIdParam, "params"),
  asyncHandler(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const current = await tx.patient_contacts.findFirst({ where: { id: req.params.childId, patient_id: req.params.id } });
      if (!current) notFound("Contato não encontrado.");
      await tx.patient_contacts.delete({ where: { id: current.id } });
      await audit(tx, { userId: req.user.id, action: "excluir_contato", entity: "idoso", entityId: req.params.id, payload: { contactId: current.id } });
    });
    res.status(204).end();
  }),
);

router.get(
  "/:id/avisos",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(patientIdParam, "params"),
  validate(z.object({ context: noticeContext.optional(), includeInactive: z.enum(["true", "false"]).transform((value) => value === "true").optional() }), "query"),
  asyncHandler(async (req, res) => {
    await patientOr404(prisma, req.params.id);
    const canViewChart = req.user.permissions.includes("prontuario.view");
    if (req.query.context === "prontuario" && !canViewChart) {
      throw new HttpError(403, "Sem acesso aos avisos do prontuário.");
    }
    if (req.query.includeInactive && !req.user.permissions.includes("avisos.manage")) {
      throw new HttpError(403, "Sem acesso aos avisos inativos.");
    }
    const contexts = req.query.context
      ? [req.query.context, "ambos"]
      : canViewChart ? ["cadastro", "prontuario", "ambos"] : ["cadastro", "ambos"];
    const rows = await prisma.patient_alerts.findMany({
      where: {
        patient_id: req.params.id,
        ...(!req.query.includeInactive ? { active: true } : {}),
        context: { in: contexts },
      },
      orderBy: { label: "asc" },
    });
    res.json({ data: present(rows) });
  }),
);

router.post(
  "/:id/avisos",
  requirePerm("avisos.manage"),
  validate(patientIdParam, "params"),
  validate(noticeBody),
  asyncHandler(async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      await patientOr404(tx, req.params.id);
      const row = await tx.patient_alerts.create({
        data: {
          id: randomUUID(), patient_id: req.params.id, label: req.body.label,
          kind: req.body.kind, detail: req.body.detail ?? null,
          context: req.body.context, active: req.body.active,
        },
      });
      await audit(tx, { userId: req.user.id, action: "criar_aviso", entity: "idoso", entityId: req.params.id, payload: { noticeId: row.id } });
      return row;
    });
    res.status(201).json(present(created));
  }),
);

router.patch(
  "/:id/avisos/:childId",
  requirePerm("avisos.manage"),
  validate(childIdParam, "params"),
  validate(noticeBody.partial().refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.")),
  asyncHandler(async (req, res) => {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.patient_alerts.findFirst({ where: { id: req.params.childId, patient_id: req.params.id } });
      if (!current) notFound("Aviso não encontrado.");
      const row = await tx.patient_alerts.update({ where: { id: current.id }, data: req.body });
      await audit(tx, { userId: req.user.id, action: "atualizar_aviso", entity: "idoso", entityId: req.params.id, payload: { noticeId: row.id } });
      return row;
    });
    res.json(present(updated));
  }),
);

router.delete(
  "/:id/avisos/:childId",
  requirePerm("avisos.manage"),
  validate(childIdParam, "params"),
  asyncHandler(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const current = await tx.patient_alerts.findFirst({ where: { id: req.params.childId, patient_id: req.params.id } });
      if (!current) notFound("Aviso não encontrado.");
      await tx.patient_alerts.update({ where: { id: current.id }, data: { active: false } });
      await audit(tx, { userId: req.user.id, action: "inativar_aviso", entity: "idoso", entityId: req.params.id, payload: { noticeId: current.id } });
    });
    res.status(204).end();
  }),
);

export default router;

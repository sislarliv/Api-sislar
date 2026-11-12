import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { idParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth);
const id = idParam.shape.id;
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const valuesField = z.record(z.string().trim().max(2000));

function calendarDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(422, "Data inválida.");
  }
  return parsed;
}

async function requireActiveUsers(tx, ids) {
  const distinct = [...new Set(ids)];
  const users = await tx.users.findMany({ where: { id: { in: distinct }, active: true }, select: { id: true } });
  if (users.length !== distinct.length) throw new HttpError(422, "Responsável inexistente ou inativo.");
}

async function requireTemplateResponsibles(tx, templateId, ids) {
  const allowed = await tx.pae_template_responsibles.findMany({
    where: { template_id: templateId }, select: { user_id: true },
  });
  const allowedIds = new Set(allowed.map((item) => item.user_id));
  if (ids.some((userId) => !allowedIds.has(userId))) {
    throw new HttpError(422, "Responsável fora da lista do modelo do PAE.");
  }
}

function checkValues(fields, values) {
  const known = new Set(fields.map((field) => field.id));
  for (const fieldId of Object.keys(values)) {
    if (!known.has(fieldId)) throw new HttpError(422, "Campo não pertence ao modelo do PAE.");
  }
  for (const field of fields) {
    const value = values[field.id];
    if (field.required && !value) throw new HttpError(422, `Preencha o campo ${field.label}.`);
    if (!value) continue;
    if (field.field_type === "selecao" && !field.options.includes(value)) throw new HttpError(422, `Opção inválida em ${field.label}.`);
    if (field.field_type === "sim_nao" && !["sim", "nao"].includes(value)) throw new HttpError(422, `Use sim ou nao em ${field.label}.`);
    if (field.field_type === "numero" && !Number.isFinite(Number(value))) throw new HttpError(422, `Número inválido em ${field.label}.`);
    if (field.field_type === "data") calendarDate(value);
  }
}

async function paeSnapshot(tx, paeId) {
  const row = await tx.paes.findUnique({
    where: { id: paeId },
    include: {
      pae_values: { orderBy: { field_id: "asc" } },
      pae_actions: { orderBy: { id: "asc" } },
    },
  });
  return present({
    id: row.id,
    patient_id: row.patient_id,
    template_id: row.template_id,
    status: row.status,
    start_date: row.start_date,
    review_date: row.review_date,
    responsible_id: row.responsible_id,
    version: row.version,
    values: row.pae_values.map(({ field_id, value }) => ({ field_id, value })),
    actions: row.pae_actions.map(({ id: actionId, template_action_id, title, responsible_id, due_date, status, done_at, done_by, notes }) => ({
      id: actionId, template_action_id, title, responsible_id, due_date, status, done_at, done_by, notes,
    })),
  });
}

async function templateDetail(id) {
  const template = await prisma.pae_templates.findUnique({
    where: { id },
    include: {
      pae_template_fields: { orderBy: { sort_order: "asc" } },
      pae_template_actions: { orderBy: { sort_order: "asc" } },
      pae_template_responsibles: true,
    },
  });
  if (!template) notFound("Modelo não encontrado.");
  return present({
    ...template,
    fields: template.pae_template_fields,
    actions: template.pae_template_actions,
    responsibleIds: template.pae_template_responsibles.map((item) => item.user_id),
  });
}

router.get("/modelos", requirePerm("pae.template.view"), asyncHandler(async (_req, res) => {
  const rows = await prisma.pae_templates.findMany({ orderBy: { name: "asc" } });
  res.json({ data: present(rows) });
}));

router.get("/modelos/:id", requirePerm("pae.template.view"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  res.json(await templateDetail(req.params.id));
}));

router.post(
  "/modelos",
  requirePerm("pae.template.manage"),
  validate(z.object({
    name: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(2000),
    status: z.enum(["vigente", "arquivado"]).optional(),
    responsibleIds: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).min(1),
    fields: z.array(z.object({
      label: z.string().trim().min(2).max(160),
      fieldType: z.enum(["texto", "texto_longo", "selecao", "sim_nao", "numero", "data"]),
      required: z.boolean().optional(),
      options: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    })).min(1).max(30),
    actions: z.array(z.object({
      title: z.string().trim().min(3).max(200),
      roleLabel: z.string().trim().min(2).max(80),
    })).min(1).max(30),
  })),
  asyncHandler(async (req, res) => {
    for (const field of req.body.fields) {
      if (field.fieldType === "selecao" && !field.options?.length) throw new HttpError(422, "Campo de seleção precisa de opções.");
    }
    const created = await prisma.$transaction(async (tx) => {
      if (new Set(req.body.responsibleIds).size !== req.body.responsibleIds.length) {
        throw new HttpError(422, "Responsáveis repetidos no modelo.");
      }
      await requireActiveUsers(tx, req.body.responsibleIds);
      const row = await tx.pae_templates.create({
        data: {
          name: req.body.name,
          description: req.body.description,
          version: 1,
          status: req.body.status ?? "vigente",
          pae_template_responsibles: { create: req.body.responsibleIds.map((user_id) => ({ user_id })) },
          pae_template_fields: {
            create: req.body.fields.map((field, index) => ({
              label: field.label,
              field_type: field.fieldType,
              required: field.required ?? false,
              options: field.options ?? [],
              sort_order: index,
            })),
          },
          pae_template_actions: {
            create: req.body.actions.map((action, index) => ({
              title: action.title,
              role_label: action.roleLabel,
              sort_order: index,
            })),
          },
        },
      });
      await audit(tx, { userId: req.user.id, action: "criar", entity: "modelo_pae", entityId: row.id,
        payload: { name: row.name, version: row.version } });
      return row;
    });
    res.status(201).json(await templateDetail(created.id));
  }),
);

router.patch("/modelos/:id/status", requirePerm("pae.template.manage"), validate(idParam, "params"), validate(z.object({
  status: z.enum(["vigente", "arquivado"]),
})), asyncHandler(async (req, res) => {
  const current = await prisma.pae_templates.findUnique({ where: { id: req.params.id } });
  if (!current) notFound("Modelo não encontrado.");
  await prisma.$transaction(async (tx) => {
    await tx.pae_templates.update({ where: { id: current.id }, data: { status: req.body.status, updated_at: new Date() } });
    await audit(tx, { userId: req.user.id, action: "alterar_status", entity: "modelo_pae", entityId: current.id,
      payload: { previous: current.status, current: req.body.status } });
  });
  res.json(await templateDetail(current.id));
}));

router.get(
  "/pendencias",
  requirePerm("pae.view"),
  validate(z.object({
    patientId: id.optional(),
    responsibleId: id.optional(),
    dueFrom: dateField.optional(),
    dueUntil: dateField.optional(),
    status: z.enum(["pendente", "executada", "cancelada", "todos"]).default("pendente"),
    paeStatus: z.enum(["vigente", "em_revisao", "encerrado"]).optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { patientId, responsibleId, dueFrom, dueUntil, status, paeStatus } = req.query;
    if (dueFrom) calendarDate(dueFrom);
    if (dueUntil) calendarDate(dueUntil);
    if (dueFrom && dueUntil && dueUntil < dueFrom) throw new HttpError(422, "O prazo final precisa ser igual ou posterior ao inicial.");
    const rows = await prisma.pae_actions.findMany({
      where: {
        ...(status !== "todos" && { status }),
        ...(responsibleId && { responsible_id: responsibleId }),
        ...((dueFrom || dueUntil) && { due_date: {
          ...(dueFrom && { gte: calendarDate(dueFrom) }),
          ...(dueUntil && { lte: calendarDate(dueUntil) }),
        } }),
        ...((patientId || paeStatus || status === "pendente") && { paes: {
          ...(patientId && { patient_id: patientId }),
          ...(paeStatus && { status: paeStatus }),
          ...(status === "pendente" && !paeStatus && { status: { not: "encerrado" } }),
        } }),
      },
      include: {
        paes: { select: { id: true, patient_id: true, status: true, version: true, patients: { select: { name: true } } } },
        users: { select: { name: true } },
      },
      orderBy: [{ due_date: "asc" }, { id: "asc" }],
    });
    res.json({
      data: rows.map((row) => present({
        id: row.id,
        pae_id: row.pae_id,
        patient_id: row.paes.patient_id,
        patient_name: row.paes.patients.name,
        pae_status: row.paes.status,
        pae_version: row.paes.version,
        title: row.title,
        responsible_id: row.responsible_id,
        responsible_name: row.users?.name ?? null,
        due_date: row.due_date,
        status: row.status,
        done_at: row.done_at,
        done_by: row.done_by,
        notes: row.notes,
      })),
      meta: { total: rows.length },
    });
  }),
);

router.get("/", requirePerm("pae.view"), asyncHandler(async (req, res) => {
  const rows = await prisma.paes.findMany({
    where: typeof req.query.patientId === "string" ? { patient_id: req.query.patientId } : undefined,
    include: {
      pae_templates: { select: { name: true } },
      users_paes_responsible_idTousers: { select: { name: true } },
    },
    orderBy: { review_date: "asc" },
  });
  res.json({
    data: rows.map((row) => present({
      ...row,
      template_name: row.pae_templates.name,
      responsible_name: row.users_paes_responsible_idTousers.name,
    })),
  });
}));

router.get("/:id", requirePerm("pae.view"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const pae = await prisma.paes.findUnique({
    where: { id: req.params.id },
    include: {
      pae_templates: { select: { name: true } },
      pae_values: { include: { pae_template_fields: true } },
      pae_actions: { orderBy: { due_date: "asc" } },
    },
  });
  if (!pae) notFound();
  res.json(present({
    ...pae,
    template_name: pae.pae_templates.name,
    values: pae.pae_values.map((item) => ({
      field_id: item.field_id,
      value: item.value,
      label: item.pae_template_fields.label,
      field_type: item.pae_template_fields.field_type,
      required: item.pae_template_fields.required,
    })),
  }));
}));

router.post(
  "/",
  requirePerm("pae.create"),
  validate(z.object({
    patientId: id,
    templateId: id,
    responsibleId: id,
    startDate: dateField,
    reviewDate: dateField.optional(),
    values: valuesField,
    actions: z.array(z.object({
      templateActionId: id,
      responsibleId: id.optional(),
      dueDate: dateField.optional(),
    })).max(30).optional(),
  })),
  asyncHandler(async (req, res) => {
    const pae = await prisma.$transaction(async (tx) => {
      const template = await tx.pae_templates.findFirst({ where: { id: req.body.templateId, status: "vigente" } });
      if (!template) notFound("Modelo não encontrado.");
      const patient = await tx.patients.findUnique({ where: { id: req.body.patientId } });
      if (!patient) notFound("Prontuário não encontrado.");
      const startDate = calendarDate(req.body.startDate);
      const reviewDate = req.body.reviewDate ? calendarDate(req.body.reviewDate) : null;
      if (reviewDate && reviewDate < startDate) throw new HttpError(422, "A revisão precisa ocorrer na data de início ou depois.");
      const fields = await tx.pae_template_fields.findMany({ where: { template_id: template.id } });
      checkValues(fields, req.body.values);
      const actions = await tx.pae_template_actions.findMany({ where: { template_id: template.id }, orderBy: { sort_order: "asc" } });
      const assignments = new Map();
      for (const assignment of req.body.actions ?? []) {
        if (assignments.has(assignment.templateActionId)) throw new HttpError(422, "Ação informada mais de uma vez.");
        assignments.set(assignment.templateActionId, assignment);
      }
      if ([...assignments.keys()].some((actionId) => !actions.some((action) => action.id === actionId))) {
        throw new HttpError(422, "Ação não pertence ao modelo do PAE.");
      }
      const scheduled = actions.map((action) => {
        const assignment = assignments.get(action.id);
        const responsibleId = assignment?.responsibleId ?? req.body.responsibleId;
        const dueDate = assignment?.dueDate ?? req.body.reviewDate;
        if (!dueDate) throw new HttpError(422, `Informe o prazo da ação ${action.title}.`);
        if (calendarDate(dueDate) < startDate) throw new HttpError(422, "O prazo da ação precisa ser igual ou posterior ao início do PAE.");
        return { action, responsibleId, dueDate: calendarDate(dueDate) };
      });
      await requireActiveUsers(tx, [req.body.responsibleId, ...scheduled.map((item) => item.responsibleId)]);
      await requireTemplateResponsibles(tx, template.id,
        [req.body.responsibleId, ...scheduled.map((item) => item.responsibleId)]);
      const created = await tx.paes.create({
        data: {
          patient_id: req.body.patientId,
          template_id: template.id,
          status: "vigente",
          start_date: startDate,
          review_date: reviewDate,
          responsible_id: req.body.responsibleId,
          created_by: req.user.id,
        },
      });
      const values = fields.filter((field) => req.body.values[field.id]).map((field) => ({
        pae_id: created.id,
        field_id: field.id,
        value: req.body.values[field.id],
      }));
      if (values.length) await tx.pae_values.createMany({ data: values });
      if (scheduled.length) {
        await tx.pae_actions.createMany({
          data: scheduled.map(({ action, responsibleId, dueDate }) => ({
            pae_id: created.id,
            template_action_id: action.id,
            title: action.title,
            responsible_id: responsibleId,
            due_date: dueDate,
            status: "pendente",
          })),
        });
      }
      await tx.pae_versions.create({
        data: { pae_id: created.id, version: 1, by_id: req.user.id, summary: "Criação do PAE.", snapshot: await paeSnapshot(tx, created.id) },
      });
      await audit(tx, { userId: req.user.id, action: "criar", entity: "pae", entityId: created.id,
        payload: { patientId: req.body.patientId, templateId: template.id, version: 1 } });
      return created;
    });
    res.status(201).json(present(pae));
  }),
);

router.get("/:id/versoes", requirePerm("pae.view"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const pae = await prisma.paes.findUnique({ where: { id: req.params.id }, select: { id: true, version: true, created_by: true } });
  if (!pae) notFound();
  const versions = await prisma.pae_versions.findMany({ where: { pae_id: pae.id }, orderBy: { version: "desc" } });
  const data = versions.map(({ version, at, by_id, summary }) => present({ version, at, by_id, summary, current: version === pae.version }));
  if (!versions.some((row) => row.version === pae.version)) {
    data.unshift({ version: pae.version, at: null, byId: pae.created_by, summary: "Versão atual.", current: true });
  }
  res.json({ data, currentVersion: pae.version });
}));

router.get(
  "/:id/versoes/:version",
  requirePerm("pae.view"),
  validate(z.object({ id, version: z.coerce.number().int().min(1) }), "params"),
  asyncHandler(async (req, res) => {
    const pae = await prisma.paes.findUnique({ where: { id: req.params.id }, select: { version: true } });
    if (!pae) notFound();
    const row = await prisma.pae_versions.findUnique({
      where: { pae_id_version: { pae_id: req.params.id, version: req.params.version } },
    });
    if (!row && req.params.version !== pae.version) notFound("Versão não encontrada.");
    const snapshot = req.params.version === pae.version ? await paeSnapshot(prisma, req.params.id) : row.snapshot;
    res.json({ version: req.params.version, current: req.params.version === pae.version, at: row?.at ?? null, snapshot });
  }),
);

router.post(
  "/:id/acoes/:actionId/executar",
  requirePerm("pae.execute"),
  validate(z.object({ id: idParam.shape.id, actionId: idParam.shape.id }), "params"),
  validate(z.object({ notes: z.string().trim().max(2000).optional() })),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const pae = await tx.paes.findUnique({ where: { id: req.params.id }, select: { status: true } });
      if (!pae) notFound();
      if (pae.status === "encerrado") throw new HttpError(409, "PAE encerrado não aceita execução de ações.");
      const updated = await tx.pae_actions.updateMany({
        where: { id: req.params.actionId, pae_id: req.params.id, status: "pendente" },
        data: { status: "executada", done_at: new Date(), done_by: req.user.id, notes: req.body.notes ?? null },
      });
      if (updated.count !== 1) throw new HttpError(409, "Ação inexistente ou já executada.");
      await audit(tx, { userId: req.user.id, action: "executar", entity: "acao_pae", entityId: req.params.actionId,
        payload: { paeId: req.params.id } });
      return tx.pae_actions.findUnique({ where: { id: req.params.actionId } });
    }, { isolationLevel: "Serializable" });
    res.json(present(row));
  }),
);

router.post(
  "/:id/revisar",
  requirePerm("pae.review"),
  validate(idParam, "params"),
  validate(z.object({
    reviewDate: dateField,
    responsibleId: id.optional(),
    status: z.enum(["vigente", "em_revisao", "encerrado"]).optional(),
    values: valuesField.optional(),
    actions: z.array(z.object({
      id,
      title: z.string().trim().min(3).max(200).optional(),
      responsibleId: id.optional(),
      dueDate: dateField.optional(),
      status: z.enum(["pendente", "cancelada"]).optional(),
    })).max(50).optional(),
    summary: z.string().trim().min(3).max(300).optional(),
  })),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.paes.findUnique({
        where: { id: req.params.id },
        include: { pae_values: true, pae_actions: true },
      });
      if (!current) notFound();
      if (current.status === "encerrado") throw new HttpError(409, "PAE encerrado não pode ser revisado.");
      const reviewDate = calendarDate(req.body.reviewDate);
      if (reviewDate < current.start_date) throw new HttpError(422, "A revisão precisa ocorrer na data de início ou depois.");
      if (req.body.responsibleId) await requireActiveUsers(tx, [req.body.responsibleId]);
      await requireTemplateResponsibles(tx, current.template_id, [
        ...(req.body.responsibleId ? [req.body.responsibleId] : []),
        ...(req.body.actions ?? []).flatMap((action) => action.responsibleId ? [action.responsibleId] : []),
      ]);
      if (req.body.values) {
        const fields = await tx.pae_template_fields.findMany({ where: { template_id: current.template_id } });
        const merged = Object.fromEntries(current.pae_values.map((item) => [item.field_id, item.value]));
        Object.assign(merged, req.body.values);
        checkValues(fields, merged);
      }
      const knownActions = new Map(current.pae_actions.map((action) => [action.id, action]));
      const seenActions = new Set();
      for (const action of req.body.actions ?? []) {
        if (seenActions.has(action.id)) throw new HttpError(422, "Ação informada mais de uma vez.");
        seenActions.add(action.id);
        const existing = knownActions.get(action.id);
        if (!existing) throw new HttpError(422, "Ação não pertence ao PAE.");
        if (existing.status === "executada") throw new HttpError(409, "Ação executada não pode ser alterada.");
        if (action.dueDate && calendarDate(action.dueDate) < current.start_date) {
          throw new HttpError(422, "O prazo da ação precisa ser igual ou posterior ao início do PAE.");
        }
      }
      await requireActiveUsers(tx, (req.body.actions ?? []).flatMap((action) => action.responsibleId ? [action.responsibleId] : []));
      const previousSnapshot = await paeSnapshot(tx, current.id);
      await tx.pae_versions.upsert({
        where: { pae_id_version: { pae_id: current.id, version: current.version } },
        update: { snapshot: previousSnapshot },
        create: {
          pae_id: current.id,
          version: current.version,
          by_id: req.user.id,
          summary: "Versão anterior à revisão.",
          snapshot: previousSnapshot,
        },
      });
      const changed = await tx.paes.updateMany({
        where: { id: current.id, version: current.version },
        data: {
          review_date: reviewDate,
          responsible_id: req.body.responsibleId ?? current.responsible_id,
          status: req.body.status ?? "vigente",
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new HttpError(409, "O PAE foi revisado por outra pessoa. Recarregue e tente novamente.");
      for (const [fieldId, value] of Object.entries(req.body.values ?? {})) {
        if (value) {
          await tx.pae_values.upsert({
            where: { pae_id_field_id: { pae_id: current.id, field_id: fieldId } },
            update: { value },
            create: { pae_id: current.id, field_id: fieldId, value },
          });
        } else {
          await tx.pae_values.deleteMany({ where: { pae_id: current.id, field_id: fieldId } });
        }
      }
      for (const action of req.body.actions ?? []) {
        await tx.pae_actions.update({
          where: { id: action.id },
          data: {
            ...(action.title && { title: action.title }),
            ...(action.responsibleId && { responsible_id: action.responsibleId }),
            ...(action.dueDate && { due_date: calendarDate(action.dueDate) }),
            ...(action.status && { status: action.status }),
          },
        });
      }
      const updated = await tx.paes.findUnique({ where: { id: current.id } });
      await tx.pae_versions.create({
        data: {
          pae_id: current.id,
          version: updated.version,
          by_id: req.user.id,
          summary: req.body.summary ?? "Revisão do PAE.",
          snapshot: await paeSnapshot(tx, current.id),
        },
      });
      await audit(tx, { userId: req.user.id, action: "revisar", entity: "pae", entityId: current.id,
        payload: { previousVersion: current.version, version: updated.version, summary: req.body.summary ?? null } });
      return updated;
    }, { isolationLevel: "Serializable" });
    res.json(present(row));
  }),
);

export default router;

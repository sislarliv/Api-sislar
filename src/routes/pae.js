import { Router } from "express";
import { z } from "zod";
import { notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { idParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth);

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
    const created = await prisma.pae_templates.create({
      data: {
        name: req.body.name,
        description: req.body.description,
        version: 1,
        status: "vigente",
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
    res.status(201).json(await templateDetail(created.id));
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
    patientId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    templateId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    responsibleId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    values: z.record(z.string().trim().max(2000)),
  })),
  asyncHandler(async (req, res) => {
    const pae = await prisma.$transaction(async (tx) => {
      const template = await tx.pae_templates.findFirst({ where: { id: req.body.templateId, status: "vigente" } });
      if (!template) notFound("Modelo não encontrado.");
      const patient = await tx.patients.findUnique({ where: { id: req.body.patientId } });
      if (!patient) notFound("Prontuário não encontrado.");
      const fields = await tx.pae_template_fields.findMany({ where: { template_id: template.id } });
      for (const field of fields) {
        const value = req.body.values[field.id];
        if (field.required && !value) throw new HttpError(422, `Preencha o campo ${field.label}.`);
        if (field.field_type === "selecao" && value && !field.options.includes(value)) throw new HttpError(422, `Opção inválida em ${field.label}.`);
        if (field.field_type === "sim_nao" && value && !["sim", "nao"].includes(value)) throw new HttpError(422, `Use sim ou nao em ${field.label}.`);
      }
      const created = await tx.paes.create({
        data: {
          patient_id: req.body.patientId,
          template_id: template.id,
          status: "vigente",
          start_date: new Date(req.body.startDate),
          review_date: req.body.reviewDate ? new Date(req.body.reviewDate) : null,
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
      const actions = await tx.pae_template_actions.findMany({ where: { template_id: template.id }, orderBy: { sort_order: "asc" } });
      if (actions.length) {
        await tx.pae_actions.createMany({
          data: actions.map((action) => ({
            pae_id: created.id,
            template_action_id: action.id,
            title: action.title,
            due_date: req.body.reviewDate ? new Date(req.body.reviewDate) : null,
            status: "pendente",
          })),
        });
      }
      return created;
    });
    res.status(201).json(present(pae));
  }),
);

router.post(
  "/:id/acoes/:actionId/executar",
  requirePerm("pae.execute"),
  validate(z.object({ id: idParam.shape.id, actionId: idParam.shape.id }), "params"),
  validate(z.object({ notes: z.string().trim().max(2000).optional() })),
  asyncHandler(async (req, res) => {
    const current = await prisma.pae_actions.findFirst({ where: { id: req.params.actionId, pae_id: req.params.id, status: "pendente" } });
    if (!current) throw new HttpError(409, "Ação inexistente ou já executada.");
    const row = await prisma.pae_actions.update({
      where: { id: current.id },
      data: { status: "executada", done_at: new Date(), notes: req.body.notes ?? null, responsible_id: current.responsible_id ?? req.user.id },
    });
    res.json(present(row));
  }),
);

router.post(
  "/:id/revisar",
  requirePerm("pae.review"),
  validate(idParam, "params"),
  validate(z.object({ reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  asyncHandler(async (req, res) => {
    const current = await prisma.paes.findUnique({ where: { id: req.params.id } });
    if (!current) notFound();
    if (current.status === "encerrado") throw new HttpError(409, "PAE encerrado não pode ser revisado.");
    const row = await prisma.paes.update({
      where: { id: current.id },
      data: { status: "vigente", review_date: new Date(req.body.reviewDate), version: { increment: 1 } },
    });
    res.json(present(row));
  }),
);

export default router;

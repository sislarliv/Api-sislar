import { Router } from "express";
import { z } from "zod";
import { notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { assertNotTooFuture } from "../lib/evolutionRules.js";
import { idParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth, requirePerm("modulo.farmacia"));

function calendar(value) {
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

router.get("/medicamentos", asyncHandler(async (_req, res) => {
  const rows = await prisma.medications.findMany({ include: { medication_lots: true }, orderBy: { name: "asc" } });
  res.json({
    data: rows.map((row) => {
      const qty = row.medication_lots.reduce((sum, lot) => sum + lot.qty, 0);
      return {
        ...present(row),
        qty,
        belowMin: qty < row.min_qty,
        hasExpiredLot: row.medication_lots.some((lot) => lot.qty > 0 && calendar(lot.expiry) < today()),
      };
    }),
  });
}));

router.get("/medicamentos/:id", validate(idParam, "params"), asyncHandler(async (req, res) => {
  const medication = await prisma.medications.findUnique({ where: { id: req.params.id }, include: { medication_lots: { orderBy: { expiry: "asc" } } } });
  if (!medication) notFound();
  const qty = medication.medication_lots.reduce((sum, lot) => sum + lot.qty, 0);
  res.json({ ...present(medication), qty, belowMin: qty < medication.min_qty, lots: present(medication.medication_lots) });
}));

router.post(
  "/medicamentos",
  requirePerm("estoque.manage"),
  validate(z.object({
    name: z.string().trim().min(2).max(160),
    activeIngredient: z.string().trim().min(2).max(160),
    form: z.string().trim().min(2).max(80),
    strength: z.string().trim().min(1).max(40),
    unit: z.string().trim().min(1).max(30),
    minQty: z.number().int().min(0).max(1000000),
    location: z.string().trim().min(2).max(80),
    coldChain: z.boolean().optional(),
  })),
  asyncHandler(async (req, res) => {
    const row = await prisma.medications.create({
      data: {
        name: req.body.name,
        active_ingredient: req.body.activeIngredient,
        form: req.body.form,
        strength: req.body.strength,
        kind: "medicamento",
        unit: req.body.unit,
        min_qty: req.body.minQty,
        location: req.body.location,
        cold_chain: req.body.coldChain ?? false,
      },
    });
    res.status(201).json(present(row));
  }),
);

router.post(
  "/medicamentos/:id/lotes",
  requirePerm("estoque.manage"),
  validate(idParam, "params"),
  validate(z.object({
    code: z.string().trim().min(2).max(40),
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    qty: z.number().int().min(1).max(1000000),
    supplier: z.string().trim().min(2).max(120),
  })),
  asyncHandler(async (req, res) => {
    const medication = await prisma.medications.findUnique({ where: { id: req.params.id } });
    if (!medication) notFound();
    const row = await prisma.medication_lots.create({
      data: {
        medication_id: medication.id,
        code: req.body.code,
        expiry: new Date(req.body.expiry),
        qty: req.body.qty,
        supplier: req.body.supplier,
        received_at: new Date(),
      },
    });
    res.status(201).json(present(row));
  }),
);

router.get("/prescricoes", asyncHandler(async (req, res) => {
  const rows = await prisma.prescriptions.findMany({
    where: typeof req.query.patientId === "string" ? { patient_id: req.query.patientId } : undefined,
    include: { medications: { select: { name: true } }, patients: { select: { name: true } } },
    orderBy: { start_date: "desc" },
  });
  res.json({
    data: rows.map((row) => present({ ...row, medication_name: row.medications.name, patient_name: row.patients.name })),
  });
}));

router.post(
  "/prescricoes",
  requirePerm("farmacia.prescrever"),
  validate(z.object({
    patientId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    medicationId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    dose: z.string().trim().min(1).max(80),
    route: z.string().trim().min(2).max(40),
    frequency: z.string().trim().min(2).max(80),
    instructions: z.string().trim().max(500).nullish(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  })),
  asyncHandler(async (req, res) => {
    if (req.body.endDate && req.body.endDate < req.body.startDate) throw new HttpError(422, "A data final precisa ser igual ou posterior ao início.");
    const row = await prisma.prescriptions.create({
      data: {
        patient_id: req.body.patientId,
        medication_id: req.body.medicationId,
        dose: req.body.dose,
        route: req.body.route,
        frequency: req.body.frequency,
        instructions: req.body.instructions ?? null,
        start_date: new Date(req.body.startDate),
        end_date: req.body.endDate ? new Date(req.body.endDate) : null,
        status: "vigente",
        prescriber_id: req.user.id,
      },
    });
    res.status(201).json(present(row));
  }),
);

router.patch(
  "/prescricoes/:id",
  requirePerm("farmacia.prescrever"),
  validate(idParam, "params"),
  validate(z.object({ status: z.enum(["vigente", "suspensa", "encerrada"]) })),
  asyncHandler(async (req, res) => {
    const current = await prisma.prescriptions.findUnique({ where: { id: req.params.id } });
    if (!current) notFound();
    const row = await prisma.prescriptions.update({ where: { id: current.id }, data: { status: req.body.status } });
    res.json(present(row));
  }),
);

router.get("/administracoes", asyncHandler(async (_req, res) => {
  const rows = await prisma.administrations.findMany({ orderBy: { scheduled_at: "desc" }, take: 200 });
  res.json({ data: present(rows) });
}));

router.post(
  "/administracoes",
  requirePerm("farmacia.administrar"),
  validate(z.object({
    prescriptionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    scheduledAt: z.coerce.date(),
    status: z.enum(["administrado", "recusado", "nao_administrado", "atrasado"]),
    notes: z.string().trim().max(500).optional(),
  })),
  asyncHandler(async (req, res) => {
    const scheduledAt = assertNotTooFuture(req.body.scheduledAt, "Horário previsto");
    const prescription = await prisma.prescriptions.findUnique({ where: { id: req.body.prescriptionId } });
    if (!prescription) notFound("Prescrição não encontrada.");
    if (prescription.status !== "vigente") throw new HttpError(409, "Prescrição não está vigente.");
    const row = await prisma.administrations.create({
      data: {
        prescription_id: prescription.id,
        patient_id: prescription.patient_id,
        medication_id: prescription.medication_id,
        scheduled_at: scheduledAt,
        administered_at: req.body.status === "administrado" ? new Date() : null,
        status: req.body.status,
        author_id: req.user.id,
        notes: req.body.notes ?? null,
      },
    });
    res.status(201).json(present(row));
  }),
);

router.get("/dispensacoes", asyncHandler(async (_req, res) => {
  const rows = await prisma.dispensations.findMany({
    include: { medications: { select: { name: true } } },
    orderBy: { at: "desc" },
    take: 200,
  });
  res.json({ data: rows.map((row) => present({ ...row, medication_name: row.medications.name })) });
}));

router.post(
  "/dispensacoes",
  requirePerm("farmacia.dispensar"),
  validate(z.object({
    lotId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    patientId: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
    qty: z.number().int().min(1).max(100000),
    notes: z.string().trim().max(500).optional(),
  })),
  asyncHandler(async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      const lot = await tx.medication_lots.findUnique({ where: { id: req.body.lotId } });
      if (!lot) notFound("Lote não encontrado.");
      if (calendar(lot.expiry) < today()) throw new HttpError(422, "Lote vencido não pode ser dispensado.");
      const updated = await tx.medication_lots.updateMany({
        where: { id: lot.id, qty: { gte: req.body.qty } },
        data: { qty: { decrement: req.body.qty } },
      });
      if (!updated.count) throw new HttpError(422, "Quantidade maior que o saldo do lote.");
      return tx.dispensations.create({
        data: {
          medication_id: lot.medication_id,
          lot_id: lot.id,
          patient_id: req.body.patientId ?? null,
          qty: req.body.qty,
          author_id: req.user.id,
          notes: req.body.notes ?? null,
        },
      });
    });
    res.status(201).json(present(created));
  }),
);

export default router;

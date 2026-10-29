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
router.use(requireAuth, requirePerm("modulo.temperatura"));

router.get("/equipamentos", asyncHandler(async (_req, res) => {
  const rows = await prisma.equipment.findMany({
    include: {
      sensors: { where: { active: true }, take: 1 },
      temperature_readings: { orderBy: { at: "desc" }, take: 1 },
    },
    orderBy: { name: "asc" },
  });
  res.json({
    data: rows.map((row) => present({
      ...row,
      sensor_code: row.sensors[0]?.code ?? null,
      last_value: row.temperature_readings[0]?.value ?? null,
    })),
  });
}));

router.post(
  "/equipamentos",
  requirePerm("temperatura.manage"),
  validate(z.object({
    name: z.string().trim().min(2).max(120),
    location: z.string().trim().min(2).max(80),
    kind: z.enum(["geladeira", "ambiente", "freezer"]),
    minTemp: z.number().min(-50).max(60),
    maxTemp: z.number().min(-50).max(60),
  }).refine((body) => body.maxTemp > body.minTemp, { message: "A temperatura máxima precisa ser maior que a mínima.", path: ["maxTemp"] })),
  asyncHandler(async (req, res) => {
    const row = await prisma.equipment.create({
      data: { name: req.body.name, location: req.body.location, kind: req.body.kind, min_temp: req.body.minTemp, max_temp: req.body.maxTemp },
    });
    res.status(201).json(present(row));
  }),
);

router.get("/equipamentos/:id", validate(idParam, "params"), asyncHandler(async (req, res) => {
  const equipment = await prisma.equipment.findUnique({
    where: { id: req.params.id },
    include: {
      sensors: { orderBy: { code: "asc" } },
      temperature_readings: { orderBy: { at: "desc" }, take: 50 },
      temperature_alerts: { orderBy: { at: "desc" } },
    },
  });
  if (!equipment) notFound();
  res.json(present(equipment));
}));

router.post(
  "/equipamentos/:id/sensores",
  requirePerm("temperatura.manage"),
  validate(idParam, "params"),
  validate(z.object({ code: z.string().trim().min(2).max(40) })),
  asyncHandler(async (req, res) => {
    const equipment = await prisma.equipment.findUnique({ where: { id: req.params.id } });
    if (!equipment) notFound();
    const row = await prisma.sensors.create({ data: { equipment_id: equipment.id, code: req.body.code } });
    res.status(201).json(present(row));
  }),
);

router.get("/alertas", requirePerm("temperatura.alertas"), asyncHandler(async (req, res) => {
  const status = req.query.status === "aberto" || req.query.status === "resolvido" ? req.query.status : undefined;
  const rows = await prisma.temperature_alerts.findMany({
    where: status ? { status } : undefined,
    include: { equipment: { select: { name: true } } },
    orderBy: { at: "desc" },
  });
  res.json({ data: rows.map((row) => present({ ...row, equipment_name: row.equipment.name })) });
}));

router.post("/alertas/:id/resolver", requirePerm("temperatura.alertas"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const current = await prisma.temperature_alerts.findFirst({ where: { id: req.params.id, status: "aberto" } });
  if (!current) throw new HttpError(409, "Alerta inexistente ou já resolvido.");
  const row = await prisma.temperature_alerts.update({
    where: { id: current.id },
    data: { status: "resolvido", resolved_at: new Date(), resolved_by: req.user.id },
  });
  res.json(present(row));
}));

router.post(
  "/leituras",
  requirePerm("temperatura.registrar"),
  validate(z.object({
    equipmentId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    sensorId: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
    value: z.number().min(-50).max(60),
    at: z.coerce.date().optional(),
  })),
  asyncHandler(async (req, res) => {
    const at = assertNotTooFuture(req.body.at ?? new Date(), "Data da leitura");
    const result = await prisma.$transaction(async (tx) => {
      const equipment = await tx.equipment.findUnique({ where: { id: req.body.equipmentId } });
      if (!equipment) notFound("Equipamento não encontrado.");
      if (!equipment.active) throw new HttpError(422, "Equipamento inativo.");
      if (req.body.sensorId) {
        const sensor = await tx.sensors.findUnique({ where: { id: req.body.sensorId } });
        if (!sensor) notFound("Sensor não encontrado.");
        if (sensor.equipment_id !== equipment.id) throw new HttpError(422, "Sensor não pertence ao equipamento.");
        if (!sensor.active) throw new HttpError(422, "Sensor inativo.");
      }
      const reading = await tx.temperature_readings.create({
        data: { equipment_id: equipment.id, sensor_id: req.body.sensorId ?? null, value: req.body.value, at, author_id: req.user.id },
      });
      const min = Number(equipment.min_temp);
      const max = Number(equipment.max_temp);
      let alert = null;
      if (req.body.value < min || req.body.value > max) {
        const kind = req.body.value < min ? "abaixo" : "acima";
        alert = await tx.temperature_alerts.create({
          data: {
            equipment_id: equipment.id,
            reading_id: reading.id,
            kind,
            message: `${equipment.name}: ${req.body.value}°C ${kind} do limite (${min} a ${max}).`,
            status: "aberto",
            at,
          },
        });
      }
      return { reading: present(reading), alert: present(alert) };
    });
    res.status(201).json(result);
  }),
);

export default router;

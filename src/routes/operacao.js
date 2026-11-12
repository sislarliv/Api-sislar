import { Router } from "express";
import { z } from "zod";
import { dashboardCounts, stockReport } from "../db/grupo2.js";
import { notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth);

function localDate(offset = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offset);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return new Date(`${now.getFullYear()}-${month}-${day}T00:00:00.000Z`);
}

function calendar(value) {
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

router.get("/modulos", asyncHandler(async (req, res) => {
  const rows = await prisma.modules.findMany({ orderBy: [{ epic: "asc" }, { label: "asc" }] });
  const data = rows.filter((row) => req.user.permissions.includes(`modulo.${row.id}`));
  res.json({ data: present(data) });
}));

router.get("/modulos/:id", asyncHandler(async (req, res) => {
  const row = await prisma.modules.findUnique({ where: { id: req.params.id } });
  if (!row) notFound("Módulo não encontrado.");
  if (!req.user.permissions.includes(`modulo.${row.id}`)) {
    throw new HttpError(403, "Você não tem autorização para esta ação.");
  }
  res.json(present(row));
}));

router.get("/dashboard", requirePerm("modulo.dashboard"), asyncHandler(async (_req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const horizon = localDate(30);
  const [patients, presence, evolutionsToday, openOccurrences, draftEvolutions, pops, grupo2] = await Promise.all([
    prisma.patients.groupBy({ by: ["status"], where: { active: true }, _count: { _all: true } }),
    prisma.patients.groupBy({ by: ["presence_status"], where: { active: true }, _count: { _all: true } }),
    prisma.evolutions.count({ where: { status: "finalizado", at: { gte: start, lt: end } } }),
    prisma.occurrences.count({ where: { status: { not: "encerrada" } } }),
    prisma.evolutions.count({ where: { status: "rascunho" } }),
    prisma.pops.findMany({ where: { status: "vigente" }, select: { valid_until: true } }),
    dashboardCounts(),
  ]);
  const byStatus = Object.fromEntries(patients.map((row) => [row.status, row._count._all]));
  res.json({
    patients: {
      total: patients.reduce((sum, row) => sum + row._count._all, 0),
      byStatus,
      byPresence: Object.fromEntries(presence.map((row) => [row.presence_status, row._count._all])),
    },
    evolutionsToday,
    openOccurrences,
    draftEvolutions,
    expiringPops: pops.filter((row) => calendar(row.valid_until) <= calendar(horizon)).length,
    openTempAlerts: grupo2.openTempAlerts,
    lowStock: grupo2.lowStock,
    expiredLots: grupo2.expiredLots,
  });
}));

router.get("/notificacoes", asyncHandler(async (req, res) => {
  const rows = await prisma.notifications.findMany({
    where: { OR: [{ user_id: null }, { user_id: req.user.id }] },
    orderBy: { at: "desc" },
  });
  res.json({ data: present(rows) });
}));

router.post("/notificacoes/:id/ler", asyncHandler(async (req, res) => {
  const current = await prisma.notifications.findFirst({
    where: { id: req.params.id, OR: [{ user_id: null }, { user_id: req.user.id }] },
  });
  if (!current) notFound();
  const row = await prisma.notifications.update({ where: { id: current.id }, data: { read: true } });
  res.json(present(row));
}));

router.get("/funcionarios", requirePerm("modulo.funcionarios"), asyncHandler(async (_req, res) => {
  const rows = await prisma.users.findMany({
    include: { user_profiles: { orderBy: { profile: "asc" } } },
    orderBy: { name: "asc" },
  });
  res.json({
    data: rows.map((row) => ({
      id: row.id,
      name: row.name,
      roleLabel: row.role_label,
      sector: row.sector,
      active: row.active,
      profiles: row.user_profiles.map((item) => item.profile),
    })),
  });
}));

const eventBody = z.object({
  title: z.string().trim().min(3).max(160),
  patientId: z.string().regex(/^[A-Za-z0-9_-]+$/).nullish(),
  professionalId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  kind: z.string().trim().min(2).max(40),
  notes: z.string().trim().max(1000).optional(),
});

router.get("/agenda", requirePerm("modulo.agenda"), asyncHandler(async (_req, res) => {
  const rows = await prisma.agenda_events.findMany({ orderBy: { starts_at: "asc" } });
  res.json({ data: present(rows) });
}));

router.post("/agenda", requirePerm("modulo.agenda"), validate(eventBody), asyncHandler(async (req, res) => {
  if (req.body.endsAt <= req.body.startsAt) throw new HttpError(422, "O término precisa ser depois do início.");
  const row = await prisma.agenda_events.create({
    data: {
      title: req.body.title,
      patient_id: req.body.patientId ?? null,
      professional_id: req.body.professionalId,
      starts_at: req.body.startsAt,
      ends_at: req.body.endsAt,
      kind: req.body.kind,
      status: "agendado",
      notes: req.body.notes ?? null,
    },
  });
  res.status(201).json(present(row));
}));

router.get("/visitas", requirePerm("modulo.visitas"), asyncHandler(async (_req, res) => {
  const rows = await prisma.visits.findMany({ orderBy: { arrived_at: "desc" } });
  res.json({ data: present(rows) });
}));

router.post(
  "/visitas",
  requirePerm("modulo.visitas"),
  validate(z.object({
    patientId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    visitorName: z.string().trim().min(3).max(120),
    relation: z.string().trim().min(2).max(40),
    document: z.string().trim().max(40).optional(),
    arrivedAt: z.coerce.date().optional(),
    notes: z.string().trim().max(500).optional(),
  })),
  asyncHandler(async (req, res) => {
    const row = await prisma.visits.create({
      data: {
        patient_id: req.body.patientId,
        visitor_name: req.body.visitorName,
        relation: req.body.relation,
        document: req.body.document ?? null,
        arrived_at: req.body.arrivedAt ?? new Date(),
        registered_by: req.user.id,
        notes: req.body.notes ?? null,
      },
    });
    res.status(201).json(present(row));
  }),
);

router.patch("/visitas/:id/saida", requirePerm("modulo.visitas"), asyncHandler(async (req, res) => {
  const current = await prisma.visits.findUnique({ where: { id: req.params.id } });
  if (!current) notFound("Visita não encontrada.");
  if (current.left_at) throw new HttpError(409, "A saída já foi registrada.");
  const row = await prisma.visits.update({ where: { id: current.id }, data: { left_at: new Date() } });
  res.json(present(row));
}));

router.get("/emergencias", requirePerm("modulo.emergencias"), asyncHandler(async (_req, res) => {
  const rows = await prisma.emergencies.findMany({ orderBy: { opened_at: "desc" } });
  res.json({ data: present(rows) });
}));

router.post(
  "/emergencias",
  requirePerm("modulo.emergencias"),
  validate(z.object({
    patientId: z.string().regex(/^[A-Za-z0-9_-]+$/).nullish(),
    kind: z.string().trim().min(2).max(60),
    description: z.string().trim().min(10).max(2000),
  })),
  asyncHandler(async (req, res) => {
    const row = await prisma.emergencies.create({
      data: {
        patient_id: req.body.patientId ?? null,
        kind: req.body.kind,
        description: req.body.description,
        status: "aberta",
        opened_by: req.user.id,
      },
    });
    res.status(201).json(present(row));
  }),
);

router.patch(
  "/emergencias/:id",
  requirePerm("modulo.emergencias"),
  validate(z.object({ status: z.enum(["aberta", "em_atendimento", "encerrada"]) })),
  asyncHandler(async (req, res) => {
    const current = await prisma.emergencies.findUnique({ where: { id: req.params.id } });
    if (!current) notFound();
    if (current.status === "encerrada") throw new HttpError(409, "Emergência já encerrada.");
    const row = await prisma.emergencies.update({
      where: { id: current.id },
      data: {
        status: req.body.status,
        closed_at: req.body.status === "encerrada" ? new Date() : current.closed_at,
      },
    });
    res.json(present(row));
  }),
);

router.get("/atendimentos", asyncHandler(async (req, res) => {
  const allowed = [];
  if (req.user.permissions.includes("modulo.fisioterapia")) allowed.push("fisioterapia");
  if (req.user.permissions.includes("modulo.medicina")) allowed.push("medicina", "odontologia", "psicologia", "nutricao");
  if (!allowed.length) throw new HttpError(403, "Você não tem autorização para esta ação.");
  const rows = await prisma.appointments.findMany({ where: { specialty: { in: allowed } }, orderBy: { at: "desc" } });
  res.json({ data: present(rows) });
}));

router.post(
  "/atendimentos",
  validate(z.object({
    patientId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    specialty: z.enum(["fisioterapia", "medicina", "odontologia", "psicologia", "nutricao"]),
    at: z.coerce.date(),
    summary: z.string().trim().min(10).max(4000),
    status: z.enum(["rascunho", "finalizado"]).optional(),
  })),
  asyncHandler(async (req, res) => {
    const needed = req.body.specialty === "fisioterapia" ? "modulo.fisioterapia" : "modulo.medicina";
    if (!req.user.permissions.includes(needed)) throw new HttpError(403, "Você não tem autorização para esta ação.");
    const row = await prisma.appointments.create({
      data: {
        patient_id: req.body.patientId,
        specialty: req.body.specialty,
        professional_id: req.user.id,
        at: req.body.at,
        summary: req.body.summary,
        status: req.body.status ?? "finalizado",
      },
    });
    res.status(201).json(present(row));
  }),
);

router.get("/relatorios/ocupacao", requirePerm("modulo.relatorios"), asyncHandler(async (_req, res) => {
  const rows = await prisma.patients.groupBy({
    by: ["wing", "status"],
    where: { active: true },
    _count: { _all: true },
    orderBy: [{ wing: "asc" }, { status: "asc" }],
  });
  res.json({ data: rows.map((row) => ({ wing: row.wing, status: row.status, total: row._count._all })) });
}));

router.get("/relatorios/ocorrencias", requirePerm("modulo.relatorios"), asyncHandler(async (_req, res) => {
  const rows = await prisma.occurrences.groupBy({
    by: ["status", "priority"],
    _count: { _all: true },
    orderBy: [{ status: "asc" }],
  });
  res.json({ data: rows.map((row) => ({ status: row.status, priority: row.priority, total: row._count._all })) });
}));

router.get("/relatorios/estoque", requirePerm("modulo.relatorios"), asyncHandler(async (_req, res) => {
  res.json(await stockReport());
}));

export default router;

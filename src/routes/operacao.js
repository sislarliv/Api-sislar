import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const uploadDir = fileURLToPath(new URL("../../uploads", import.meta.url));
mkdirSync(uploadDir, { recursive: true });
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

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
  const today = calendar(localDate(0));
  const [patients, evolutionsToday, openOccurrences, draftEvolutions, pops, openTempAlerts, stock, lots] = await Promise.all([
    prisma.patients.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.evolutions.count({ where: { status: "finalizado", at: { gte: start, lt: end } } }),
    prisma.occurrences.count({ where: { status: { not: "encerrada" } } }),
    prisma.evolutions.count({ where: { status: "rascunho" } }),
    prisma.pops.findMany({ where: { status: "vigente" }, select: { valid_until: true } }),
    prisma.temperature_alerts.count({ where: { status: "aberto" } }),
    prisma.stock_items.findMany({ select: { qty: true, min_qty: true } }),
    prisma.medication_lots.findMany({ where: { qty: { gt: 0 } }, select: { expiry: true } }),
  ]);
  const byStatus = Object.fromEntries(patients.map((row) => [row.status, row._count._all]));
  res.json({
    patients: { total: patients.reduce((sum, row) => sum + row._count._all, 0), byStatus },
    evolutionsToday,
    openOccurrences,
    draftEvolutions,
    expiringPops: pops.filter((row) => calendar(row.valid_until) <= calendar(horizon)).length,
    openTempAlerts,
    lowStock: stock.filter((row) => row.qty < row.min_qty).length,
    expiredLots: lots.filter((row) => calendar(row.expiry) < today).length,
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
  const today = calendar(localDate(0));
  const [items, lots] = await Promise.all([
    prisma.stock_items.findMany({ orderBy: { name: "asc" } }),
    prisma.medication_lots.findMany({ include: { medications: { select: { name: true } } }, orderBy: { expiry: "asc" } }),
  ]);
  res.json({
    lowStock: items.filter((item) => item.qty < item.min_qty).map((item) => present(item)),
    expiredLots: lots
      .filter((lot) => lot.qty > 0 && calendar(lot.expiry) < today)
      .map((lot) => present({ id: lot.id, code: lot.code, expiry: lot.expiry, qty: lot.qty, name: lot.medications.name })),
  });
}));

function parseCsv(content) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new HttpError(422, "Planilha sem dados.");
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(delimiter).map((cell) => cell.trim().toLowerCase());
  const expected = ["nome", "sexo", "nascimento", "ala", "quarto", "leito"];
  if (expected.some((column, index) => header[index] !== column)) {
    throw new HttpError(422, "Cabeçalho inválido. Use nome, sexo, nascimento, ala, quarto e leito.");
  }
  return lines.slice(1).map((line, index) => ({ line: index + 2, cells: line.split(delimiter).map((cell) => cell.trim()) }));
}

router.get("/importacoes", requirePerm("dados.import"), asyncHandler(async (_req, res) => {
  const rows = await prisma.import_jobs.findMany({
    select: { id: true, filename: true, status: true, created_by: true, created_at: true, summary: true },
    orderBy: { created_at: "desc" },
  });
  res.json({ data: present(rows) });
}));

router.post(
  "/importacoes",
  requirePerm("dados.import"),
  (req, res, next) => {
    csvUpload.single("arquivo")(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") return next(new HttpError(422, "Arquivo acima de 2 MB."));
      return next(new HttpError(422, "Não foi possível receber o arquivo."));
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file || req.file.size === 0) throw new HttpError(422, "Anexe um arquivo CSV.");
    const name = path.basename(req.file.originalname || "importacao.csv");
    if (!name.toLowerCase().endsWith(".csv")) throw new HttpError(422, "Envie um arquivo .csv.");
    const rows = parseCsv(req.file.buffer.toString("utf8"));
    const errors = [];
    const createdIds = [];
    const job = await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const [nome, sexo, nascimento, ala, quarto, leito] = row.cells;
        const problems = [];
        if (!nome || nome.length < 3) problems.push("nome inválido");
        if (!["F", "M"].includes(sexo)) problems.push("sexo deve ser F ou M");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nascimento || "")) problems.push("nascimento inválido");
        if (!ala) problems.push("ala obrigatória");
        if (!quarto) problems.push("quarto obrigatório");
        if (!["A", "B"].includes(leito)) problems.push("leito deve ser A ou B");
        if (nascimento && nascimento > new Date().toISOString().slice(0, 10)) problems.push("nascimento no futuro");
        if (problems.length) {
          errors.push({ line: row.line, message: problems.join("; ") });
          continue;
        }
        const id = `imp-${randomUUID()}`;
        const code = `IMP-${id.slice(-8).toUpperCase()}`;
        const treatment = `${sexo === "F" ? "Dona" : "Seu"} ${nome.split(" ")[0]}`;
        await tx.patients.create({
          data: {
            id,
            code,
            name: nome,
            treatment,
            sex: sexo,
            birth_date: new Date(`${nascimento}T00:00:00.000Z`),
            admission_date: localDate(0),
            wing: ala,
            room: quarto,
            bed: leito,
            status: "estavel",
          },
        });
        createdIds.push(id);
      }
      const status = createdIds.length === 0 ? "falhou" : errors.length ? "com_erros" : "concluida";
      const stored = `${randomUUID()}.csv`;
      writeFileSync(path.join(uploadDir, stored), req.file.buffer);
      return tx.import_jobs.create({
        data: {
          filename: name,
          status,
          created_by: req.user.id,
          summary: { created: createdIds.length, errors },
          storage_path: stored,
        },
      });
    });
    const body = { job: present(job), created: createdIds.length, errors };
    if (createdIds.length === 0) {
      res.status(422).json({ error: { message: "Nenhuma linha válida.", details: errors }, ...body });
      return;
    }
    res.status(201).json(body);
  }),
);

export default router;

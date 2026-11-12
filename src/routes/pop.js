import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { effectivePopStatus } from "../lib/popStatus.js";
import { idParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const sectionSchema = z.object({
  title: z.string().trim().min(2).max(120),
  items: z.array(z.string().trim().min(2).max(500)).min(1).max(30),
});
const popBody = z.object({
  code: z.string().trim().min(3).max(40),
  title: z.string().trim().min(3).max(160),
  category: z.string().trim().min(2).max(80),
  purpose: z.string().trim().min(10).max(2000),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["rascunho", "vigente"]).optional(),
  sections: z.array(sectionSchema).min(1).max(12),
  related: z.array(z.object({ kind: z.string().trim().min(2).max(40), label: z.string().trim().min(2).max(80) })).max(10).optional(),
  summary: z.string().trim().min(3).max(300).optional(),
});

const popQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  relatedKind: z.string().trim().max(40).optional(),
  relatedLabel: z.string().trim().max(80).optional(),
  status: z.enum(["aplicavel", "vigente", "vencendo", "vencido", "rascunho", "arquivado", "todos"]).default("aplicavel"),
});

function institutionToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(422, "Data inválida.");
  }
  return parsed;
}

function isApplicable(row, today) {
  const start = present(row.valid_from);
  const end = present(row.valid_until);
  return row.status === "vigente" && start <= today && end >= today;
}

function matchesRelated(row, kind, label) {
  if (!kind && !label) return true;
  return Array.isArray(row.related) && row.related.some((item) =>
    (!kind || item.kind?.toLocaleLowerCase("pt-BR") === kind.toLocaleLowerCase("pt-BR"))
    && (!label || item.label?.toLocaleLowerCase("pt-BR").includes(label.toLocaleLowerCase("pt-BR"))));
}

function presentPop(row) {
  const data = present(row);
  return { ...data, effectiveStatus: effectivePopStatus(data.status, data.validUntil) };
}

function versionContent(body, code, version, responsibleId, related) {
  return {
    code, version, title: body.title, category: body.category, purpose: body.purpose,
    responsibleId, validFrom: body.validFrom, validUntil: body.validUntil,
    status: body.status ?? "vigente", sections: body.sections, related,
  };
}

router.use(requireAuth);

router.get("/", requirePerm("pop.view"), validate(popQuery, "query"), asyncHandler(async (req, res) => {
  const { q, category, relatedKind, relatedLabel, status } = req.query;
  const manages = req.user.permissions.includes("pop.manage");
  if (!["aplicavel", "vigente", "vencendo"].includes(status) && !manages) {
    throw new HttpError(403, "Você não tem autorização para consultar POPs não aplicáveis.");
  }
  const rows = await prisma.pops.findMany({
    where: {
      ...(q && { OR: [
        { code: { contains: q, mode: "insensitive" } },
        { title: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ] }),
      ...(category && { category: { contains: category, mode: "insensitive" } }),
    },
    orderBy: { code: "asc" },
  });
  const today = institutionToday();
  const filtered = rows.filter((row) => {
    if (!matchesRelated(row, relatedKind, relatedLabel)) return false;
    if (status === "todos") return true;
    if (status === "rascunho" || status === "arquivado") return row.status === status;
    if (status === "vencido") return row.status === "vigente" && present(row.valid_until) < today;
    if (!isApplicable(row, today)) return false;
    return status !== "vencendo" || presentPop(row).effectiveStatus === "vencendo";
  });
  res.json({ data: filtered.map(presentPop), meta: { total: filtered.length } });
}));

router.get("/:id", requirePerm("pop.view"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const pop = await prisma.pops.findUnique({
    where: { id: req.params.id },
    include: { pop_versions: { orderBy: { version: "desc" }, select: { id: true, version: true, at: true, by_id: true, summary: true, valid_until: true } } },
  });
  if (!pop) notFound("POP não encontrado.");
  if (!req.user.permissions.includes("pop.manage") && !isApplicable(pop, institutionToday())) {
    notFound("POP aplicável não encontrado.");
  }
  const data = presentPop(pop);
  res.json({ ...data, versions: req.user.permissions.includes("pop.manage") ? present(pop.pop_versions) : [] });
}));

router.get("/:id/versoes/:version", requirePerm("pop.manage"), validate(z.object({
  id: idParam.shape.id,
  version: z.coerce.number().int().min(1),
}), "params"), asyncHandler(async (req, res) => {
  const row = await prisma.pop_versions.findUnique({
    where: { pop_id_version: { pop_id: req.params.id, version: req.params.version } },
  });
  if (!row) notFound("Versão não encontrada.");
  res.json({ ...present(row), content: row.snapshot ?? null });
}));

router.patch("/:id/status", requirePerm("pop.manage"), validate(idParam, "params"), validate(z.object({
  status: z.enum(["rascunho", "vigente", "arquivado"]),
})), asyncHandler(async (req, res) => {
  const row = await prisma.$transaction(async (tx) => {
    const current = await tx.pops.findUnique({ where: { id: req.params.id } });
    if (!current) notFound("POP não encontrado.");
    if (current.status === "arquivado" && req.body.status !== "arquivado") {
      throw new HttpError(409, "POP arquivado não pode ser reativado.");
    }
    if (current.status === req.body.status) return current;
    const changed = await tx.pops.updateMany({
      where: { id: current.id, status: current.status }, data: { status: req.body.status },
    });
    if (!changed.count) throw new HttpError(409, "O status do POP mudou. Recarregue e tente novamente.");
    const updated = await tx.pops.findUnique({ where: { id: current.id } });
    const version = await tx.pop_versions.findUnique({
      where: { pop_id_version: { pop_id: current.id, version: current.version } },
    });
    if (version) {
      const content = version.snapshot ?? versionContent({
        title: updated.title, category: updated.category, purpose: updated.purpose,
        validFrom: present(updated.valid_from), validUntil: present(updated.valid_until),
        status: updated.status, sections: updated.sections,
      }, updated.code, updated.version, updated.responsible_id, updated.related);
      await tx.pop_versions.update({
        where: { id: version.id }, data: { snapshot: { ...content, status: updated.status } },
      });
    }
    await audit(tx, { userId: req.user.id, action: "alterar_status", entity: "pop", entityId: current.id,
      payload: { previous: current.status, current: req.body.status } });
    return updated;
  });
  res.json(presentPop(row));
}));

router.post("/", requirePerm("pop.manage"), validate(popBody), asyncHandler(async (req, res) => {
  if (req.body.validUntil < req.body.validFrom) throw new HttpError(422, "A validade final precisa ser igual ou posterior ao início.");
  const validFrom = calendarDate(req.body.validFrom);
  const validUntil = calendarDate(req.body.validUntil);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.pops.create({
      data: {
        code: req.body.code,
        title: req.body.title,
        category: req.body.category,
        version: 1,
        responsible_id: req.user.id,
        valid_from: validFrom,
        valid_until: validUntil,
        status: req.body.status ?? "vigente",
        purpose: req.body.purpose,
        sections: req.body.sections,
        related: req.body.related ?? [],
        pop_versions: {
          create: {
            version: 1,
            by_id: req.user.id,
            summary: req.body.summary ?? "Versão inicial.",
            valid_until: validUntil,
            sections: req.body.sections,
            snapshot: versionContent(req.body, req.body.code, 1, req.user.id, req.body.related ?? []),
          },
        },
      },
    });
    await audit(tx, { userId: req.user.id, action: "criar", entity: "pop", entityId: row.id,
      payload: { code: row.code, version: row.version } });
    return row;
  });
  res.status(201).json(presentPop(created));
}));

router.post(
  "/:id/versoes",
  requirePerm("pop.manage"),
  validate(idParam, "params"),
  validate(popBody.omit({ code: true }).extend({ summary: z.string().trim().min(3).max(300) })),
  asyncHandler(async (req, res) => {
    if (req.body.validUntil < req.body.validFrom) throw new HttpError(422, "A validade final precisa ser igual ou posterior ao início.");
    const validFrom = calendarDate(req.body.validFrom);
    const validUntil = calendarDate(req.body.validUntil);
    const pop = await prisma.$transaction(async (tx) => {
      const current = await tx.pops.findUnique({ where: { id: req.params.id } });
      if (!current) notFound("POP não encontrado.");
      if (current.status === "arquivado") throw new HttpError(409, "POP arquivado não gera nova versão.");
      const version = current.version + 1;
      await tx.pop_versions.create({
        data: {
          pop_id: current.id,
          version,
          by_id: req.user.id,
          summary: req.body.summary,
          valid_until: validUntil,
          sections: req.body.sections,
          snapshot: versionContent(req.body, current.code, version, req.user.id, req.body.related ?? current.related),
        },
      });
      const changed = await tx.pops.updateMany({
        where: { id: current.id, version: current.version, status: current.status },
        data: {
          title: req.body.title,
          category: req.body.category,
          version,
          responsible_id: req.user.id,
          valid_from: validFrom,
          valid_until: validUntil,
          status: req.body.status ?? "vigente",
          purpose: req.body.purpose,
          sections: req.body.sections,
          related: req.body.related ?? current.related,
        },
      });
      if (!changed.count) throw new HttpError(409, "O POP mudou. Recarregue e tente novamente.");
      const updated = await tx.pops.findUnique({ where: { id: current.id } });
      await audit(tx, { userId: req.user.id, action: "publicar_versao", entity: "pop", entityId: current.id,
        payload: { previousVersion: current.version, version } });
      return updated;
    });
    res.status(201).json(presentPop(pop));
  }),
);

export default router;

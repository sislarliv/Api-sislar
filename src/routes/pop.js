import { Router } from "express";
import { z } from "zod";
import { notFound } from "../db/helpers.js";
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

function presentPop(row) {
  const data = present(row);
  return { ...data, effectiveStatus: effectivePopStatus(data.status, data.validUntil) };
}

router.use(requireAuth);

router.get("/", requirePerm("pop.view"), asyncHandler(async (_req, res) => {
  const rows = await prisma.pops.findMany({ orderBy: { code: "asc" } });
  res.json({ data: rows.map(presentPop) });
}));

router.get("/:id", requirePerm("pop.view"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const pop = await prisma.pops.findUnique({
    where: { id: req.params.id },
    include: { pop_versions: { orderBy: { version: "desc" }, select: { id: true, version: true, at: true, by_id: true, summary: true, valid_until: true } } },
  });
  if (!pop) notFound("POP não encontrado.");
  const data = presentPop(pop);
  res.json({ ...data, versions: present(pop.pop_versions) });
}));

router.post("/", requirePerm("pop.manage"), validate(popBody), asyncHandler(async (req, res) => {
  if (req.body.validUntil < req.body.validFrom) throw new HttpError(422, "A validade final precisa ser igual ou posterior ao início.");
  const created = await prisma.pops.create({
    data: {
      code: req.body.code,
      title: req.body.title,
      category: req.body.category,
      version: 1,
      responsible_id: req.user.id,
      valid_from: new Date(req.body.validFrom),
      valid_until: new Date(req.body.validUntil),
      status: req.body.status ?? "vigente",
      purpose: req.body.purpose,
      sections: req.body.sections,
      related: req.body.related ?? [],
      pop_versions: {
        create: {
          version: 1,
          by_id: req.user.id,
          summary: req.body.summary ?? "Versão inicial.",
          valid_until: new Date(req.body.validUntil),
          sections: req.body.sections,
        },
      },
    },
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
          valid_until: new Date(req.body.validUntil),
          sections: req.body.sections,
        },
      });
      return tx.pops.update({
        where: { id: current.id },
        data: {
          title: req.body.title,
          category: req.body.category,
          version,
          responsible_id: req.user.id,
          valid_from: new Date(req.body.validFrom),
          valid_until: new Date(req.body.validUntil),
          status: req.body.status ?? "vigente",
          purpose: req.body.purpose,
          sections: req.body.sections,
          related: req.body.related ?? current.related,
        },
      });
    });
    res.status(201).json(presentPop(pop));
  }),
);

export default router;

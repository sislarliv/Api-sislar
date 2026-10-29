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
router.use(requireAuth, requirePerm("modulo.estoque"));

router.get("/itens", asyncHandler(async (_req, res) => {
  const rows = await prisma.stock_items.findMany({ orderBy: { name: "asc" } });
  res.json({ data: rows.map((row) => ({ ...present(row), belowMin: row.qty < row.min_qty })) });
}));

router.post(
  "/itens",
  requirePerm("estoque.manage"),
  validate(z.object({
    name: z.string().trim().min(2).max(160),
    category: z.string().trim().min(2).max(60),
    unit: z.string().trim().min(1).max(30),
    minQty: z.number().int().min(0).max(1000000),
    location: z.string().trim().min(2).max(80),
    qty: z.number().int().min(0).max(1000000).optional(),
  })),
  asyncHandler(async (req, res) => {
    const qty = req.body.qty ?? 0;
    const created = await prisma.$transaction(async (tx) => {
      const item = await tx.stock_items.create({
        data: { name: req.body.name, category: req.body.category, unit: req.body.unit, min_qty: req.body.minQty, qty, location: req.body.location },
      });
      if (qty > 0) {
        await tx.stock_movements.create({
          data: { item_id: item.id, type: "entrada", qty, balance_after: qty, reason: "Saldo inicial", author_id: req.user.id },
        });
      }
      return item;
    });
    res.status(201).json(present(created));
  }),
);

router.get("/movimentacoes", asyncHandler(async (_req, res) => {
  const rows = await prisma.stock_movements.findMany({
    include: { stock_items: { select: { name: true } } },
    orderBy: { at: "desc" },
    take: 200,
  });
  res.json({ data: rows.map((row) => present({ ...row, item_name: row.stock_items.name })) });
}));

router.post(
  "/movimentacoes",
  requirePerm("estoque.movimentar"),
  validate(z.object({
    itemId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    type: z.enum(["entrada", "saida"]),
    qty: z.number().int().min(1).max(100000),
    reason: z.string().trim().min(3).max(200),
  })),
  asyncHandler(async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      const item = await tx.stock_items.findUnique({ where: { id: req.body.itemId } });
      if (!item) notFound("Item não encontrado.");
      const delta = req.body.type === "saida" ? -req.body.qty : req.body.qty;
      if (req.body.type === "saida") {
        const updated = await tx.stock_items.updateMany({
          where: { id: item.id, qty: { gte: req.body.qty } },
          data: { qty: { decrement: req.body.qty } },
        });
        if (!updated.count) throw new HttpError(422, "Quantidade maior que o saldo.");
      } else {
        await tx.stock_items.update({ where: { id: item.id }, data: { qty: { increment: req.body.qty } } });
      }
      const current = await tx.stock_items.findUnique({ where: { id: item.id } });
      const movement = await tx.stock_movements.create({
        data: { item_id: item.id, type: req.body.type, qty: delta, balance_after: current.qty, reason: req.body.reason, author_id: req.user.id },
      });
      await audit(tx, { userId: req.user.id, action: req.body.type, entity: "estoque", entityId: item.id, payload: { qty: req.body.qty, balance: current.qty } });
      return movement;
    });
    res.status(201).json(present(created));
  }),
);

router.post(
  "/inventarios",
  requirePerm("estoque.inventario"),
  validate(z.object({
    notes: z.string().trim().max(500).optional(),
    lines: z.array(z.object({
      itemId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      countedQty: z.number().int().min(0).max(1000000),
    })).min(1).max(200),
  })),
  asyncHandler(async (req, res) => {
    const ids = req.body.lines.map((line) => line.itemId);
    if (new Set(ids).size !== ids.length) throw new HttpError(422, "Item repetido no inventário.");
    const created = await prisma.$transaction(async (tx) => {
      const inventory = await tx.inventories.create({
        data: { author_id: req.user.id, status: "fechado", notes: req.body.notes ?? null },
      });
      for (const line of req.body.lines) {
        const item = await tx.stock_items.findUnique({ where: { id: line.itemId } });
        if (!item) notFound("Item não encontrado.");
        await tx.inventory_lines.create({
          data: { inventory_id: inventory.id, item_id: item.id, expected_qty: item.qty, counted_qty: line.countedQty },
        });
        const delta = line.countedQty - item.qty;
        if (delta !== 0) {
          await tx.stock_items.update({ where: { id: item.id }, data: { qty: line.countedQty } });
          await tx.stock_movements.create({
            data: { item_id: item.id, type: "ajuste", qty: delta, balance_after: line.countedQty, reason: `Inventário ${inventory.id}`, author_id: req.user.id },
          });
        }
      }
      return inventory;
    });
    res.status(201).json(present(created));
  }),
);

router.get("/reposicoes", asyncHandler(async (_req, res) => {
  const rows = await prisma.replenishments.findMany({
    include: { stock_items: { select: { name: true } } },
    orderBy: { requested_at: "desc" },
  });
  res.json({ data: rows.map((row) => present({ ...row, item_name: row.stock_items.name })) });
}));

router.post(
  "/reposicoes",
  requirePerm("estoque.repor.solicitar"),
  validate(z.object({
    itemId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    qty: z.number().int().min(1).max(100000),
    notes: z.string().trim().max(500).optional(),
  })),
  asyncHandler(async (req, res) => {
    const item = await prisma.stock_items.findUnique({ where: { id: req.body.itemId } });
    if (!item) notFound("Item não encontrado.");
    const row = await prisma.replenishments.create({
      data: { item_id: item.id, qty: req.body.qty, status: "solicitada", requester_id: req.user.id, notes: req.body.notes ?? null },
    });
    res.status(201).json(present(row));
  }),
);

async function decide(req, status) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.replenishments.findUnique({ where: { id: req.params.id } });
    if (!current) notFound();
    if (current.status !== "solicitada") throw new HttpError(409, "Só é possível decidir uma solicitação aberta.");
    const row = await tx.replenishments.update({
      where: { id: current.id },
      data: { status, approver_id: req.user.id, decided_at: new Date() },
    });
    await audit(tx, { userId: req.user.id, action: status, entity: "reposicao", entityId: current.id, payload: {} });
    return present(row);
  });
}

router.post("/reposicoes/:id/aprovar", requirePerm("estoque.repor.aprovar"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  res.json(await decide(req, "aprovada"));
}));

router.post("/reposicoes/:id/recusar", requirePerm("estoque.repor.aprovar"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  res.json(await decide(req, "recusada"));
}));

router.post("/reposicoes/:id/receber", requirePerm("estoque.manage"), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const row = await prisma.$transaction(async (tx) => {
    const current = await tx.replenishments.findUnique({ where: { id: req.params.id } });
    if (!current) notFound();
    if (current.status !== "aprovada") throw new HttpError(409, "A reposição precisa estar aprovada para o recebimento.");
    const item = await tx.stock_items.update({ where: { id: current.item_id }, data: { qty: { increment: current.qty } } });
    await tx.stock_movements.create({
      data: { item_id: item.id, type: "entrada", qty: current.qty, balance_after: item.qty, reason: `Recebimento da reposição ${current.id}`, author_id: req.user.id },
    });
    return tx.replenishments.update({ where: { id: current.id }, data: { status: "recebida", received_at: new Date() } });
  });
  res.json(present(row));
}));

export default router;

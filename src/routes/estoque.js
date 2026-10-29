import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../db/helpers.js";
import { CATEGORIAS, ensureLocal, idempotencyKey, registrarEntrada, vincularLocal } from "../db/grupo2.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { uuidParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth, requirePerm("modulo.estoque"));

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

router.get("/itens", asyncHandler(async (_req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT p.id, p.nome, p.categoria::text AS categoria, p.unidade, p.ativo,
           coalesce(sum(l.saldo), 0)::float8 AS saldo,
           coalesce(min(e.quantidade_minima), 0)::float8 AS quantidade_minima,
           exists (SELECT 1 FROM grupo2.estoque_abaixo_minimo v WHERE v.produto_id = p.id) AS abaixo_do_minimo
    FROM grupo2.produto p
    LEFT JOIN grupo2.produto_local_estoque e ON e.produto_id = p.id
    LEFT JOIN grupo2.lote_estoque l ON l.produto_id = p.id
    GROUP BY p.id
    ORDER BY p.nome
  `;
  res.json({
    data: rows.map((row) => present({ ...row, below_min: row.abaixo_do_minimo })),
  });
}));

router.post(
  "/itens",
  requirePerm("estoque.manage"),
  validate(z.object({
    name: z.string().trim().min(2).max(160),
    category: z.enum(CATEGORIAS),
    unit: z.string().trim().min(1).max(30),
    minQty: z.number().min(0).max(1000000),
    location: z.string().trim().min(2).max(80),
    qty: z.number().min(0).max(1000000).optional(),
    lotCode: z.string().trim().min(2).max(40).optional(),
    expiry: dia.nullable().optional(),
    form: z.string().trim().min(2).max(80).optional(),
    strength: z.string().trim().min(1).max(40).optional(),
  })),
  asyncHandler(async (req, res) => {
    const qty = req.body.qty ?? 0;
    if (req.body.category === "medicamento" && !req.body.form) throw new HttpError(422, "Medicamento exige apresentação.");
    const created = await prisma.$transaction(async (tx) => {
      const local = await ensureLocal(tx, req.body.location, "outro");
      const produto = await tx.$queryRaw`
        INSERT INTO grupo2.produto (nome, categoria, unidade)
        VALUES (${req.body.name}, ${req.body.category}::grupo2.categoria_produto, ${req.body.unit})
        RETURNING id, nome, categoria::text AS categoria, unidade
      `;
      if (req.body.category === "medicamento") {
        await tx.$executeRaw`
          INSERT INTO grupo2.medicamento (produto_id, apresentacao, concentracao, principio_ativo)
          VALUES (${produto[0].id}::uuid, ${req.body.form}, ${req.body.strength ?? null}, ${null})
        `;
      }
      await vincularLocal(tx, produto[0].id, local.id, req.body.minQty);
      let loteId = null;
      if (qty > 0) {
        const entrada = await registrarEntrada(tx, {
          produtoId: produto[0].id,
          localId: local.id,
          codigo: req.body.lotCode ?? `INI-${Date.now()}`,
          validade: req.body.expiry ?? null,
          fornecedor: null,
          quantidade: qty,
          motivo: "Saldo inicial",
          responsavelRef: req.user.ref,
        });
        loteId = entrada.lote.id;
      }
      return { ...produto[0], lote_id: loteId, saldo: qty, quantidade_minima: req.body.minQty };
    });
    res.status(201).json(present(created));
  }),
);

router.get("/movimentacoes", asyncHandler(async (_req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT m.id, m.lote_id, m.produto_id, p.nome AS produto_nome, m.local_id, m.tipo::text AS tipo,
           m.quantidade::float8 AS quantidade, m.variacao::float8 AS variacao, m.saldo_apos::float8 AS saldo_apos,
           m.motivo, m.ocorrido_em
    FROM grupo2.movimentacao_estoque m
    JOIN grupo2.produto p ON p.id = m.produto_id
    ORDER BY m.ocorrido_em DESC
    LIMIT 200
  `;
  res.json({ data: present(rows) });
}));

router.post(
  "/movimentacoes",
  requirePerm("estoque.movimentar"),
  validate(z.object({
    loteId: z.string().uuid(),
    type: z.enum(["entrada", "saida", "descarte"]),
    qty: z.number().positive().max(1000000),
    reason: z.string().trim().min(3).max(200),
  })),
  asyncHandler(async (req, res) => {
    const variacao = req.body.type === "entrada" ? req.body.qty : -req.body.qty;
    const created = await prisma.$transaction(async (tx) => {
      const lote = await tx.$queryRaw`
        SELECT id, produto_id, local_id FROM grupo2.lote_estoque WHERE id = ${req.body.loteId}::uuid
      `;
      if (!lote[0]) notFound("Lote não encontrado.");
      const rows = await tx.$queryRaw`
        INSERT INTO grupo2.movimentacao_estoque (
          produto_id, local_id, lote_id, tipo, quantidade, variacao, motivo, responsavel_ref, chave_idempotencia
        ) VALUES (
          ${lote[0].produto_id}::uuid,
          ${lote[0].local_id}::uuid,
          ${lote[0].id}::uuid,
          ${req.body.type}::grupo2.tipo_movimentacao,
          ${req.body.qty},
          ${variacao},
          ${req.body.reason},
          ${req.user.ref}::uuid,
          ${idempotencyKey()}
        )
        RETURNING id, lote_id, tipo::text AS tipo, quantidade::float8 AS quantidade, saldo_apos::float8 AS saldo_apos, motivo
      `;
      await audit(tx, {
        userId: req.user.id,
        action: req.body.type,
        entity: "estoque",
        entityId: rows[0].id,
        payload: { qty: req.body.qty, balance: rows[0].saldo_apos },
      });
      return rows[0];
    });
    res.status(201).json(present(created));
  }),
);

router.post(
  "/inventarios",
  requirePerm("estoque.inventario"),
  validate(z.object({
    titulo: z.string().trim().min(1).max(160),
    lines: z.array(z.object({
      loteId: z.string().uuid(),
      quantidadeContada: z.number().min(0).max(1000000),
      justificativa: z.string().trim().min(1).max(500).optional(),
    })).min(1).max(200),
  })),
  asyncHandler(async (req, res) => {
    const ids = req.body.lines.map((line) => line.loteId);
    if (new Set(ids).size !== ids.length) throw new HttpError(422, "Lote repetido no inventário.");
    const created = await prisma.$transaction(async (tx) => {
      const inventario = await tx.$queryRaw`
        INSERT INTO grupo2.inventario (titulo, responsavel_ref)
        VALUES (${req.body.titulo}, ${req.user.ref}::uuid)
        RETURNING id
      `;
      for (const line of req.body.lines) {
        const lote = await tx.$queryRaw`SELECT id FROM grupo2.lote_estoque WHERE id = ${line.loteId}::uuid`;
        if (!lote[0]) notFound("Lote não encontrado.");
        await tx.$executeRaw`
          INSERT INTO grupo2.item_inventario (inventario_id, lote_id, quantidade_sistema, quantidade_contada, justificativa)
          VALUES (
            ${inventario[0].id}::uuid,
            ${line.loteId}::uuid,
            0,
            ${line.quantidadeContada},
            ${line.justificativa ?? null}
          )
        `;
      }
      const fechado = await tx.$queryRaw`
        UPDATE grupo2.inventario
        SET situacao = 'concluida'::grupo2.situacao_inventario
        WHERE id = ${inventario[0].id}::uuid
        RETURNING id, titulo, situacao::text AS situacao, encerrado_em
      `;
      return fechado[0];
    });
    res.status(201).json(present(created));
  }),
);

export default router;

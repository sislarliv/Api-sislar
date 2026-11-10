// US-065 — Tipos de atendimento e serviços.
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { categoria, duracaoMin, idParam, texto } from "../../grupo3/validacao.js";

const router = Router();

const corpo = z.object({
  nome: z.string().trim().min(2).max(120),
  categoria,
  descricao: texto(1000).nullish(),
  duracaoPadraoMin: duracaoMin,
  exigeMotivoCancelamento: z.boolean().default(true),
  exigeMotivoReagendamento: z.boolean().default(true),
  permiteSobreposicao: z.boolean().default(false),
  toleranciaRealizacaoMin: z.number().int().min(0).max(1440).default(60),
  // null = usa o padrão da instituição (grupo3.configuracao); [] = sem lembretes.
  antecedenciasLembreteMin: z.array(z.number().int().min(5).max(10080)).max(5).nullable().default(null)
    .transform((lista) => (lista ? [...new Set(lista)].sort((a, b) => b - a) : null)),
});

function paraTipo(row) {
  return {
    id: row.id,
    nome: row.nome,
    categoria: row.categoria,
    descricao: row.descricao,
    duracaoPadraoMin: row.duracao_padrao_min,
    exigeMotivoCancelamento: row.exige_motivo_cancelamento,
    exigeMotivoReagendamento: row.exige_motivo_reagendamento,
    permiteSobreposicao: row.permite_sobreposicao,
    toleranciaRealizacaoMin: row.tolerancia_realizacao_min,
    antecedenciasLembreteMin: row.antecedencias_lembrete_min,
    ativo: row.ativo,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

const colunas = `id, nome, categoria::text AS categoria, descricao, duracao_padrao_min,
  exige_motivo_cancelamento, exige_motivo_reagendamento, permite_sobreposicao, tolerancia_realizacao_min,
  antecedencias_lembrete_min, ativo, criado_em, atualizado_em`;

async function buscar(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`SELECT ${colunas} FROM grupo3.tipo_atendimento WHERE id = $1::uuid`, id);
  return rows[0] ? paraTipo(rows[0]) : null;
}

async function nomeEmUso(db, nome, ignorarId = null) {
  const rows = await db.$queryRaw`
    SELECT 1 FROM grupo3.tipo_atendimento
    WHERE lower(nome) = lower(${nome}) AND (${ignorarId}::uuid IS NULL OR id <> ${ignorarId}::uuid)
  `;
  return rows.length > 0;
}

router.get(
  "/tipos-atendimento",
  requirePerm("agenda.visualizar", "agenda.administrar"),
  validate(pageSchema.extend({
    categoria: categoria.optional(),
    ativo: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, categoria: cat, ativo } = req.query;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${colunas}, count(*) OVER()::int AS total FROM grupo3.tipo_atendimento
       WHERE ($1::text IS NULL OR categoria::text = $1) AND ($2::boolean IS NULL OR ativo = $2)
       ORDER BY nome LIMIT $3 OFFSET $4`,
      cat ?? null, ativo ?? null, limit, (page - 1) * limit,
    );
    res.json({ data: rows.map(paraTipo), meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

router.get(
  "/tipos-atendimento/:id",
  requirePerm("agenda.visualizar", "agenda.administrar"),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const tipo = await buscar(req.params.id);
    if (!tipo) notFound("Tipo de atendimento não encontrado.");
    res.json(tipo);
  }),
);

router.post(
  "/tipos-atendimento",
  requirePerm("agenda.administrar"),
  validate(corpo),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const tipo = await prisma.$transaction(async (tx) => {
      if (await nomeEmUso(tx, b.nome)) throw new HttpError(409, "Já existe um tipo de atendimento com esse nome.");
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.tipo_atendimento (
          nome, categoria, descricao, duracao_padrao_min,
          exige_motivo_cancelamento, exige_motivo_reagendamento, permite_sobreposicao, tolerancia_realizacao_min, antecedencias_lembrete_min
        ) VALUES (
          ${b.nome}, ${b.categoria}::grupo3.categoria_atendimento, ${b.descricao ?? null}, ${b.duracaoPadraoMin},
          ${b.exigeMotivoCancelamento}, ${b.exigeMotivoReagendamento}, ${b.permiteSobreposicao}, ${b.toleranciaRealizacaoMin},
          ${b.antecedenciasLembreteMin}::integer[]
        ) RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "tipo_atendimento.criar", entity: "grupo3.tipo_atendimento",
        entityId: rows[0].id, payload: { resultado: "sucesso", ...b },
      });
      return buscar(rows[0].id, tx);
    });
    res.status(201).json(tipo);
  }),
);

router.put(
  "/tipos-atendimento/:id",
  requirePerm("agenda.administrar"),
  validate(idParam, "params"),
  validate(corpo),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const tipo = await prisma.$transaction(async (tx) => {
      const atual = await buscar(req.params.id, tx);
      if (!atual) notFound("Tipo de atendimento não encontrado.");
      if (await nomeEmUso(tx, b.nome, atual.id)) throw new HttpError(409, "Já existe um tipo de atendimento com esse nome.");
      await tx.$executeRaw`
        UPDATE grupo3.tipo_atendimento SET
          nome = ${b.nome},
          categoria = ${b.categoria}::grupo3.categoria_atendimento,
          descricao = ${b.descricao ?? null},
          duracao_padrao_min = ${b.duracaoPadraoMin},
          exige_motivo_cancelamento = ${b.exigeMotivoCancelamento},
          exige_motivo_reagendamento = ${b.exigeMotivoReagendamento},
          permite_sobreposicao = ${b.permiteSobreposicao},
          tolerancia_realizacao_min = ${b.toleranciaRealizacaoMin},
          antecedencias_lembrete_min = ${b.antecedenciasLembreteMin}::integer[]
        WHERE id = ${atual.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "tipo_atendimento.editar", entity: "grupo3.tipo_atendimento",
        entityId: atual.id, payload: { resultado: "sucesso", anterior: atual, novo: b },
      });
      return buscar(atual.id, tx);
    });
    res.json(tipo);
  }),
);

router.patch(
  "/tipos-atendimento/:id/status",
  requirePerm("agenda.administrar"),
  validate(idParam, "params"),
  validate(z.object({ ativo: z.boolean() })),
  asyncHandler(async (req, res) => {
    const tipo = await prisma.$transaction(async (tx) => {
      const atual = await buscar(req.params.id, tx);
      if (!atual) notFound("Tipo de atendimento não encontrado.");
      await tx.$executeRaw`UPDATE grupo3.tipo_atendimento SET ativo = ${req.body.ativo} WHERE id = ${atual.id}::uuid`;
      await audit(tx, {
        userId: req.user.id, action: req.body.ativo ? "tipo_atendimento.ativar" : "tipo_atendimento.inativar",
        entity: "grupo3.tipo_atendimento", entityId: atual.id, payload: { resultado: "sucesso" },
      });
      return buscar(atual.id, tx);
    });
    res.json(tipo);
  }),
);

export default router;

// Catálogo de especialidades/áreas da equipe. É a chave da cobertura da escala (US-084) e do cadastro de
// profissionais (US-082). Sem exclusão física: inativar.
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { idParam } from "../../grupo3/validacao.js";

const router = Router();

const LER = ["equipe.visualizar", "equipe.administrar", "agenda.visualizar", "agenda.criar", "atendimento-clinico.visualizar"];

function paraEspecialidade(row) {
  return { id: row.id, nome: row.nome, ativo: row.ativo, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em };
}

async function buscar(id, db = prisma) {
  const rows = await db.$queryRaw`SELECT id, nome, ativo, criado_em, atualizado_em FROM grupo3.especialidade WHERE id = ${id}::uuid`;
  return rows[0] ? paraEspecialidade(rows[0]) : null;
}

async function nomeEmUso(db, nome, ignorarId = null) {
  const rows = await db.$queryRaw`
    SELECT 1 FROM grupo3.especialidade
    WHERE lower(btrim(nome)) = lower(btrim(${nome})) AND (${ignorarId}::uuid IS NULL OR id <> ${ignorarId}::uuid)
  `;
  return rows.length > 0;
}

/**
 * Confere que a especialidade existe e está ativa. Usado por colaborador, escala e cobertura.
 * Lança 422 apontando o campo informado.
 */
export async function exigirEspecialidadeAtiva(db, id, campo = "especialidadeId") {
  if (!id) return null;
  const rows = await db.$queryRaw`SELECT id, nome, ativo FROM grupo3.especialidade WHERE id = ${id}::uuid`;
  if (!rows[0]) throw new HttpError(422, "Dados inválidos", [{ path: campo, message: "Especialidade não encontrada." }]);
  if (!rows[0].ativo) throw new HttpError(422, "Dados inválidos", [{ path: campo, message: "Especialidade inativa." }]);
  return rows[0];
}

const corpo = z.object({ nome: z.string().trim().min(2).max(80) });

router.get(
  "/especialidades",
  requirePerm(...LER),
  validate(pageSchema.extend({
    ativo: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, ativo } = req.query;
    const rows = await prisma.$queryRaw`
      SELECT id, nome, ativo, criado_em, atualizado_em, count(*) OVER()::int AS total
      FROM grupo3.especialidade
      WHERE (${ativo ?? null}::boolean IS NULL OR ativo = ${ativo ?? null}::boolean)
      ORDER BY lower(nome)
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `;
    res.json({ data: rows.map(paraEspecialidade), meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

router.get("/especialidades/:id", requirePerm(...LER), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const especialidade = await buscar(req.params.id);
  if (!especialidade) notFound("Especialidade não encontrada.");
  res.json(especialidade);
}));

router.post(
  "/especialidades",
  requirePerm("equipe.administrar"),
  validate(corpo),
  asyncHandler(async (req, res) => {
    const especialidade = await prisma.$transaction(async (tx) => {
      if (await nomeEmUso(tx, req.body.nome)) throw new HttpError(409, "Já existe uma especialidade com esse nome.");
      const rows = await tx.$queryRaw`INSERT INTO grupo3.especialidade (nome) VALUES (${req.body.nome}) RETURNING id`;
      await audit(tx, {
        userId: req.user.id, action: "especialidade.criar", entity: "grupo3.especialidade", entityId: rows[0].id,
        payload: { resultado: "sucesso", nome: req.body.nome },
      });
      return buscar(rows[0].id, tx);
    });
    res.status(201).json(especialidade);
  }),
);

router.put(
  "/especialidades/:id",
  requirePerm("equipe.administrar"),
  validate(idParam, "params"),
  validate(corpo),
  asyncHandler(async (req, res) => {
    const especialidade = await prisma.$transaction(async (tx) => {
      const atual = await buscar(req.params.id, tx);
      if (!atual) notFound("Especialidade não encontrada.");
      if (await nomeEmUso(tx, req.body.nome, atual.id)) throw new HttpError(409, "Já existe uma especialidade com esse nome.");
      await tx.$executeRaw`UPDATE grupo3.especialidade SET nome = ${req.body.nome} WHERE id = ${atual.id}::uuid`;
      await audit(tx, {
        userId: req.user.id, action: "especialidade.editar", entity: "grupo3.especialidade", entityId: atual.id,
        payload: { resultado: "sucesso", anterior: atual.nome, novo: req.body.nome },
      });
      return buscar(atual.id, tx);
    });
    res.json(especialidade);
  }),
);

router.patch(
  "/especialidades/:id/status",
  requirePerm("equipe.administrar"),
  validate(idParam, "params"),
  validate(z.object({ ativo: z.boolean() })),
  asyncHandler(async (req, res) => {
    const especialidade = await prisma.$transaction(async (tx) => {
      const atual = await buscar(req.params.id, tx);
      if (!atual) notFound("Especialidade não encontrada.");
      await tx.$executeRaw`UPDATE grupo3.especialidade SET ativo = ${req.body.ativo} WHERE id = ${atual.id}::uuid`;
      await audit(tx, {
        userId: req.user.id, action: req.body.ativo ? "especialidade.ativar" : "especialidade.inativar",
        entity: "grupo3.especialidade", entityId: atual.id, payload: { resultado: "sucesso" },
      });
      return buscar(atual.id, tx);
    });
    res.json(especialidade);
  }),
);

export default router;

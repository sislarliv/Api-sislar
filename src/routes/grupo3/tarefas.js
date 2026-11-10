// E10 — Tarefas: criar e distribuir (US-094), atualizar status com histórico (US-095) e acompanhar as
// atrasadas (US-096). "Atrasada" é derivado: prazo vencido e status pendente ou em_andamento.
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { likeTerm } from "../../lib/schemas.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { colaboradorDoUsuario } from "../../grupo3/agenda.js";
import { transicaoTarefaValida } from "../../grupo3/regras.js";
import { dataHora, idParam, temPermissao, uuid } from "../../grupo3/validacao.js";

const router = Router();

const VER = "tarefas.visualizar";
const ADMIN = "tarefas.administrar";
const opcional = (schema) => schema.nullish().transform((value) => value ?? null);
const prioridade = z.enum(["baixa", "media", "alta", "urgente"]);
const status = z.enum(["pendente", "em_andamento", "concluida", "cancelada"]);

function erroCampo(path, message) {
  return new HttpError(422, "Dados inválidos", [{ path, message }]);
}

const selectTarefa = `
  SELECT t.id, t.titulo, t.descricao, t.prazo, t.prioridade::text AS prioridade, t.status::text AS status, t.concluida_em,
         t.criado_em, t.atualizado_em, t.criado_por_ref,
         t.status IN ('pendente','em_andamento') AND t.prazo < now() AS atrasada,
         c.id AS responsavel_id, c.nome AS responsavel_nome, c.usuario_ref AS responsavel_usuario_ref,
         u.id AS criado_por_id, u.name AS criado_por_nome
  FROM grupo3.tarefa t
  JOIN grupo3.colaborador c ON c.id = t.responsavel_id
  LEFT JOIN public.users u ON u.ref = t.criado_por_ref
`;

function paraTarefa(row) {
  return {
    id: row.id,
    titulo: row.titulo,
    descricao: row.descricao,
    responsavel: { id: row.responsavel_id, nome: row.responsavel_nome },
    prazo: row.prazo,
    prioridade: row.prioridade,
    status: row.status,
    atrasada: row.atrasada === true,
    concluidaEm: row.concluida_em,
    criadoPor: row.criado_por_id ? { id: row.criado_por_id, nome: row.criado_por_nome } : null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function buscarTarefa(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectTarefa} WHERE t.id = $1::uuid`, id);
  if (!rows[0]) return null;
  return { ...paraTarefa(rows[0]), criadoPorRef: rows[0].criado_por_ref, responsavelUsuarioRef: rows[0].responsavel_usuario_ref };
}

function publica(tarefa) {
  const { criadoPorRef, responsavelUsuarioRef, ...resto } = tarefa;
  return resto;
}

async function historicoDaTarefa(id, db = prisma) {
  const rows = await db.$queryRaw`
    SELECT h.id, h.evento, h.status_anterior::text AS status_anterior, h.status_novo::text AS status_novo, h.observacao, h.em,
           u.id AS autor_id, u.name AS autor_nome
    FROM grupo3.historico_tarefa h LEFT JOIN public.users u ON u.ref = h.autor_ref
    WHERE h.tarefa_id = ${id}::uuid ORDER BY h.em, h.id
  `;
  return rows.map((row) => ({
    id: row.id, evento: row.evento, statusAnterior: row.status_anterior, statusNovo: row.status_novo, observacao: row.observacao, em: row.em,
    autor: row.autor_id ? { id: row.autor_id, nome: row.autor_nome } : null,
  }));
}

async function exigirResponsavelAtivo(db, id) {
  const rows = await db.$queryRaw`SELECT status::text AS status FROM grupo3.colaborador WHERE id = ${id}::uuid`;
  if (!rows[0]) throw erroCampo("responsavelId", "Responsável não encontrado.");
  if (rows[0].status !== "ativo") throw erroCampo("responsavelId", "Responsável inativo.");
}

const filtros = pageSchema.extend({
  responsavelId: uuid.optional(),
  status: status.optional(),
  prioridade: prioridade.optional(),
  atrasadas: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  prazoAte: dataHora.optional(),
  q: z.string().trim().min(1).max(80).optional(),
});

async function listarTarefas({ page, limit, responsavelId, status: st, prioridade: pr, atrasadas, prazoAte, q }) {
  const rows = await prisma.$queryRawUnsafe(
    `${selectTarefa.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
     WHERE ($1::uuid IS NULL OR t.responsavel_id = $1::uuid)
       AND ($2::text IS NULL OR t.status::text = $2)
       AND ($3::text IS NULL OR t.prioridade::text = $3)
       AND ($4::boolean IS NULL OR (t.status IN ('pendente','em_andamento') AND t.prazo < now()) = $4)
       AND ($5::timestamptz IS NULL OR t.prazo <= $5::timestamptz)
       AND ($6::text IS NULL OR t.titulo ILIKE $6)
     ORDER BY t.status IN ('concluida','cancelada'), t.prazo, t.prioridade DESC LIMIT $7 OFFSET $8`,
    responsavelId ?? null, st ?? null, pr ?? null, atrasadas ?? null, prazoAte ?? null, q ? likeTerm(q) : null,
    limit, (page - 1) * limit,
  );
  return { data: rows.map(paraTarefa), meta: pageMeta(page, limit, rows[0]?.total ?? 0) };
}

router.get("/tarefas", requirePerm(VER), validate(filtros, "query"), asyncHandler(async (req, res) => {
  res.json(await listarTarefas(req.query));
}));

// Tarefas do colaborador vinculado ao usuário logado.
router.get("/me/tarefas", requirePerm(VER), validate(filtros.omit({ responsavelId: true }), "query"), asyncHandler(async (req, res) => {
  const colaborador = await colaboradorDoUsuario(req.user);
  if (!colaborador) notFound("Seu usuário não está vinculado a um colaborador da equipe.");
  res.json(await listarTarefas({ ...req.query, responsavelId: colaborador.id }));
}));

router.get("/tarefas/:id", requirePerm(VER), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const tarefa = await buscarTarefa(req.params.id);
  if (!tarefa) notFound("Tarefa não encontrada.");
  res.json({ ...publica(tarefa), historico: await historicoDaTarefa(tarefa.id) });
}));

const corpoTarefa = z.object({
  titulo: z.string().trim().min(3).max(160),
  descricao: opcional(z.string().trim().min(1).max(4000)),
  responsavelId: uuid,
  prazo: dataHora,
  prioridade: prioridade.default("media"),
});

router.post(
  "/tarefas",
  requirePerm("tarefas.criar"),
  validate(corpoTarefa),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const id = await prisma.$transaction(async (tx) => {
      await exigirResponsavelAtivo(tx, b.responsavelId);
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.tarefa (titulo, descricao, responsavel_id, prazo, prioridade, criado_por_ref)
        VALUES (${b.titulo}, ${b.descricao}, ${b.responsavelId}::uuid, ${b.prazo}, ${b.prioridade}::grupo3.prioridade_tarefa, ${req.user.ref}::uuid)
        RETURNING id
      `;
      await tx.$executeRaw`
        INSERT INTO grupo3.historico_tarefa (tarefa_id, evento, status_anterior, status_novo, observacao, autor_ref)
        VALUES (${rows[0].id}::uuid, 'criada', NULL, 'pendente', 'Tarefa criada.', ${req.user.ref}::uuid)
      `;
      await audit(tx, {
        userId: req.user.id, action: "tarefa.criar", entity: "grupo3.tarefa", entityId: rows[0].id,
        payload: { resultado: "sucesso", responsavelId: b.responsavelId, prazo: b.prazo, prioridade: b.prioridade },
      });
      return rows[0].id;
    });
    const tarefa = await buscarTarefa(id);
    res.status(201).json({ ...publica(tarefa), historico: await historicoDaTarefa(id) });
  }),
);

// Editar os dados da tarefa: quem criou (com tarefas.criar) ou tarefas.administrar.
router.put(
  "/tarefas/:id",
  requirePerm("tarefas.criar", ADMIN),
  validate(idParam, "params"),
  validate(corpoTarefa),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const atual = await buscarTarefa(req.params.id, tx);
      if (!atual) notFound("Tarefa não encontrada.");
      if (atual.criadoPorRef !== req.user.ref && !temPermissao(req.user, ADMIN)) {
        throw new HttpError(403, "Só quem criou a tarefa (ou a administração de tarefas) altera os dados.");
      }
      if (["concluida", "cancelada"].includes(atual.status)) throw new HttpError(409, "Tarefa concluída ou cancelada não pode ser alterada.");
      if (b.responsavelId !== atual.responsavel.id) await exigirResponsavelAtivo(tx, b.responsavelId);
      await tx.$executeRaw`
        UPDATE grupo3.tarefa
        SET titulo = ${b.titulo}, descricao = ${b.descricao}, responsavel_id = ${b.responsavelId}::uuid, prazo = ${b.prazo},
            prioridade = ${b.prioridade}::grupo3.prioridade_tarefa
        WHERE id = ${atual.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "tarefa.editar", entity: "grupo3.tarefa", entityId: atual.id,
        payload: {
          resultado: "sucesso",
          anterior: { responsavelId: atual.responsavel.id, prazo: atual.prazo, prioridade: atual.prioridade },
          novo: { responsavelId: b.responsavelId, prazo: b.prazo, prioridade: b.prioridade },
        },
      });
    });
    const tarefa = await buscarTarefa(req.params.id);
    res.json({ ...publica(tarefa), historico: await historicoDaTarefa(tarefa.id) });
  }),
);

// US-095 — status pelo responsável (usuario_ref do colaborador) ou por tarefas.administrar.
router.patch(
  "/tarefas/:id/status",
  requirePerm("tarefas.editar", ADMIN),
  validate(idParam, "params"),
  validate(z.object({ status, observacao: opcional(z.string().trim().min(1).max(1000)) })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM grupo3.tarefa WHERE id = ${req.params.id}::uuid FOR UPDATE`;
      const atual = await buscarTarefa(req.params.id, tx);
      if (!atual) notFound("Tarefa não encontrada.");
      const responsavel = atual.responsavelUsuarioRef && atual.responsavelUsuarioRef === req.user.ref;
      if (!responsavel && !temPermissao(req.user, ADMIN)) {
        throw new HttpError(403, "Só o responsável pela tarefa (ou a administração de tarefas) altera o status.");
      }
      if (["concluida", "cancelada"].includes(atual.status)) throw new HttpError(409, `Tarefa já ${atual.status}.`);
      if (!transicaoTarefaValida(atual.status, b.status)) throw erroCampo("status", `A tarefa já está ${atual.status.replace("_", " ")}.`);
      await tx.$executeRaw`
        UPDATE grupo3.tarefa
        SET status = ${b.status}::grupo3.status_tarefa, concluida_em = ${b.status === "concluida" ? new Date() : null}
        WHERE id = ${atual.id}::uuid
      `;
      await tx.$executeRaw`
        INSERT INTO grupo3.historico_tarefa (tarefa_id, status_anterior, status_novo, observacao, autor_ref)
        VALUES (${atual.id}::uuid, ${atual.status}::grupo3.status_tarefa, ${b.status}::grupo3.status_tarefa, ${b.observacao}, ${req.user.ref}::uuid)
      `;
      await audit(tx, {
        userId: req.user.id, action: "tarefa.status", entity: "grupo3.tarefa", entityId: atual.id,
        payload: { resultado: "sucesso", anterior: atual.status, novo: b.status, comoResponsavel: Boolean(responsavel) },
      });
    });
    const tarefa = await buscarTarefa(req.params.id);
    res.json({ ...publica(tarefa), historico: await historicoDaTarefa(tarefa.id) });
  }),
);

// Reabrir tarefa concluída ou cancelada: só tarefas.administrar, com motivo; "reaberta" no histórico imutável.
// O banco só aceita a mudança com grupo3.reabertura_tarefa ligado nesta transação.
router.post(
  "/tarefas/:id/reabrir",
  requirePerm(ADMIN),
  validate(idParam, "params"),
  validate(z.object({
    motivo: z.string().trim().min(3, "Informe o motivo com ao menos 3 caracteres.").max(1000),
    prazo: dataHora.optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM grupo3.tarefa WHERE id = ${req.params.id}::uuid FOR UPDATE`;
      const atual = await buscarTarefa(req.params.id, tx);
      if (!atual) notFound("Tarefa não encontrada.");
      if (!["concluida", "cancelada"].includes(atual.status)) throw new HttpError(409, "Só tarefa concluída ou cancelada pode ser reaberta.");
      await tx.$queryRaw`SELECT set_config('grupo3.reabertura_tarefa', 'on', true)`;
      await tx.$executeRaw`
        UPDATE grupo3.tarefa SET status = 'pendente', concluida_em = NULL, prazo = ${b.prazo ?? atual.prazo}
        WHERE id = ${atual.id}::uuid
      `;
      await tx.$queryRaw`SELECT set_config('grupo3.reabertura_tarefa', 'off', true)`;
      await tx.$executeRaw`
        INSERT INTO grupo3.historico_tarefa (tarefa_id, evento, status_anterior, status_novo, observacao, autor_ref)
        VALUES (${atual.id}::uuid, 'reaberta', ${atual.status}::grupo3.status_tarefa, 'pendente', ${b.motivo}, ${req.user.ref}::uuid)
      `;
      await audit(tx, {
        userId: req.user.id, action: "tarefa.reabrir", entity: "grupo3.tarefa", entityId: atual.id,
        payload: { resultado: "sucesso", anterior: atual.status, prazo: b.prazo ?? null },
      });
    });
    const tarefa = await buscarTarefa(req.params.id);
    res.json({ ...publica(tarefa), historico: await historicoDaTarefa(tarefa.id) });
  }),
);

export default router;

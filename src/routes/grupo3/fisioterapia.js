// E08 — Fisioterapia: plano (US-075), atividades (US-076), execução por sessão (US-077), evolução do plano
// (US-078), rotina semanal e programação (US-079) e indicadores (US-080).
// Sessão = agendamento de categoria fisioterapia com plano_fisioterapia_id. Leitura de dados clínicos auditada.
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { asyncHandler } from "../../middleware/async.js";
import { loadUser, requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { buscarAgendamento, colaboradorDoUsuario, listarAgendamentos, mascararLista, periodoAgenda } from "../../grupo3/agenda.js";
import { auditarLeitura } from "../../grupo3/auditoria.js";
import { buscarIdoso, buscarIdososPorRef } from "../../grupo3/portas/idosos.js";
import { podePublicar, podeVerIdoso } from "../../grupo3/portas/prontuario.js";
import { cargaPorDia, diasDaSemana, podeRegistrarRealizacao, taxa } from "../../grupo3/regras.js";
import {
  conteudoFlexivel, dia, duracaoMin, exigirPermissao, horario, idParam, idosoId, uuid,
} from "../../grupo3/validacao.js";
import { auditarRecusa, criarAgendamento, exigirIdosoAtivo } from "./agendamentos.js";
import { publicarSePermitido } from "./clinico.js";

const router = Router();

const VER = "fisioterapia.visualizar";
const CRIAR = "fisioterapia.criar";
const EDITAR = "fisioterapia.editar";
const ADMIN = "fisioterapia.administrar";
const opcional = (schema) => schema.nullish().transform((value) => value ?? null);

function erroCampo(path, message) {
  return new HttpError(422, "Dados inválidos", [{ path, message }]);
}

async function hojeInstitucional(db = prisma) {
  const rows = await db.$queryRaw`SELECT to_char((now() AT TIME ZONE grupo3.fuso_horario())::date, 'YYYY-MM-DD') AS hoje`;
  return rows[0].hoje;
}

async function idosoVisivel(req, idosoIdParam) {
  const idoso = await buscarIdoso(idosoIdParam);
  if (!idoso) notFound("Idoso não encontrado.");
  if (!(await podeVerIdoso(req.user, idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
  return idoso;
}

// ============================ Plano (US-075) ============================

const selectPlano = `
  SELECT p.id, p.idoso_ref, p.objetivo, to_char(p.data_inicio, 'YYYY-MM-DD') AS data_inicio,
         to_char(p.data_fim, 'YYYY-MM-DD') AS data_fim, p.frequencia_semanal, p.observacoes, p.situacao::text AS situacao,
         p.situacao = 'ativo' AND p.data_inicio <= (now() AT TIME ZONE grupo3.fuso_horario())::date
           AND (p.data_fim IS NULL OR p.data_fim >= (now() AT TIME ZONE grupo3.fuso_horario())::date) AS vigente,
         p.criado_em, p.atualizado_em, c.id AS responsavel_id, c.nome AS responsavel_nome
  FROM grupo3.plano_fisioterapia p
  JOIN grupo3.colaborador c ON c.id = p.responsavel_id
`;

function paraPlano(row, idosos) {
  const idoso = idosos.get(row.idoso_ref);
  return {
    id: row.id,
    idoso: idoso ? { id: idoso.id, nome: idoso.nome } : null,
    responsavel: { id: row.responsavel_id, nome: row.responsavel_nome },
    objetivo: row.objetivo,
    dataInicio: row.data_inicio,
    dataFim: row.data_fim,
    frequenciaSemanal: row.frequencia_semanal,
    observacoes: row.observacoes,
    situacao: row.situacao,
    vigente: row.vigente === true,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function buscarPlano(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectPlano} WHERE p.id = $1::uuid`, id);
  if (!rows[0]) return null;
  return { ...paraPlano(rows[0], await buscarIdososPorRef([rows[0].idoso_ref], db)), idosoRef: rows[0].idoso_ref };
}

async function planoVisivel(req, id, db = prisma) {
  const plano = await buscarPlano(id, db);
  if (!plano) notFound("Plano de fisioterapia não encontrado.");
  if (!(await podeVerIdoso(req.user, plano.idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
  return plano;
}

function publico(plano) {
  const { idosoRef, ...resto } = plano;
  return resto;
}

const situacaoPlano = z.enum(["ativo", "suspenso", "concluido", "cancelado"]);
const basePlano = z.object({
  responsavelId: uuid,
  objetivo: z.string().trim().min(5).max(2000),
  dataInicio: dia,
  dataFim: opcional(dia),
  frequenciaSemanal: z.number().int().min(1).max(14),
  observacoes: opcional(z.string().trim().min(1).max(4000)),
  situacao: situacaoPlano.default("ativo"),
});
const periodoValido = [
  (b) => !b.dataFim || b.dataFim >= b.dataInicio,
  { message: "O fim do período precisa ser igual ou depois do início.", path: ["dataFim"] },
];
const corpoPlano = basePlano.refine(...periodoValido);

async function exigirResponsavelAtivo(db, id) {
  const rows = await db.$queryRaw`SELECT status::text AS status FROM grupo3.colaborador WHERE id = ${id}::uuid`;
  if (!rows[0]) throw erroCampo("responsavelId", "Responsável não encontrado.");
  if (rows[0].status !== "ativo") throw erroCampo("responsavelId", "Responsável inativo.");
}

async function listarPlanos(req, { idosoRef, situacao, responsavelId, page, limit }) {
  const rows = await prisma.$queryRawUnsafe(
    `${selectPlano.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
     WHERE ($1::uuid IS NULL OR p.idoso_ref = $1::uuid) AND ($2::text IS NULL OR p.situacao::text = $2)
       AND ($3::uuid IS NULL OR p.responsavel_id = $3::uuid)
     ORDER BY p.situacao = 'ativo' DESC, p.data_inicio DESC LIMIT $4 OFFSET $5`,
    idosoRef ?? null, situacao ?? null, responsavelId ?? null, limit, (page - 1) * limit,
  );
  const idosos = await buscarIdososPorRef(rows.map((row) => row.idoso_ref));
  const data = rows.map((row) => paraPlano(row, idosos));
  await auditarLeitura(req, { entidade: "plano_fisioterapia", rota: req.route.path, idosoIds: data.map((p) => p.idoso?.id), ids: data.map((p) => p.id) });
  return { data, meta: pageMeta(page, limit, rows[0]?.total ?? 0) };
}

router.get(
  "/fisioterapia/planos",
  requirePerm(VER),
  validate(pageSchema.extend({ idosoId: idosoId.optional(), situacao: situacaoPlano.optional(), responsavelId: uuid.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const idoso = req.query.idosoId ? await idosoVisivel(req, req.query.idosoId) : null;
    res.json(await listarPlanos(req, { ...req.query, idosoRef: idoso?.ref }));
  }),
);

router.get(
  "/idosos/:idosoId/planos-fisioterapia",
  requirePerm(VER),
  validate(z.object({ idosoId }), "params"),
  validate(pageSchema.extend({ situacao: situacaoPlano.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const idoso = await idosoVisivel(req, req.params.idosoId);
    res.json({ idoso: { id: idoso.id, nome: idoso.nome }, ...(await listarPlanos(req, { ...req.query, idosoRef: idoso.ref })) });
  }),
);

async function listarAtividades(planoId, db = prisma) {
  const rows = await db.$queryRaw`
    SELECT id, descricao, frequencia_semanal, duracao_min, intensidade, configuracao, observacoes, ativa, criado_em, atualizado_em
    FROM grupo3.atividade_fisioterapia WHERE plano_id = ${planoId}::uuid ORDER BY ativa DESC, criado_em
  `;
  return rows.map((row) => ({
    id: row.id,
    descricao: row.descricao,
    frequenciaSemanal: row.frequencia_semanal,
    duracaoMin: row.duracao_min,
    intensidade: row.intensidade,
    configuracao: row.configuracao,
    observacoes: row.observacoes,
    ativa: row.ativa,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  }));
}

router.get("/fisioterapia/planos/:id", requirePerm(VER), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const plano = await planoVisivel(req, req.params.id);
  await auditarLeitura(req, { entidade: "plano_fisioterapia", rota: "/fisioterapia/planos/:id", idosoIds: [plano.idoso?.id], ids: [plano.id] });
  res.json({ ...publico(plano), atividades: await listarAtividades(plano.id) });
}));

router.post(
  "/fisioterapia/planos",
  requirePerm(CRIAR),
  validate(basePlano.extend({ idosoId }).refine(...periodoValido)),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const idoso = await exigirIdosoAtivo(b.idosoId);
    const id = await prisma.$transaction(async (tx) => {
      await exigirResponsavelAtivo(tx, b.responsavelId);
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.plano_fisioterapia (idoso_ref, responsavel_id, objetivo, data_inicio, data_fim, frequencia_semanal, observacoes, situacao, criado_por_ref)
        VALUES (${idoso.ref}::uuid, ${b.responsavelId}::uuid, ${b.objetivo}, ${b.dataInicio}::date, ${b.dataFim}::date,
                ${b.frequenciaSemanal}, ${b.observacoes}, ${b.situacao}::grupo3.situacao_plano_fisioterapia, ${req.user.ref}::uuid)
        RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "plano_fisioterapia.criar", entity: "grupo3.plano_fisioterapia", entityId: rows[0].id,
        payload: { resultado: "sucesso", idosoId: idoso.id },
      });
      return rows[0].id;
    });
    res.status(201).json({ ...publico(await buscarPlano(id)), atividades: [] });
  }),
);

router.put(
  "/fisioterapia/planos/:id",
  requirePerm(EDITAR),
  validate(idParam, "params"),
  validate(corpoPlano),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const atual = await planoVisivel(req, req.params.id, tx);
      if (atual.situacao === "cancelado") throw new HttpError(409, "Plano cancelado não pode ser alterado.");
      await exigirResponsavelAtivo(tx, b.responsavelId);
      await tx.$executeRaw`
        UPDATE grupo3.plano_fisioterapia
        SET responsavel_id = ${b.responsavelId}::uuid, objetivo = ${b.objetivo}, data_inicio = ${b.dataInicio}::date,
            data_fim = ${b.dataFim}::date, frequencia_semanal = ${b.frequenciaSemanal}, observacoes = ${b.observacoes},
            situacao = ${b.situacao}::grupo3.situacao_plano_fisioterapia
        WHERE id = ${atual.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "plano_fisioterapia.editar", entity: "grupo3.plano_fisioterapia", entityId: atual.id,
        payload: { resultado: "sucesso", idosoId: atual.idoso?.id, situacao: { anterior: atual.situacao, novo: b.situacao } },
      });
    });
    res.json({ ...publico(await buscarPlano(req.params.id)), atividades: await listarAtividades(req.params.id) });
  }),
);

// ============================ Atividades (US-076) ============================

const corpoAtividade = z.object({
  descricao: z.string().trim().min(3).max(500),
  frequenciaSemanal: opcional(z.number().int().min(1).max(14)),
  duracaoMin: opcional(z.number().int().min(1).max(240)),
  intensidade: opcional(z.string().trim().min(1).max(120)),
  configuracao: conteudoFlexivel.default({}),
  observacoes: opcional(z.string().trim().min(1).max(2000)),
  ativa: z.boolean().default(true),
});

router.get("/fisioterapia/planos/:id/atividades", requirePerm(VER), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const plano = await planoVisivel(req, req.params.id);
  res.json({ planoId: plano.id, data: await listarAtividades(plano.id) });
}));

router.post(
  "/fisioterapia/planos/:id/atividades",
  requirePerm(CRIAR),
  validate(idParam, "params"),
  validate(corpoAtividade),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const atividade = await prisma.$transaction(async (tx) => {
      const plano = await planoVisivel(req, req.params.id, tx);
      if (["concluido", "cancelado"].includes(plano.situacao)) throw new HttpError(409, "Plano concluído ou cancelado não recebe atividades.");
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.atividade_fisioterapia (plano_id, descricao, frequencia_semanal, duracao_min, intensidade, configuracao, observacoes, ativa)
        VALUES (${plano.id}::uuid, ${b.descricao}, ${b.frequenciaSemanal}, ${b.duracaoMin}, ${b.intensidade},
                ${JSON.stringify(b.configuracao)}::jsonb, ${b.observacoes}, ${b.ativa})
        RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "atividade_fisioterapia.criar", entity: "grupo3.atividade_fisioterapia", entityId: rows[0].id,
        payload: { resultado: "sucesso", planoId: plano.id },
      });
      return (await listarAtividades(plano.id, tx)).find((a) => a.id === rows[0].id);
    });
    res.status(201).json(atividade);
  }),
);

router.put(
  "/fisioterapia/atividades/:id",
  requirePerm(EDITAR),
  validate(idParam, "params"),
  validate(corpoAtividade),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const atividade = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT plano_id FROM grupo3.atividade_fisioterapia WHERE id = ${req.params.id}::uuid FOR UPDATE`;
      if (!rows[0]) notFound("Atividade não encontrada.");
      const plano = await planoVisivel(req, rows[0].plano_id, tx);
      if (plano.situacao === "cancelado") throw new HttpError(409, "Plano cancelado não pode ser alterado.");
      await tx.$executeRaw`
        UPDATE grupo3.atividade_fisioterapia
        SET descricao = ${b.descricao}, frequencia_semanal = ${b.frequenciaSemanal}, duracao_min = ${b.duracaoMin},
            intensidade = ${b.intensidade}, configuracao = ${JSON.stringify(b.configuracao)}::jsonb, observacoes = ${b.observacoes},
            ativa = ${b.ativa}
        WHERE id = ${req.params.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "atividade_fisioterapia.editar", entity: "grupo3.atividade_fisioterapia", entityId: req.params.id,
        payload: { resultado: "sucesso", planoId: plano.id, ativa: b.ativa },
      });
      return (await listarAtividades(plano.id, tx)).find((a) => a.id === req.params.id);
    });
    res.json(atividade);
  }),
);

// ============================ Execução por sessão (US-077) ============================

const selectExecucao = `
  SELECT e.id, e.agendamento_id, e.status::text AS status, e.observacoes, e.registrado_em,
         a.id AS atividade_id, a.descricao AS atividade_descricao, a.plano_id,
         c.id AS profissional_id, c.nome AS profissional_nome, s.inicio AS sessao_inicio,
         u.id AS registrado_por_id, u.name AS registrado_por_nome
  FROM grupo3.execucao_atividade e
  JOIN grupo3.atividade_fisioterapia a ON a.id = e.atividade_id
  JOIN grupo3.colaborador c ON c.id = e.profissional_id
  JOIN grupo3.agendamento s ON s.id = e.agendamento_id
  LEFT JOIN public.users u ON u.ref = e.registrado_por_ref
`;

function paraExecucao(row) {
  return {
    id: row.id,
    sessao: { agendamentoId: row.agendamento_id, inicio: row.sessao_inicio },
    atividade: { id: row.atividade_id, descricao: row.atividade_descricao },
    profissional: { id: row.profissional_id, nome: row.profissional_nome },
    status: row.status,
    observacoes: row.observacoes,
    registradoEm: row.registrado_em,
    registradoPor: row.registrado_por_id ? { id: row.registrado_por_id, nome: row.registrado_por_nome } : null,
  };
}

router.post(
  "/fisioterapia/atividades/:id/execucoes",
  requirePerm(CRIAR),
  validate(idParam, "params"),
  validate(z.object({
    agendamentoId: uuid,
    status: z.enum(["realizada", "parcial", "nao_realizada"]),
    profissionalId: opcional(uuid),
    observacoes: opcional(z.string().trim().min(1).max(2000)),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const id = await prisma.$transaction(async (tx) => {
      const atividade = (await tx.$queryRaw`
        SELECT a.id, a.plano_id, a.ativa, p.situacao::text AS plano_situacao
        FROM grupo3.atividade_fisioterapia a JOIN grupo3.plano_fisioterapia p ON p.id = a.plano_id
        WHERE a.id = ${req.params.id}::uuid
      `)[0];
      if (!atividade) notFound("Atividade não encontrada.");
      await planoVisivel(req, atividade.plano_id, tx);
      if (!atividade.ativa) throw new HttpError(409, "Atividade inativa.");
      if (atividade.plano_situacao === "cancelado") throw new HttpError(409, "Plano cancelado.");
      const sessao = (await tx.$queryRaw`
        SELECT a.id, a.inicio, a.status::text AS status, a.profissional_id, a.plano_fisioterapia_id,
               t.categoria::text AS categoria, t.tolerancia_realizacao_min
        FROM grupo3.agendamento a JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
        WHERE a.id = ${b.agendamentoId}::uuid
      `)[0];
      if (!sessao) throw erroCampo("agendamentoId", "Sessão não encontrada.");
      if (sessao.categoria !== "fisioterapia") throw erroCampo("agendamentoId", "O agendamento não é sessão de fisioterapia.");
      if (sessao.plano_fisioterapia_id !== atividade.plano_id) throw erroCampo("agendamentoId", "A sessão não está ligada ao plano desta atividade.");
      // Só sessão realizada, ou agendada já dentro da tolerância do tipo.
      if (["cancelado", "nao_realizado"].includes(sessao.status)) {
        throw erroCampo("agendamentoId", "Sessão cancelada ou não realizada não recebe execução de atividade.");
      }
      if (sessao.status === "agendado" && !podeRegistrarRealizacao(sessao.inicio, sessao.tolerancia_realizacao_min)) {
        throw erroCampo("agendamentoId", `A sessão ainda não começou (tolerância de ${sessao.tolerancia_realizacao_min} min).`);
      }
      const profissionalId = b.profissionalId ?? sessao.profissional_id;
      if (b.profissionalId) {
        const existe = await tx.$queryRaw`SELECT 1 FROM grupo3.colaborador WHERE id = ${b.profissionalId}::uuid`;
        if (!existe.length) throw erroCampo("profissionalId", "Profissional não encontrado.");
      }
      const repetida = await tx.$queryRaw`
        SELECT id FROM grupo3.execucao_atividade WHERE agendamento_id = ${sessao.id}::uuid AND atividade_id = ${atividade.id}::uuid
      `;
      if (repetida[0]) throw new HttpError(409, "Esta atividade já foi registrada nesta sessão.", { execucaoId: repetida[0].id });
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.execucao_atividade (agendamento_id, atividade_id, profissional_id, status, observacoes, registrado_por_ref)
        VALUES (${sessao.id}::uuid, ${atividade.id}::uuid, ${profissionalId}::uuid, ${b.status}::grupo3.status_execucao_atividade,
                ${b.observacoes}, ${req.user.ref}::uuid)
        RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "execucao_atividade.registrar", entity: "grupo3.execucao_atividade", entityId: rows[0].id,
        payload: { resultado: "sucesso", agendamentoId: sessao.id, atividadeId: atividade.id, status: b.status },
      });
      return rows[0].id;
    });
    const rows = await prisma.$queryRawUnsafe(`${selectExecucao} WHERE e.id = $1::uuid`, id);
    res.status(201).json(paraExecucao(rows[0]));
  }),
);

async function correcoesDaExecucao(execucaoId, db = prisma) {
  const rows = await db.$queryRaw`
    SELECT c.id, c.anterior, c.novo, c.motivo, c.em, u.id AS autor_id, u.name AS autor_nome
    FROM grupo3.correcao_execucao_atividade c LEFT JOIN public.users u ON u.ref = c.autor_ref
    WHERE c.execucao_id = ${execucaoId}::uuid ORDER BY c.em, c.id
  `;
  return rows.map((row) => ({
    id: row.id, anterior: row.anterior, novo: row.novo, motivo: row.motivo, em: row.em,
    autor: row.autor_id ? { id: row.autor_id, nome: row.autor_nome } : null,
  }));
}

async function execucaoVisivel(req, id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectExecucao} WHERE e.id = $1::uuid`, id);
  if (!rows[0]) notFound("Execução não encontrada.");
  const plano = await planoVisivel(req, rows[0].plano_id, db);
  return { execucao: paraExecucao(rows[0]), plano };
}

router.get("/fisioterapia/execucoes/:id", requirePerm(VER), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const { execucao, plano } = await execucaoVisivel(req, req.params.id);
  await auditarLeitura(req, { entidade: "execucao_atividade", rota: "/fisioterapia/execucoes/:id", idosoIds: [plano.idoso?.id], ids: [execucao.id] });
  res.json({ ...execucao, correcoes: await correcoesDaExecucao(execucao.id) });
}));

// Correção de execução: só administração da fisioterapia, com motivo; anterior -> novo em trilha imutável.
// O gatilho do banco só aceita a alteração com grupo3.correcao_execucao ligado nesta transação.
router.post(
  "/fisioterapia/execucoes/:id/corrigir",
  requirePerm(ADMIN),
  validate(idParam, "params"),
  validate(z.object({
    motivo: z.string().trim().min(3, "Informe o motivo com ao menos 3 caracteres.").max(1000),
    status: z.enum(["realizada", "parcial", "nao_realizada"]).optional(),
    profissionalId: uuid.optional(),
    observacoes: z.string().trim().min(1).max(2000).nullable().optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const atual = (await tx.$queryRaw`
        SELECT id, status::text AS status, profissional_id, observacoes FROM grupo3.execucao_atividade
        WHERE id = ${req.params.id}::uuid FOR UPDATE
      `)[0];
      if (!atual) notFound("Execução não encontrada.");
      const { plano } = await execucaoVisivel(req, atual.id, tx);
      if (b.profissionalId) {
        const existe = await tx.$queryRaw`SELECT 1 FROM grupo3.colaborador WHERE id = ${b.profissionalId}::uuid`;
        if (!existe.length) throw erroCampo("profissionalId", "Profissional não encontrado.");
      }
      const anterior = { status: atual.status, profissionalId: atual.profissional_id, observacoes: atual.observacoes };
      const novo = {
        status: b.status ?? anterior.status,
        profissionalId: b.profissionalId ?? anterior.profissionalId,
        observacoes: b.observacoes !== undefined ? b.observacoes : anterior.observacoes,
      };
      if (Object.keys(novo).every((campo) => novo[campo] === anterior[campo])) {
        throw erroCampo("status", "Informe ao menos um campo diferente do registro atual.");
      }
      await tx.$queryRaw`SELECT set_config('grupo3.correcao_execucao', 'on', true)`;
      await tx.$executeRaw`
        UPDATE grupo3.execucao_atividade
        SET status = ${novo.status}::grupo3.status_execucao_atividade, profissional_id = ${novo.profissionalId}::uuid,
            observacoes = ${novo.observacoes}
        WHERE id = ${atual.id}::uuid
      `;
      await tx.$queryRaw`SELECT set_config('grupo3.correcao_execucao', 'off', true)`;
      await tx.$executeRaw`
        INSERT INTO grupo3.correcao_execucao_atividade (execucao_id, anterior, novo, motivo, autor_ref)
        VALUES (${atual.id}::uuid, ${JSON.stringify(anterior)}::jsonb, ${JSON.stringify(novo)}::jsonb, ${b.motivo}, ${req.user.ref}::uuid)
      `;
      await audit(tx, {
        userId: req.user.id, action: "execucao_atividade.corrigir", entity: "grupo3.execucao_atividade", entityId: atual.id,
        payload: { resultado: "sucesso", idosoId: plano.idoso?.id, status: { anterior: anterior.status, novo: novo.status } },
      });
    });
    const { execucao } = await execucaoVisivel(req, req.params.id);
    res.json({ ...execucao, correcoes: await correcoesDaExecucao(execucao.id) });
  }),
);

router.get(
  "/fisioterapia/planos/:id/execucoes",
  requirePerm(VER),
  validate(idParam, "params"),
  validate(pageSchema.extend({ agendamentoId: uuid.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, agendamentoId } = req.query;
    const plano = await planoVisivel(req, req.params.id);
    const rows = await prisma.$queryRawUnsafe(
      `${selectExecucao.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
       WHERE a.plano_id = $1::uuid AND ($2::uuid IS NULL OR e.agendamento_id = $2::uuid)
       ORDER BY s.inicio DESC, a.descricao LIMIT $3 OFFSET $4`,
      plano.id, agendamentoId ?? null, limit, (page - 1) * limit,
    );
    const data = rows.map(paraExecucao);
    await auditarLeitura(req, { entidade: "execucao_atividade", rota: "/fisioterapia/planos/:id/execucoes", idosoIds: [plano.idoso?.id], ids: data.map((e) => e.id) });
    res.json({ planoId: plano.id, data, meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

// ============================ Evolução (US-078) ============================

const selectEvolucao = `
  SELECT ev.id, ev.plano_id, ev.agendamento_id, ev.texto, ev.registrado_em, ev.publicacao_status, ev.prontuario_ref,
         ev.autor_ref, u.id AS autor_id, u.name AS autor_nome
  FROM grupo3.evolucao_fisioterapia ev
  LEFT JOIN public.users u ON u.ref = ev.autor_ref
`;

function paraEvolucao(row) {
  return {
    id: row.id,
    planoId: row.plano_id,
    agendamentoId: row.agendamento_id,
    texto: row.texto,
    registradoEm: row.registrado_em,
    autor: row.autor_id ? { id: row.autor_id, nome: row.autor_nome } : null,
    publicacao: { status: row.publicacao_status, prontuarioRef: row.prontuario_ref },
  };
}

// Mesmo formato que o registro clínico espera na publicação.
function comoRegistro(plano, evolucao) {
  return {
    id: evolucao.id, idoso: plano.idoso, area: "fisioterapia", tipo: plano.objetivo.slice(0, 120),
    realizadoEm: evolucao.registrado_em, resumo: evolucao.texto, adendoDe: null,
  };
}

router.get(
  "/fisioterapia/planos/:id/evolucoes",
  requirePerm(VER),
  validate(idParam, "params"),
  validate(pageSchema, "query"),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const plano = await planoVisivel(req, req.params.id);
    const rows = await prisma.$queryRawUnsafe(
      `${selectEvolucao.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
       WHERE ev.plano_id = $1::uuid ORDER BY ev.registrado_em, ev.id LIMIT $2 OFFSET $3`,
      plano.id, limit, (page - 1) * limit,
    );
    const data = rows.map(paraEvolucao);
    await auditarLeitura(req, { entidade: "evolucao_fisioterapia", rota: "/fisioterapia/planos/:id/evolucoes", idosoIds: [plano.idoso?.id], ids: data.map((e) => e.id) });
    res.json({ planoId: plano.id, data, meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

router.post(
  "/fisioterapia/planos/:id/evolucoes",
  requirePerm(CRIAR),
  validate(idParam, "params"),
  validate(z.object({
    texto: z.string().trim().min(10, "Descreva a evolução com ao menos 10 caracteres.").max(8000),
    agendamentoId: opcional(uuid),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const id = await prisma.$transaction(async (tx) => {
      const plano = await planoVisivel(req, req.params.id, tx);
      if (plano.situacao === "cancelado") throw new HttpError(409, "Plano cancelado não recebe evolução.");
      if (b.agendamentoId) {
        const sessao = await tx.$queryRaw`SELECT plano_fisioterapia_id FROM grupo3.agendamento WHERE id = ${b.agendamentoId}::uuid`;
        if (!sessao[0] || sessao[0].plano_fisioterapia_id !== plano.id) throw erroCampo("agendamentoId", "A sessão não está ligada a este plano.");
      }
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.evolucao_fisioterapia (plano_id, agendamento_id, texto, autor_ref, publicacao_status)
        VALUES (${plano.id}::uuid, ${b.agendamentoId}::uuid, ${b.texto}, ${req.user.ref}::uuid, 'pendente_integracao')
        RETURNING id, registrado_em, texto
      `;
      const publicacao = await publicarSePermitido(tx, req.user, comoRegistro(plano, rows[0]));
      await tx.$executeRaw`
        UPDATE grupo3.evolucao_fisioterapia SET publicacao_status = ${publicacao.status}, prontuario_ref = ${publicacao.referencia ?? null}
        WHERE id = ${rows[0].id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "evolucao_fisioterapia.registrar", entity: "grupo3.evolucao_fisioterapia", entityId: rows[0].id,
        payload: { resultado: "sucesso", planoId: plano.id, idosoId: plano.idoso?.id, publicacao: publicacao.status },
      });
      return rows[0].id;
    });
    const rows = await prisma.$queryRawUnsafe(`${selectEvolucao} WHERE ev.id = $1::uuid`, id);
    res.status(201).json(paraEvolucao(rows[0]));
  }),
);

// Mesma regra do registro clínico: publica, em nome do autor, quando ele passa a ter evolucao.create.
router.post(
  "/fisioterapia/evolucoes/republicar-pendentes",
  requirePerm(ADMIN),
  asyncHandler(async (req, res) => {
    const resumo = { verificados: 0, publicados: 0, aguardandoPermissao: 0 };
    const pendentes = await prisma.$queryRaw`
      SELECT ev.id, ev.plano_id, u.id AS autor_id
      FROM grupo3.evolucao_fisioterapia ev LEFT JOIN public.users u ON u.ref = ev.autor_ref
      WHERE ev.publicacao_status IN ('aguardando_permissao', 'pendente_integracao', 'falha')
      ORDER BY ev.registrado_em LIMIT 500
    `;
    const autores = new Map();
    for (const item of pendentes) {
      resumo.verificados += 1;
      if (item.autor_id && !autores.has(item.autor_id)) autores.set(item.autor_id, await loadUser(item.autor_id));
      const autor = autores.get(item.autor_id);
      if (!autor?.active || !podePublicar(autor)) {
        resumo.aguardandoPermissao += 1;
        continue;
      }
      await prisma.$transaction(async (tx) => {
        const atual = (await tx.$queryRaw`
          SELECT id, registrado_em, texto, publicacao_status FROM grupo3.evolucao_fisioterapia WHERE id = ${item.id}::uuid FOR UPDATE
        `)[0];
        if (atual.publicacao_status === "publicado") return;
        const plano = await buscarPlano(item.plano_id, tx);
        const publicacao = await publicarSePermitido(tx, autor, comoRegistro(plano, atual));
        await tx.$executeRaw`
          UPDATE grupo3.evolucao_fisioterapia SET publicacao_status = ${publicacao.status}, prontuario_ref = ${publicacao.referencia ?? null}
          WHERE id = ${item.id}::uuid
        `;
        await audit(tx, {
          userId: req.user.id, action: "evolucao_fisioterapia.republicar", entity: "grupo3.evolucao_fisioterapia", entityId: item.id,
          payload: { resultado: "sucesso", publicadoEmNomeDe: autor.id, idosoId: plano.idoso?.id },
        });
        resumo.publicados += 1;
      });
    }
    res.json(resumo);
  }),
);

// ============================ Rotina semanal (US-079) ============================

function dataLocal(instante, fuso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).format(instante);
}

router.get(
  "/fisioterapia/rotina-semanal",
  requirePerm(VER),
  validate(z.object({ semana: dia.optional(), profissionalId: uuid.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const periodo = await periodoAgenda("semana", req.query.semana ?? null);
    const { data: sessoes } = await listarAgendamentos({
      categoria: "fisioterapia", inicio: periodo.inicio, fim: periodo.fim, profissionalId: req.query.profissionalId,
    });
    const dias = diasDaSemana(periodo.data);
    const comData = sessoes.map((s) => ({ ...s, data: dataLocal(s.inicio, periodo.fuso) }));
    const carga = cargaPorDia(dias, comData);
    const colaborador = await colaboradorDoUsuario(req.user);
    res.json({
      semana: { inicio: dias[0], fim: dias[6], fuso: periodo.fuso },
      resumo: {
        sessoesNaCarga: carga.reduce((soma, d) => soma + d.sessoes, 0),
        minutosNaCarga: carga.reduce((soma, d) => soma + d.minutos, 0),
        canceladas: comData.filter((s) => s.status === "cancelado").length,
        naoRealizadas: comData.filter((s) => s.status === "nao_realizado").length,
      },
      cargaPorDia: carga,
      sessoes: mascararLista(comData, req.user, colaborador?.id),
    });
  }),
);

// Programação semanal de sessões de um plano: tudo ou nada, com a mesma validação do agendamento.
router.post(
  "/fisioterapia/planos/:id/programar-semana",
  requirePerm(CRIAR),
  validate(idParam, "params"),
  validate(z.object({
    semana: dia,
    tipoId: uuid,
    local: opcional(z.string().trim().min(1).max(120)),
    sessoes: z.array(z.object({
      diaSemana: z.number().int().min(1).max(7),
      hora: horario,
      duracaoMin: duracaoMin.optional(),
      profissionalId: opcional(uuid),
    })).min(1).max(14),
  })),
  asyncHandler(async (req, res) => {
    exigirPermissao(req.user, "agenda.criar");
    const b = req.body;
    const plano = await planoVisivel(req, req.params.id);
    const idoso = await exigirIdosoAtivo(plano.idoso.id);
    const dias = diasDaSemana(b.semana);
    let criados;
    try {
      criados = await prisma.$transaction(async (tx) => {
        const resultado = [];
        for (const [indice, sessao] of b.sessoes.entries()) {
          const dataSessao = dias[sessao.diaSemana - 1];
          const inicio = (await tx.$queryRaw`
            SELECT ((${dataSessao}::date + ${sessao.hora}::time) AT TIME ZONE grupo3.fuso_horario()) AS inicio
          `)[0].inicio;
          try {
            const criado = await criarAgendamento(tx, req.user, idoso, {
              tipoId: b.tipoId, profissionalId: sessao.profissionalId ?? plano.responsavel.id, inicio,
              duracaoMin: sessao.duracaoMin, local: b.local, planoFisioterapiaId: plano.id,
            });
            resultado.push({ indice, ...criado });
          } catch (error) {
            if (error instanceof HttpError) {
              throw new HttpError(error.status, `Sessão ${indice + 1}: ${error.message}`, { sessao: indice, ...(Array.isArray(error.details) ? { campos: error.details } : error.details ?? {}) });
            }
            throw error;
          }
        }
        return resultado;
      }, { timeout: 30_000 });
    } catch (error) {
      await auditarRecusa(req, "agendamento.criar", null, error);
      throw error;
    }
    const sessoes = [];
    for (const c of criados) sessoes.push({ ...(await buscarAgendamento(c.id)), avisos: c.avisos });
    res.status(201).json({ planoId: plano.id, sessoes });
  }),
);

// ============================ Indicadores (US-080) ============================

router.get(
  "/fisioterapia/indicadores",
  requirePerm(VER),
  validate(z.object({ inicio: dia.optional(), fim: dia.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const hoje = await hojeInstitucional();
    const inicio = req.query.inicio ?? `${hoje.slice(0, 7)}-01`;
    const fim = req.query.fim ?? hoje;
    if (fim < inicio) throw erroCampo("fim", "O fim precisa ser igual ou depois do início.");
    const planos = (await prisma.$queryRaw`
      SELECT
        count(*) FILTER (WHERE situacao = 'ativo' AND data_inicio <= ${hoje}::date AND (data_fim IS NULL OR data_fim >= ${hoje}::date))::int AS ativos,
        count(DISTINCT idoso_ref) FILTER (WHERE situacao = 'ativo' AND data_inicio <= ${hoje}::date AND (data_fim IS NULL OR data_fim >= ${hoje}::date))::int AS idosos,
        count(*) FILTER (WHERE situacao = 'suspenso')::int AS suspensos,
        count(*) FILTER (WHERE situacao = 'concluido')::int AS concluidos
      FROM grupo3.plano_fisioterapia
    `)[0];
    const sessoes = (await prisma.$queryRaw`
      SELECT
        count(*) FILTER (WHERE a.status <> 'cancelado')::int AS previstas,
        count(*) FILTER (WHERE a.status = 'realizado')::int AS realizadas,
        count(*) FILTER (WHERE a.status = 'nao_realizado')::int AS nao_realizadas,
        count(*) FILTER (WHERE a.status = 'agendado')::int AS agendadas,
        count(*) FILTER (WHERE a.status = 'cancelado')::int AS canceladas
      FROM grupo3.agendamento a JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
      WHERE t.categoria = 'fisioterapia'
        AND a.inicio >= (${inicio}::date::timestamp AT TIME ZONE grupo3.fuso_horario())
        AND a.inicio < ((${fim}::date + 1)::timestamp AT TIME ZONE grupo3.fuso_horario())
    `)[0];
    res.json({
      periodo: { inicio, fim },
      planos: { ativos: planos.ativos, idososEmFisioterapia: planos.idosos, suspensos: planos.suspensos, concluidos: planos.concluidos },
      sessoes: {
        previstas: sessoes.previstas,
        realizadas: sessoes.realizadas,
        naoRealizadas: sessoes.nao_realizadas,
        agendadas: sessoes.agendadas,
        canceladas: sessoes.canceladas,
        taxaRealizacao: taxa(sessoes.realizadas, sessoes.realizadas + sessoes.nao_realizadas),
      },
    });
  }),
);

export default router;

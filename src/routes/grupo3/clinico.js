// E09 — Atendimento médico e odontológico: registro clínico de consulta (US-086/US-087), acompanhamento
// odontológico (US-087), tratamento externo (US-088) e pendências do ciclo odontológico (US-089).
// Leitura de dados clínicos é auditada (quem, quando, qual idoso).
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { asyncHandler } from "../../middleware/async.js";
import { loadUser, requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { auditarLeitura } from "../../grupo3/auditoria.js";
import { buscarIdoso, buscarIdososPorRef } from "../../grupo3/portas/idosos.js";
import { podePublicar, podeVerIdoso, publicarNoProntuario } from "../../grupo3/portas/prontuario.js";
import { areaClinica, periodoDoCiclo } from "../../grupo3/regras.js";
import { conteudoFlexivel, dataHora, dia, idParam, idosoId, temPermissao, uuid } from "../../grupo3/validacao.js";

const router = Router();

const VER = "atendimento-clinico.visualizar";
const CRIAR = "atendimento-clinico.criar";
const EDITAR = "atendimento-clinico.editar";
const ADMIN = "atendimento-clinico.administrar";
const opcional = (schema) => schema.nullish().transform((value) => value ?? null);

function erroCampo(path, message) {
  return new HttpError(422, "Dados inválidos", [{ path, message }]);
}

async function idosoVisivel(req, idosoIdParam) {
  const idoso = await buscarIdoso(idosoIdParam);
  if (!idoso) notFound("Idoso não encontrado.");
  if (!(await podeVerIdoso(req.user, idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
  return idoso;
}

async function hojeInstitucional(db = prisma) {
  const rows = await db.$queryRaw`SELECT to_char((now() AT TIME ZONE grupo3.fuso_horario())::date, 'YYYY-MM-DD') AS hoje`;
  return rows[0].hoje;
}

// ============================ Registro clínico (US-086, US-087) ============================

const selectRegistro = `
  SELECT r.id, r.agendamento_id, r.adendo_de, r.acompanhamento_id, r.idoso_ref, r.area::text AS area, r.tipo,
         r.realizado_em, r.resumo, r.conteudo, r.status::text AS status, r.finalizado_em, r.publicacao_status,
         r.prontuario_ref, r.criado_em, r.atualizado_em, r.autor_ref,
         p.id AS profissional_id, p.nome AS profissional_nome,
         ua.id AS autor_id, ua.name AS autor_nome, uf.id AS finalizado_por_id, uf.name AS finalizado_por_nome
  FROM grupo3.registro_clinico r
  JOIN grupo3.colaborador p ON p.id = r.profissional_id
  LEFT JOIN public.users ua ON ua.ref = r.autor_ref
  LEFT JOIN public.users uf ON uf.ref = r.finalizado_por_ref
`;

function paraRegistro(row, idosos) {
  const idoso = idosos.get(row.idoso_ref);
  return {
    id: row.id,
    agendamentoId: row.agendamento_id,
    adendoDe: row.adendo_de,
    acompanhamentoId: row.acompanhamento_id,
    idoso: idoso ? { id: idoso.id, nome: idoso.nome } : null,
    area: row.area,
    profissional: { id: row.profissional_id, nome: row.profissional_nome },
    tipo: row.tipo,
    realizadoEm: row.realizado_em,
    resumo: row.resumo,
    conteudo: row.conteudo,
    status: row.status,
    autor: row.autor_id ? { id: row.autor_id, nome: row.autor_nome } : null,
    finalizadoEm: row.finalizado_em,
    finalizadoPor: row.finalizado_por_id ? { id: row.finalizado_por_id, nome: row.finalizado_por_nome } : null,
    publicacao: row.publicacao_status ? { status: row.publicacao_status, prontuarioRef: row.prontuario_ref } : null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function buscarRegistro(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectRegistro} WHERE r.id = $1::uuid`, id);
  if (!rows[0]) return null;
  const idosos = await buscarIdososPorRef([rows[0].idoso_ref], db);
  return { ...paraRegistro(rows[0], idosos), autorRef: rows[0].autor_ref };
}

async function comAdendos(registro, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectRegistro} WHERE r.adendo_de = $1::uuid ORDER BY r.criado_em`, registro.id);
  const idosos = await buscarIdososPorRef(rows.map((row) => row.idoso_ref), db);
  const { autorRef, ...publico } = registro;
  return { ...publico, adendos: rows.map((row) => paraRegistro(row, idosos)) };
}

async function exigirAcompanhamento(db, acompanhamentoId, idosoRef, area) {
  if (!acompanhamentoId) return;
  if (area !== "odontologica") throw erroCampo("acompanhamentoId", "Acompanhamento só se aplica a consulta odontológica.");
  const rows = await db.$queryRaw`SELECT idoso_ref FROM grupo3.acompanhamento_odontologico WHERE id = ${acompanhamentoId}::uuid`;
  if (!rows[0]) throw erroCampo("acompanhamentoId", "Acompanhamento não encontrado.");
  if (rows[0].idoso_ref !== idosoRef) throw erroCampo("acompanhamentoId", "O acompanhamento é de outro idoso.");
}

/**
 * Publica no prontuário se o autor tem evolucao.create (permissão do Grupo 1, não contornada); senão
 * devolve "aguardando_permissao" para republicar depois.
 */
export async function publicarSePermitido(tx, autor, registro) {
  if (!podePublicar(autor)) return { status: "aguardando_permissao", referencia: null };
  return publicarNoProntuario({
    idosoId: registro.idoso.id,
    autorUsuarioId: autor.id,
    area: registro.area,
    tipo: registro.tipo,
    realizadoEm: registro.realizadoEm,
    resumo: registro.resumo,
    adendo: Boolean(registro.adendoDe),
    referenciaId: registro.id,
  }, tx);
}

/** Finaliza (ou cria finalizado) e publica no prontuário quando permitido, numa única atualização. */
async function finalizarEPublicar(tx, req, registroId) {
  const atual = await buscarRegistro(registroId, tx);
  const publicacao = await publicarSePermitido(tx, req.user, atual);
  await tx.$executeRaw`
    UPDATE grupo3.registro_clinico
    SET status = 'finalizado', finalizado_em = now(), finalizado_por_ref = ${req.user.ref}::uuid,
        publicacao_status = ${publicacao.status}, prontuario_ref = ${publicacao.referencia ?? null}
    WHERE id = ${registroId}::uuid
  `;
  return publicacao;
}

const corpoRegistro = z.object({
  tipo: opcional(z.string().trim().min(2).max(80)),
  resumo: z.string().trim().min(10, "Informe o resumo/resultado com ao menos 10 caracteres.").max(8000),
  conteudo: conteudoFlexivel.default({}),
  realizadoEm: dataHora.optional(),
  acompanhamentoId: opcional(uuid),
});

async function carregarConsulta(db, agendamentoId) {
  const rows = await db.$queryRaw`
    SELECT a.id, a.idoso_ref, a.inicio, a.profissional_id, a.status::text AS status,
           t.nome AS tipo_nome, t.categoria::text AS categoria
    FROM grupo3.agendamento a JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
    WHERE a.id = ${agendamentoId}::uuid
  `;
  return rows[0] ?? null;
}

router.post(
  "/agendamentos/:id/registro-clinico",
  requirePerm(CRIAR),
  validate(idParam, "params"),
  validate(corpoRegistro.extend({ finalizar: z.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const id = await prisma.$transaction(async (tx) => {
      const consulta = await carregarConsulta(tx, req.params.id);
      if (!consulta) notFound("Agendamento não encontrado.");
      const area = areaClinica(consulta.categoria);
      if (!area) throw new HttpError(422, "Registro clínico só para consulta médica ou odontológica.");
      if (["cancelado", "nao_realizado"].includes(consulta.status)) {
        throw new HttpError(409, "Consulta cancelada ou não realizada não recebe registro clínico.");
      }
      if (b.finalizar && consulta.status !== "realizado") {
        throw new HttpError(409, "Registre a realização da consulta antes de finalizar o registro.");
      }
      const idosos = await buscarIdososPorRef([consulta.idoso_ref], tx);
      if (!(await podeVerIdoso(req.user, idosos.get(consulta.idoso_ref)))) throw new HttpError(403, "Você não tem autorização para esta ação.");
      const existente = await tx.$queryRaw`
        SELECT id FROM grupo3.registro_clinico WHERE agendamento_id = ${consulta.id}::uuid AND adendo_de IS NULL
      `;
      if (existente[0]) throw new HttpError(409, "Esta consulta já tem registro clínico. Edite o rascunho ou registre um adendo.");
      await exigirAcompanhamento(tx, b.acompanhamentoId, consulta.idoso_ref, area);
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.registro_clinico (
          agendamento_id, acompanhamento_id, idoso_ref, area, profissional_id, tipo, realizado_em, resumo, conteudo, autor_ref
        ) VALUES (
          ${consulta.id}::uuid, ${b.acompanhamentoId}::uuid, ${consulta.idoso_ref}::uuid, ${area}::grupo3.area_clinica,
          ${consulta.profissional_id}::uuid, ${b.tipo ?? consulta.tipo_nome}, ${b.realizadoEm ?? consulta.inicio},
          ${b.resumo}, ${JSON.stringify(b.conteudo)}::jsonb, ${req.user.ref}::uuid
        ) RETURNING id
      `;
      const novoId = rows[0].id;
      if (b.finalizar) await finalizarEPublicar(tx, req, novoId);
      await audit(tx, {
        userId: req.user.id, action: b.finalizar ? "registro_clinico.criar_finalizado" : "registro_clinico.criar",
        entity: "grupo3.registro_clinico", entityId: novoId,
        payload: { resultado: "sucesso", agendamentoId: consulta.id, idosoId: idosos.get(consulta.idoso_ref)?.id, area },
      });
      return novoId;
    });
    res.status(201).json(await comAdendos(await buscarRegistro(id)));
  }),
);

async function lerRegistroCompleto(req, registro, rota) {
  if (!(await podeVerIdoso(req.user, registro.idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
  const completo = await comAdendos(registro);
  await auditarLeitura(req, {
    entidade: "registro_clinico", rota, idosoIds: [registro.idoso?.id], ids: [registro.id, ...completo.adendos.map((a) => a.id)],
  });
  return completo;
}

router.get(
  "/agendamentos/:id/registro-clinico",
  requirePerm(VER),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw`
      SELECT id FROM grupo3.registro_clinico WHERE agendamento_id = ${req.params.id}::uuid AND adendo_de IS NULL
    `;
    if (!rows[0]) notFound("Esta consulta ainda não tem registro clínico.");
    res.json(await lerRegistroCompleto(req, await buscarRegistro(rows[0].id), "GET /agendamentos/{id}/registro-clinico"));
  }),
);

router.get(
  "/registros-clinicos/:id",
  requirePerm(VER),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const registro = await buscarRegistro(req.params.id);
    if (!registro) notFound("Registro clínico não encontrado.");
    res.json(await lerRegistroCompleto(req, registro, "GET /registros-clinicos/{id}"));
  }),
);

function exigirAutorOuAdmin(req, registro) {
  if (registro.autorRef !== req.user.ref && !temPermissao(req.user, ADMIN)) {
    throw new HttpError(403, "Só o autor (ou a administração do atendimento clínico) altera o rascunho.");
  }
}

router.put(
  "/registros-clinicos/:id",
  requirePerm(EDITAR),
  validate(idParam, "params"),
  validate(corpoRegistro),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const atual = await buscarRegistro(req.params.id, tx);
      if (!atual) notFound("Registro clínico não encontrado.");
      if (atual.status === "finalizado") throw new HttpError(409, "Registro finalizado não é editado; registre um adendo.");
      exigirAutorOuAdmin(req, atual);
      const idosoRef = (await tx.$queryRaw`SELECT idoso_ref FROM grupo3.registro_clinico WHERE id = ${atual.id}::uuid`)[0].idoso_ref;
      await exigirAcompanhamento(tx, b.acompanhamentoId, idosoRef, atual.area);
      await tx.$executeRaw`
        UPDATE grupo3.registro_clinico
        SET tipo = ${b.tipo ?? atual.tipo}, resumo = ${b.resumo}, conteudo = ${JSON.stringify(b.conteudo)}::jsonb,
            realizado_em = ${b.realizadoEm ?? atual.realizadoEm}, acompanhamento_id = ${b.acompanhamentoId}::uuid
        WHERE id = ${atual.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "registro_clinico.editar", entity: "grupo3.registro_clinico", entityId: atual.id,
        payload: { resultado: "sucesso", idosoId: atual.idoso?.id },
      });
    });
    res.json(await comAdendos(await buscarRegistro(req.params.id)));
  }),
);

router.post(
  "/registros-clinicos/:id/finalizar",
  requirePerm(EDITAR),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const atual = await buscarRegistro(req.params.id, tx);
      if (!atual) notFound("Registro clínico não encontrado.");
      if (atual.status === "finalizado") throw new HttpError(409, "Registro já finalizado.");
      exigirAutorOuAdmin(req, atual);
      if (atual.agendamentoId) {
        const consulta = await carregarConsulta(tx, atual.agendamentoId);
        if (consulta.status !== "realizado") throw new HttpError(409, "Registre a realização da consulta antes de finalizar o registro.");
      }
      const publicacao = await finalizarEPublicar(tx, req, atual.id);
      await audit(tx, {
        userId: req.user.id, action: "registro_clinico.finalizar", entity: "grupo3.registro_clinico", entityId: atual.id,
        payload: { resultado: "sucesso", idosoId: atual.idoso?.id, publicacao: publicacao.status },
      });
    });
    res.json(await comAdendos(await buscarRegistro(req.params.id)));
  }),
);

// Correção de registro finalizado: adendo = registro novo vinculado, com autor e data (D-004).
router.post(
  "/registros-clinicos/:id/adendos",
  requirePerm(CRIAR),
  validate(idParam, "params"),
  validate(z.object({
    resumo: z.string().trim().min(10, "Informe o texto do adendo com ao menos 10 caracteres.").max(8000),
    conteudo: conteudoFlexivel.default({}),
  })),
  asyncHandler(async (req, res) => {
    const principalId = await prisma.$transaction(async (tx) => {
      let original = await buscarRegistro(req.params.id, tx);
      if (!original) notFound("Registro clínico não encontrado.");
      if (original.adendoDe) original = await buscarRegistro(original.adendoDe, tx);
      if (original.status !== "finalizado") throw new HttpError(409, "Rascunho é editado diretamente; adendo só para registro finalizado.");
      if (!(await podeVerIdoso(req.user, original.idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
      const base = (await tx.$queryRaw`
        SELECT idoso_ref, area::text AS area, profissional_id, tipo FROM grupo3.registro_clinico WHERE id = ${original.id}::uuid
      `)[0];
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.registro_clinico (
          agendamento_id, adendo_de, idoso_ref, area, profissional_id, tipo, realizado_em, resumo, conteudo, autor_ref,
          status, finalizado_em, finalizado_por_ref
        ) VALUES (
          ${original.agendamentoId}::uuid, ${original.id}::uuid, ${base.idoso_ref}::uuid, ${base.area}::grupo3.area_clinica,
          ${base.profissional_id}::uuid, ${base.tipo}, now(), ${req.body.resumo}, ${JSON.stringify(req.body.conteudo)}::jsonb,
          ${req.user.ref}::uuid, 'finalizado', now(), ${req.user.ref}::uuid
        ) RETURNING id
      `;
      const adendo = await buscarRegistro(rows[0].id, tx);
      const publicacao = await publicarSePermitido(tx, req.user, adendo);
      await tx.$executeRaw`
        UPDATE grupo3.registro_clinico SET publicacao_status = ${publicacao.status}, prontuario_ref = ${publicacao.referencia ?? null}
        WHERE id = ${adendo.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "registro_clinico.adendo", entity: "grupo3.registro_clinico", entityId: adendo.id,
        payload: { resultado: "sucesso", adendoDe: original.id, idosoId: adendo.idoso.id },
      });
      return original.id;
    });
    res.status(201).json(await comAdendos(await buscarRegistro(principalId)));
  }),
);

// Tenta publicar de novo os registros finalizados que ficaram sem publicação. Publica em nome de quem
// finalizou, se essa pessoa agora tem evolucao.create.
router.post(
  "/registros-clinicos/republicar-pendentes",
  requirePerm(ADMIN),
  asyncHandler(async (req, res) => {
    const resumo = { verificados: 0, publicados: 0, aguardandoPermissao: 0 };
    const pendentes = await prisma.$queryRaw`
      SELECT r.id, u.id AS finalizado_por_id
      FROM grupo3.registro_clinico r
      LEFT JOIN public.users u ON u.ref = r.finalizado_por_ref
      WHERE r.status = 'finalizado' AND r.publicacao_status IN ('aguardando_permissao', 'pendente_integracao', 'falha')
      ORDER BY r.finalizado_em
      LIMIT 500
    `;
    const autores = new Map();
    for (const item of pendentes) {
      resumo.verificados += 1;
      if (item.finalizado_por_id && !autores.has(item.finalizado_por_id)) {
        autores.set(item.finalizado_por_id, await loadUser(item.finalizado_por_id));
      }
      const autor = autores.get(item.finalizado_por_id);
      if (!autor?.active || !podePublicar(autor)) {
        resumo.aguardandoPermissao += 1;
        continue;
      }
      await prisma.$transaction(async (tx) => {
        const travado = await tx.$queryRaw`
          SELECT publicacao_status FROM grupo3.registro_clinico WHERE id = ${item.id}::uuid FOR UPDATE
        `;
        if (travado[0].publicacao_status === "publicado") return;
        const registro = await buscarRegistro(item.id, tx);
        const publicacao = await publicarSePermitido(tx, autor, registro);
        await tx.$executeRaw`
          UPDATE grupo3.registro_clinico SET publicacao_status = ${publicacao.status}, prontuario_ref = ${publicacao.referencia ?? null}
          WHERE id = ${item.id}::uuid
        `;
        await audit(tx, {
          userId: req.user.id, action: "registro_clinico.republicar", entity: "grupo3.registro_clinico", entityId: item.id,
          payload: { resultado: "sucesso", publicadoEmNomeDe: autor.id, idosoId: registro.idoso?.id },
        });
        resumo.publicados += 1;
      });
    }
    res.json(resumo);
  }),
);

router.get(
  "/idosos/:idosoId/registros-clinicos",
  requirePerm(VER),
  validate(z.object({ idosoId }), "params"),
  validate(pageSchema.extend({
    area: z.enum(["medica", "odontologica"]).optional(),
    status: z.enum(["rascunho", "finalizado"]).optional(),
    inicio: dataHora.optional(),
    fim: dataHora.optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, area, status, inicio, fim } = req.query;
    const idoso = await idosoVisivel(req, req.params.idosoId);
    const rows = await prisma.$queryRawUnsafe(
      `${selectRegistro.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
       WHERE r.idoso_ref = $1::uuid AND r.adendo_de IS NULL
         AND ($2::text IS NULL OR r.area::text = $2) AND ($3::text IS NULL OR r.status::text = $3)
         AND ($4::timestamptz IS NULL OR r.realizado_em >= $4::timestamptz)
         AND ($5::timestamptz IS NULL OR r.realizado_em < $5::timestamptz)
       ORDER BY r.realizado_em DESC LIMIT $6 OFFSET $7`,
      idoso.ref, area ?? null, status ?? null, inicio ?? null, fim ?? null, limit, (page - 1) * limit,
    );
    const idosos = new Map([[idoso.ref, idoso]]);
    const data = rows.map((row) => paraRegistro(row, idosos));
    await auditarLeitura(req, { entidade: "registro_clinico", rota: "GET /idosos/{idosoId}/registros-clinicos", idosoIds: [idoso.id], ids: data.map((r) => r.id) });
    res.json({ idoso: { id: idoso.id, nome: idoso.nome }, data, meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

// ============================ Acompanhamento odontológico (US-087) ============================

const selectAcompanhamento = `
  SELECT a.id, a.idoso_ref, a.plano, a.periodicidade_dias, to_char(a.proxima_avaliacao, 'YYYY-MM-DD') AS proxima_avaliacao,
         a.situacao::text AS situacao, a.observacoes, a.criado_em, a.atualizado_em,
         c.id AS responsavel_id, c.nome AS responsavel_nome,
         (SELECT max(r.realizado_em) FROM grupo3.registro_clinico r
           WHERE r.acompanhamento_id = a.id AND r.status = 'finalizado') AS ultimo_registro_em
  FROM grupo3.acompanhamento_odontologico a
  LEFT JOIN grupo3.colaborador c ON c.id = a.responsavel_id
`;

function paraAcompanhamento(row, idosos) {
  const idoso = idosos.get(row.idoso_ref);
  return {
    id: row.id,
    idoso: idoso ? { id: idoso.id, nome: idoso.nome } : null,
    responsavel: row.responsavel_id ? { id: row.responsavel_id, nome: row.responsavel_nome } : null,
    plano: row.plano,
    periodicidadeDias: row.periodicidade_dias,
    proximaAvaliacao: row.proxima_avaliacao,
    situacao: row.situacao,
    observacoes: row.observacoes,
    ultimoRegistroEm: row.ultimo_registro_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function buscarAcompanhamento(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectAcompanhamento} WHERE a.id = $1::uuid`, id);
  if (!rows[0]) return null;
  return paraAcompanhamento(rows[0], await buscarIdososPorRef([rows[0].idoso_ref], db));
}

const situacaoAcompanhamento = z.enum(["em_tratamento", "em_acompanhamento", "concluido", "suspenso"]);
const corpoAcompanhamento = z.object({
  responsavelId: opcional(uuid),
  plano: z.string().trim().min(5).max(4000),
  periodicidadeDias: z.number().int().min(7).max(730).default(180),
  proximaAvaliacao: opcional(dia),
  situacao: situacaoAcompanhamento.default("em_acompanhamento"),
  observacoes: opcional(z.string().trim().min(1).max(2000)),
});
const ATIVAS = ["em_tratamento", "em_acompanhamento"];

async function exigirResponsavel(db, id) {
  if (!id) return;
  const rows = await db.$queryRaw`SELECT 1 FROM grupo3.colaborador WHERE id = ${id}::uuid`;
  if (!rows[0]) throw erroCampo("responsavelId", "Responsável não encontrado.");
}

async function semOutroAtivo(db, idosoRef, ignorarId = null) {
  const rows = await db.$queryRaw`
    SELECT id FROM grupo3.acompanhamento_odontologico
    WHERE idoso_ref = ${idosoRef}::uuid AND situacao IN ('em_tratamento','em_acompanhamento')
      AND (${ignorarId}::uuid IS NULL OR id <> ${ignorarId}::uuid)
  `;
  if (rows[0]) throw new HttpError(409, "O idoso já tem acompanhamento odontológico ativo.", { acompanhamentoId: rows[0].id });
}

router.get(
  "/odontologia/acompanhamentos",
  requirePerm(VER),
  validate(pageSchema.extend({ idosoId: idosoId.optional(), situacao: situacaoAcompanhamento.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, situacao } = req.query;
    const idoso = req.query.idosoId ? await idosoVisivel(req, req.query.idosoId) : null;
    const rows = await prisma.$queryRawUnsafe(
      `${selectAcompanhamento.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
       WHERE ($1::uuid IS NULL OR a.idoso_ref = $1::uuid) AND ($2::text IS NULL OR a.situacao::text = $2)
       ORDER BY a.proxima_avaliacao NULLS LAST, a.criado_em DESC LIMIT $3 OFFSET $4`,
      idoso?.ref ?? null, situacao ?? null, limit, (page - 1) * limit,
    );
    const idosos = await buscarIdososPorRef(rows.map((row) => row.idoso_ref));
    const data = rows.map((row) => paraAcompanhamento(row, idosos));
    await auditarLeitura(req, {
      entidade: "acompanhamento_odontologico", rota: "GET /odontologia/acompanhamentos",
      idosoIds: data.map((a) => a.idoso?.id), ids: data.map((a) => a.id),
    });
    res.json({ data, meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

router.get("/odontologia/acompanhamentos/:id", requirePerm(VER), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const acompanhamento = await buscarAcompanhamento(req.params.id);
  if (!acompanhamento) notFound("Acompanhamento não encontrado.");
  if (!(await podeVerIdoso(req.user, acompanhamento.idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
  await auditarLeitura(req, {
    entidade: "acompanhamento_odontologico", rota: "GET /odontologia/acompanhamentos/{id}",
    idosoIds: [acompanhamento.idoso?.id], ids: [acompanhamento.id],
  });
  res.json(acompanhamento);
}));

router.post(
  "/odontologia/acompanhamentos",
  requirePerm(CRIAR),
  validate(corpoAcompanhamento.extend({ idosoId })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const idoso = await buscarIdoso(b.idosoId);
    if (!idoso) throw erroCampo("idosoId", "Idoso não encontrado.");
    const id = await prisma.$transaction(async (tx) => {
      await exigirResponsavel(tx, b.responsavelId);
      if (ATIVAS.includes(b.situacao)) await semOutroAtivo(tx, idoso.ref);
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.acompanhamento_odontologico (idoso_ref, responsavel_id, plano, periodicidade_dias, proxima_avaliacao, situacao, observacoes, criado_por_ref)
        VALUES (${idoso.ref}::uuid, ${b.responsavelId}::uuid, ${b.plano}, ${b.periodicidadeDias}, ${b.proximaAvaliacao}::date,
                ${b.situacao}::grupo3.situacao_acompanhamento, ${b.observacoes}, ${req.user.ref}::uuid)
        RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "acompanhamento_odontologico.criar", entity: "grupo3.acompanhamento_odontologico",
        entityId: rows[0].id, payload: { resultado: "sucesso", idosoId: idoso.id, situacao: b.situacao },
      });
      return rows[0].id;
    });
    res.status(201).json(await buscarAcompanhamento(id));
  }),
);

router.put(
  "/odontologia/acompanhamentos/:id",
  requirePerm(EDITAR),
  validate(idParam, "params"),
  validate(corpoAcompanhamento),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT id, idoso_ref, situacao::text AS situacao FROM grupo3.acompanhamento_odontologico WHERE id = ${req.params.id}::uuid FOR UPDATE
      `;
      const atual = rows[0];
      if (!atual) notFound("Acompanhamento não encontrado.");
      await exigirResponsavel(tx, b.responsavelId);
      if (ATIVAS.includes(b.situacao)) await semOutroAtivo(tx, atual.idoso_ref, atual.id);
      await tx.$executeRaw`
        UPDATE grupo3.acompanhamento_odontologico
        SET responsavel_id = ${b.responsavelId}::uuid, plano = ${b.plano}, periodicidade_dias = ${b.periodicidadeDias},
            proxima_avaliacao = ${b.proximaAvaliacao}::date, situacao = ${b.situacao}::grupo3.situacao_acompanhamento,
            observacoes = ${b.observacoes}
        WHERE id = ${atual.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "acompanhamento_odontologico.editar", entity: "grupo3.acompanhamento_odontologico",
        entityId: atual.id, payload: { resultado: "sucesso", situacao: { anterior: atual.situacao, novo: b.situacao } },
      });
    });
    res.json(await buscarAcompanhamento(req.params.id));
  }),
);

// ============================ Tratamento externo (US-088) ============================

const selectTratamento = `
  SELECT t.id, t.idoso_ref, t.agendamento_id, t.area::text AS area, t.tipo, t.local_externo,
         to_char(t.data, 'YYYY-MM-DD') AS data, t.profissional_nome, t.instituicao, t.observacoes,
         t.criado_em, t.atualizado_em, u.id AS criado_por_id, u.name AS criado_por_nome
  FROM grupo3.tratamento_externo t
  LEFT JOIN public.users u ON u.ref = t.criado_por_ref
`;

function paraTratamento(row, idosos) {
  const idoso = idosos.get(row.idoso_ref);
  return {
    id: row.id,
    idoso: idoso ? { id: idoso.id, nome: idoso.nome } : null,
    agendamentoId: row.agendamento_id,
    area: row.area,
    tipo: row.tipo,
    localExterno: row.local_externo,
    data: row.data,
    profissionalNome: row.profissional_nome,
    instituicao: row.instituicao,
    observacoes: row.observacoes,
    registradoPor: row.criado_por_id ? { id: row.criado_por_id, nome: row.criado_por_nome } : null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function buscarTratamento(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectTratamento} WHERE t.id = $1::uuid`, id);
  if (!rows[0]) return null;
  return paraTratamento(rows[0], await buscarIdososPorRef([rows[0].idoso_ref], db));
}

const corpoTratamento = z.object({
  idosoId,
  agendamentoId: opcional(uuid),
  area: z.enum(["medica", "odontologica", "outra"]),
  tipo: z.string().trim().min(2).max(120),
  localExterno: z.string().trim().min(2).max(160),
  data: dia,
  profissionalNome: opcional(z.string().trim().min(2).max(160)),
  instituicao: opcional(z.string().trim().min(2).max(160)),
  observacoes: opcional(z.string().trim().min(1).max(4000)),
});

async function validarTratamento(db, b) {
  const idoso = await buscarIdoso(b.idosoId);
  if (!idoso) throw erroCampo("idosoId", "Idoso não encontrado.");
  if (b.data > await hojeInstitucional(db)) throw erroCampo("data", "Tratamento externo é registrado depois de realizado (data futura).");
  if (b.agendamentoId) {
    const rows = await db.$queryRaw`SELECT idoso_ref FROM grupo3.agendamento WHERE id = ${b.agendamentoId}::uuid`;
    if (!rows[0]) throw erroCampo("agendamentoId", "Agendamento não encontrado.");
    if (rows[0].idoso_ref !== idoso.ref) throw erroCampo("agendamentoId", "O agendamento é de outro idoso.");
  }
  return idoso;
}

router.get(
  "/tratamentos-externos",
  requirePerm(VER),
  validate(pageSchema.extend({
    idosoId: idosoId.optional(),
    area: z.enum(["medica", "odontologica", "outra"]).optional(),
    inicio: dia.optional(),
    fim: dia.optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, area, inicio, fim } = req.query;
    const idoso = req.query.idosoId ? await idosoVisivel(req, req.query.idosoId) : null;
    const rows = await prisma.$queryRawUnsafe(
      `${selectTratamento.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
       WHERE ($1::uuid IS NULL OR t.idoso_ref = $1::uuid) AND ($2::text IS NULL OR t.area::text = $2)
         AND ($3::date IS NULL OR t.data >= $3::date) AND ($4::date IS NULL OR t.data <= $4::date)
       ORDER BY t.data DESC, t.criado_em DESC LIMIT $5 OFFSET $6`,
      idoso?.ref ?? null, area ?? null, inicio ?? null, fim ?? null, limit, (page - 1) * limit,
    );
    const idosos = await buscarIdososPorRef(rows.map((row) => row.idoso_ref));
    const data = rows.map((row) => paraTratamento(row, idosos));
    await auditarLeitura(req, {
      entidade: "tratamento_externo", rota: "GET /tratamentos-externos", idosoIds: data.map((t) => t.idoso?.id), ids: data.map((t) => t.id),
    });
    res.json({ data, meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

router.get("/tratamentos-externos/:id", requirePerm(VER), validate(idParam, "params"), asyncHandler(async (req, res) => {
  const tratamento = await buscarTratamento(req.params.id);
  if (!tratamento) notFound("Tratamento externo não encontrado.");
  if (!(await podeVerIdoso(req.user, tratamento.idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
  await auditarLeitura(req, { entidade: "tratamento_externo", rota: "GET /tratamentos-externos/{id}", idosoIds: [tratamento.idoso?.id], ids: [tratamento.id] });
  res.json(tratamento);
}));

router.post(
  "/tratamentos-externos",
  requirePerm(CRIAR),
  validate(corpoTratamento),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const id = await prisma.$transaction(async (tx) => {
      const idoso = await validarTratamento(tx, b);
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.tratamento_externo (idoso_ref, agendamento_id, area, tipo, local_externo, data, profissional_nome, instituicao, observacoes, criado_por_ref)
        VALUES (${idoso.ref}::uuid, ${b.agendamentoId}::uuid, ${b.area}::grupo3.area_tratamento_externo, ${b.tipo}, ${b.localExterno},
                ${b.data}::date, ${b.profissionalNome}, ${b.instituicao}, ${b.observacoes}, ${req.user.ref}::uuid)
        RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "tratamento_externo.criar", entity: "grupo3.tratamento_externo", entityId: rows[0].id,
        payload: { resultado: "sucesso", idosoId: idoso.id, area: b.area },
      });
      return rows[0].id;
    });
    res.status(201).json(await buscarTratamento(id));
  }),
);

router.put(
  "/tratamentos-externos/:id",
  requirePerm(EDITAR),
  validate(idParam, "params"),
  validate(corpoTratamento),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const atual = await buscarTratamento(req.params.id, tx);
      if (!atual) notFound("Tratamento externo não encontrado.");
      if (atual.idoso?.id !== b.idosoId) throw erroCampo("idosoId", "O idoso do tratamento não pode ser trocado.");
      await validarTratamento(tx, b);
      await tx.$executeRaw`
        UPDATE grupo3.tratamento_externo
        SET agendamento_id = ${b.agendamentoId}::uuid, area = ${b.area}::grupo3.area_tratamento_externo, tipo = ${b.tipo},
            local_externo = ${b.localExterno}, data = ${b.data}::date, profissional_nome = ${b.profissionalNome},
            instituicao = ${b.instituicao}, observacoes = ${b.observacoes}
        WHERE id = ${atual.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: "tratamento_externo.editar", entity: "grupo3.tratamento_externo", entityId: atual.id,
        payload: { resultado: "sucesso", idosoId: b.idosoId },
      });
    });
    res.json(await buscarTratamento(req.params.id));
  }),
);

// ============================ Ciclo odontológico (US-089) ============================

async function configuracaoCiclo(db = prisma) {
  const rows = await db.$queryRaw`SELECT valor FROM grupo3.configuracao WHERE chave = 'odontologia.ciclo'`;
  return rows[0]?.valor ?? { modo: "semestre_civil", dias: 180 };
}

router.get("/odontologia/configuracao-ciclo", requirePerm(VER), asyncHandler(async (_req, res) => {
  res.json(await configuracaoCiclo());
}));

router.put(
  "/odontologia/configuracao-ciclo",
  requirePerm(ADMIN),
  validate(z.object({ modo: z.enum(["semestre_civil", "dias_corridos"]), dias: z.number().int().min(30).max(730).default(180) })),
  asyncHandler(async (req, res) => {
    const anterior = await configuracaoCiclo();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE grupo3.configuracao SET valor = ${JSON.stringify(req.body)}::jsonb, atualizado_em = now() WHERE chave = 'odontologia.ciclo'
      `;
      await audit(tx, {
        userId: req.user.id, action: "odontologia.configuracao_ciclo", entity: "grupo3.configuracao", entityId: "odontologia.ciclo",
        payload: { resultado: "sucesso", anterior, novo: req.body },
      });
    });
    res.json(req.body);
  }),
);

// Idosos sem registro odontológico (registro clínico finalizado ou tratamento externo) no ciclo vigente.
router.get(
  "/odontologia/pendencias",
  requirePerm(VER),
  validate(pageSchema.extend({ ciclo: z.string().trim().max(10).optional(), referencia: dia.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const config = await configuracaoCiclo();
    let periodo;
    try {
      periodo = periodoDoCiclo(config, { ciclo: req.query.ciclo, referencia: req.query.referencia }, await hojeInstitucional());
    } catch (error) {
      if (error.campo) throw erroCampo(error.campo, error.message);
      throw error;
    }
    const rows = await prisma.$queryRaw`
      WITH registros AS (
        SELECT idoso_ref, (realizado_em AT TIME ZONE grupo3.fuso_horario())::date AS data
        FROM grupo3.registro_clinico WHERE area = 'odontologica' AND status = 'finalizado'
        UNION ALL
        SELECT idoso_ref, data FROM grupo3.tratamento_externo WHERE area = 'odontologica'
      ),
      situacao AS (
        SELECT p.id, p.ref, p.name,
               bool_or(r.data BETWEEN ${periodo.inicio}::date AND ${periodo.fim}::date) AS no_ciclo,
               max(r.data) FILTER (WHERE r.data <= ${periodo.fim}::date) AS ultimo
        FROM public.patients p
        LEFT JOIN registros r ON r.idoso_ref = p.ref
        GROUP BY p.id, p.ref, p.name
      )
      SELECT s.id, s.name, to_char(s.ultimo, 'YYYY-MM-DD') AS ultimo, a.situacao::text AS acompanhamento,
             count(*) OVER()::int AS total,
             (SELECT count(*)::int FROM situacao) AS total_idosos
      FROM situacao s
      LEFT JOIN grupo3.acompanhamento_odontologico a
        ON a.idoso_ref = s.ref AND a.situacao IN ('em_tratamento','em_acompanhamento')
      WHERE s.no_ciclo IS NOT TRUE
      ORDER BY s.ultimo NULLS FIRST, s.name
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `;
    const pendentes = rows[0]?.total ?? 0;
    const totalIdosos = rows[0]?.total_idosos ?? Number((await prisma.$queryRaw`SELECT count(*)::int AS n FROM public.patients`)[0].n);
    const data = rows.map((row) => ({
      idoso: { id: row.id, nome: row.name },
      ultimoRegistro: row.ultimo,
      acompanhamentoAtivo: row.acompanhamento ?? null,
    }));
    await auditarLeitura(req, { entidade: "odontologia_pendencias", rota: "GET /odontologia/pendencias", idosoIds: data.map((d) => d.idoso.id) });
    res.json({
      ciclo: periodo,
      resumo: { totalIdosos, comRegistroNoCiclo: totalIdosos - pendentes, pendentes },
      data,
      meta: pageMeta(page, limit, pendentes),
    });
  }),
);

export default router;

// E07 — Agenda única: US-066, US-067, US-068, US-069, US-072, US-073.
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  buscarAgendamento,
  buscarConflitos,
  colaboradorDoUsuario,
  erroConflito,
  listarAgendamentos,
  listarHistorico,
  mascararLista,
  periodoAgenda,
  registrarHistorico,
  resumoAgenda,
  travarAgendamento,
  travarProfissional,
} from "../../grupo3/agenda.js";
import { cancelarLembretes, gerarLembretes, listarLembretes } from "../../grupo3/lembretes.js";
import { buscarIdoso } from "../../grupo3/portas/idosos.js";
import { podeVerIdoso } from "../../grupo3/portas/prontuario.js";
import {
  calcularFim, ehConsulta, exigeMotivo, janelaValida, mascarar, mascararHistorico, motivoValido, podeAlterar, podeRegistrarRealizacao,
} from "../../grupo3/regras.js";
import {
  categoria,
  dataHora,
  dia,
  duracaoMin,
  horario,
  idParam,
  idosoId,
  motivo,
  statusAgendamento,
  temPermissao,
  texto,
  uuid,
  validarIntervalo,
} from "../../grupo3/validacao.js";

const router = Router();

const janelaRefine = [
  (q) => janelaValida(q.janelaInicio, q.janelaFim),
  { message: "O fim da janela precisa ser depois do início.", path: ["janelaFim"] },
];

const filtrosBase = pageSchema.extend({
  inicio: dataHora.optional(),
  fim: dataHora.optional(),
  profissionalId: uuid.optional(),
  responsavelRealizacaoId: uuid.optional(),
  idosoId: idosoId.optional(),
  tipoId: uuid.optional(),
  categoria: categoria.optional(),
  status: statusAgendamento.optional(),
  janelaInicio: horario.optional(),
  janelaFim: horario.optional(),
});
const filtrosQuery = filtrosBase.refine(...janelaRefine);

const agendaQuery = z.object({
  visao: z.enum(["dia", "semana", "mes"]).default("semana"),
  data: dia.optional(),
  status: statusAgendamento.optional(),
});

function erroCampo(path, message) {
  return new HttpError(422, "Dados inválidos", [{ path, message }]);
}

// US-085 — consulta fora da escala do profissional é aceita, com aviso.
async function avisosDeEscala(db, categoria, profissionalId, inicio, fim) {
  if (!ehConsulta(categoria)) return [];
  const rows = await db.$queryRaw`
    SELECT 1 FROM grupo3.escala
    WHERE colaborador_id = ${profissionalId}::uuid AND situacao <> 'cancelada' AND inicio <= ${inicio} AND fim >= ${fim}
    LIMIT 1
  `;
  return rows.length ? [] : [{ codigo: "fora_da_escala", mensagem: "O profissional não está na escala nesse horário." }];
}

async function carregarTipo(db, id) {
  const rows = await db.$queryRaw`
    SELECT id, nome, categoria::text AS categoria, duracao_padrao_min, permite_sobreposicao, ativo
    FROM grupo3.tipo_atendimento WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
}

async function carregarProfissional(db, id) {
  const rows = await db.$queryRaw`SELECT id, nome, status::text AS status FROM grupo3.colaborador WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

async function exigirProfissionalAtivo(db, id, campo = "profissionalId") {
  const profissional = await carregarProfissional(db, id);
  if (!profissional) throw erroCampo(campo, "Profissional não encontrado.");
  if (profissional.status !== "ativo") throw erroCampo(campo, "Profissional inativo.");
  return profissional;
}

// Recusa por conflito também entra na auditoria (NFR-003: resultado da operação).
async function auditarRecusa(req, action, entityId, error) {
  if (error instanceof HttpError && error.status === 409 && error.details?.conflitos) {
    await audit(prisma, {
      userId: req.user.id, action, entity: "grupo3.agendamento", entityId,
      payload: { resultado: "recusado_conflito", conflitos: error.details.conflitos.map((c) => c.agendamentoId) },
    });
  }
}

// Acesso ao agendamento: permissão de agenda ou ser o profissional do próprio agendamento.
async function acessarAgendamento(req, id) {
  const agendamento = await buscarAgendamento(id);
  if (!agendamento) notFound("Agendamento não encontrado.");
  const colaborador = await colaboradorDoUsuario(req.user);
  const proprio = colaborador && agendamento.profissional.id === colaborador.id;
  if (!proprio && !temPermissao(req.user, "agenda.visualizar")) {
    throw new HttpError(403, "Você não tem autorização para esta ação.");
  }
  return { agendamento, colaborador };
}

// ---------- Consulta ----------

router.get(
  "/agendamentos",
  requirePerm("agenda.visualizar"),
  validate(filtrosQuery, "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, idosoId: idosoParam, ...filtros } = req.query;
    validarIntervalo(filtros.inicio, filtros.fim);
    let idosoRef;
    if (idosoParam) {
      const idoso = await buscarIdoso(idosoParam);
      if (!idoso) return res.json({ data: [], meta: pageMeta(page, limit, 0) });
      idosoRef = idoso.ref;
    }
    const colaborador = await colaboradorDoUsuario(req.user);
    const { data, total } = await listarAgendamentos({ ...filtros, idosoRef }, { limit, offset: (page - 1) * limit });
    res.json({ data: mascararLista(data, req.user, colaborador?.id), meta: pageMeta(page, limit, total) });
  }),
);

router.get(
  "/agendamentos/:id",
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const { agendamento, colaborador } = await acessarAgendamento(req, req.params.id);
    res.json(mascarar(agendamento, req.user, colaborador?.id));
  }),
);

router.get(
  "/agendamentos/:id/historico",
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const { agendamento, colaborador } = await acessarAgendamento(req, req.params.id);
    const proprio = colaborador?.id === agendamento.profissional.id;
    const itens = await listarHistorico(agendamento.id);
    res.json({ data: itens.map((item) => mascararHistorico(item, agendamento.tipo.categoria, req.user, proprio)) });
  }),
);

// US-074 — status dos lembretes do agendamento.
router.get(
  "/agendamentos/:id/lembretes",
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const { agendamento } = await acessarAgendamento(req, req.params.id);
    res.json({ data: await listarLembretes(agendamento.id) });
  }),
);

async function agendaDoColaborador(req, res, colaborador) {
  const { visao, data, status } = req.query;
  const periodo = await periodoAgenda(visao, data ?? null);
  const { data: itens } = await listarAgendamentos({
    profissionalId: colaborador.id, inicio: periodo.inicio, fim: periodo.fim, status,
  });
  const visiveis = mascararLista(itens, req.user, (await colaboradorDoUsuario(req.user))?.id);
  res.json({
    colaborador: { id: colaborador.id, nome: colaborador.nome, vinculo: colaborador.vinculo },
    periodo: { visao, data: periodo.data, inicio: periodo.inicio, fim: periodo.fim, fuso: periodo.fuso },
    resumo: resumoAgenda(visiveis),
    data: visiveis,
  });
}

router.get(
  "/colaboradores/:id/agenda",
  requirePerm("agenda.visualizar"),
  validate(idParam, "params"),
  validate(agendaQuery, "query"),
  asyncHandler(async (req, res) => {
    const colaborador = await prisma.$queryRaw`
      SELECT id, nome, vinculo::text AS vinculo FROM grupo3.colaborador WHERE id = ${req.params.id}::uuid
    `;
    if (!colaborador[0]) notFound("Colaborador não encontrado.");
    await agendaDoColaborador(req, res, colaborador[0]);
  }),
);

// Qualquer usuário autenticado vê a própria agenda; o voluntário só tem esta visão (D-001).
router.get(
  "/me/agenda",
  validate(agendaQuery, "query"),
  asyncHandler(async (req, res) => {
    const colaborador = await colaboradorDoUsuario(req.user);
    if (!colaborador) notFound("Seu usuário não está vinculado a um colaborador da equipe.");
    await agendaDoColaborador(req, res, colaborador);
  }),
);

// US-070 / US-071 — agenda específica de uma categoria (farmácia, cuidados pessoais) por período,
// com filtro por responsável e janela de atendimento.
const visaoCategoriaQuery = z.object({
  visao: z.enum(["dia", "semana", "mes"]).default("semana"),
  data: dia.optional(),
  profissionalId: uuid.optional(),
  responsavelRealizacaoId: uuid.optional(),
  status: statusAgendamento.optional(),
  janelaInicio: horario.optional(),
  janelaFim: horario.optional(),
}).refine(...janelaRefine);

function agendaPorCategoria(categoriaFixa) {
  return asyncHandler(async (req, res) => {
    const { visao, data, ...filtros } = req.query;
    const periodo = await periodoAgenda(visao, data ?? null);
    const { data: itens } = await listarAgendamentos({ ...filtros, categoria: categoriaFixa, inicio: periodo.inicio, fim: periodo.fim });
    const colaborador = await colaboradorDoUsuario(req.user);
    const visiveis = mascararLista(itens, req.user, colaborador?.id);
    const porProfissional = new Map();
    for (const item of visiveis) {
      const atual = porProfissional.get(item.profissional.id) ?? { ...item.profissional, total: 0 };
      atual.total += 1;
      porProfissional.set(item.profissional.id, atual);
    }
    res.json({
      categoria: categoriaFixa,
      periodo: { visao, data: periodo.data, inicio: periodo.inicio, fim: periodo.fim, fuso: periodo.fuso },
      janela: filtros.janelaInicio || filtros.janelaFim ? { inicio: filtros.janelaInicio ?? null, fim: filtros.janelaFim ?? null } : null,
      resumo: resumoAgenda(visiveis),
      porProfissional: [...porProfissional.values()],
      data: visiveis,
    });
  });
}

router.get("/agendas/farmacia", requirePerm("agenda.visualizar"), validate(visaoCategoriaQuery, "query"), agendaPorCategoria("farmacia"));
router.get("/agendas/cuidados-pessoais", requirePerm("agenda.visualizar"), validate(visaoCategoriaQuery, "query"), agendaPorCategoria("cuidado_pessoal"));

// US-071 — por serviço de cuidado pessoal: última realização, próximo agendamento e total realizado.
router.get(
  "/idosos/:idosoId/cuidados-pessoais",
  requirePerm("agenda.visualizar"),
  validate(z.object({ idosoId }), "params"),
  asyncHandler(async (req, res) => {
    const idoso = await buscarIdoso(req.params.idosoId);
    if (!idoso) notFound("Idoso não encontrado.");
    const rows = await prisma.$queryRaw`
      SELECT t.id AS tipo_id, t.nome AS tipo_nome,
             count(*) FILTER (WHERE a.status = 'realizado')::int AS total_realizados,
             (SELECT row_to_json(x) FROM (
                SELECT u.id, u.inicio, r.id AS responsavel_id, r.nome AS responsavel_nome
                FROM grupo3.agendamento u LEFT JOIN grupo3.colaborador r ON r.id = u.responsavel_realizacao_id
                WHERE u.idoso_ref = ${idoso.ref}::uuid AND u.tipo_id = t.id AND u.status = 'realizado'
                ORDER BY u.inicio DESC LIMIT 1) x) AS ultima,
             (SELECT row_to_json(y) FROM (
                SELECT p.id, p.inicio, c.id AS profissional_id, c.nome AS profissional_nome
                FROM grupo3.agendamento p JOIN grupo3.colaborador c ON c.id = p.profissional_id
                WHERE p.idoso_ref = ${idoso.ref}::uuid AND p.tipo_id = t.id AND p.status = 'agendado' AND p.fim > now()
                ORDER BY p.inicio LIMIT 1) y) AS proximo
      FROM grupo3.agendamento a
      JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
      WHERE a.idoso_ref = ${idoso.ref}::uuid AND t.categoria = 'cuidado_pessoal'
      GROUP BY t.id, t.nome
      ORDER BY t.nome
    `;
    res.json({
      idoso: { id: idoso.id, nome: idoso.nome },
      data: rows.map((row) => ({
        tipo: { id: row.tipo_id, nome: row.tipo_nome },
        totalRealizados: row.total_realizados,
        ultimaRealizacao: row.ultima
          ? {
            agendamentoId: row.ultima.id,
            inicio: row.ultima.inicio,
            responsavel: row.ultima.responsavel_id ? { id: row.ultima.responsavel_id, nome: row.ultima.responsavel_nome } : null,
          }
          : null,
        proximoAgendamento: row.proximo
          ? {
            agendamentoId: row.proximo.id,
            inicio: row.proximo.inicio,
            profissional: { id: row.proximo.profissional_id, nome: row.proximo.profissional_nome },
          }
          : null,
      })),
    });
  }),
);

// US-072 — histórico de atendimentos do idoso.
router.get(
  "/idosos/:idosoId/atendimentos",
  requirePerm("agenda.visualizar"),
  validate(z.object({ idosoId }), "params"),
  validate(filtrosBase.omit({ idosoId: true }).refine(...janelaRefine), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, ...filtros } = req.query;
    validarIntervalo(filtros.inicio, filtros.fim);
    const idoso = await buscarIdoso(req.params.idosoId);
    if (!idoso) notFound("Idoso não encontrado.");
    if (!(await podeVerIdoso(req.user, idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
    const colaborador = await colaboradorDoUsuario(req.user);
    const { data, total } = await listarAgendamentos(
      { ...filtros, idosoRef: idoso.ref },
      { limit, offset: (page - 1) * limit, ordem: "desc" },
    );
    res.json({
      idoso: { id: idoso.id, nome: idoso.nome },
      data: mascararLista(data, req.user, colaborador?.id),
      meta: pageMeta(page, limit, total),
    });
  }),
);

// ---------- Conflitos (US-073) ----------

router.post(
  "/agendamentos/verificar-conflitos",
  requirePerm("agenda.criar", "agenda.editar"),
  validate(z.object({
    profissionalId: uuid,
    tipoId: uuid,
    inicio: dataHora,
    duracaoMin: duracaoMin.optional(),
    ignorarAgendamentoId: uuid.optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const tipo = await carregarTipo(prisma, b.tipoId);
    if (!tipo) throw erroCampo("tipoId", "Tipo de atendimento não encontrado.");
    const duracao = b.duracaoMin ?? tipo.duracao_padrao_min;
    const fim = calcularFim(b.inicio, duracao);
    const conflitos = await buscarConflitos(prisma, {
      profissionalId: b.profissionalId, tipoId: tipo.id, permiteSobreposicao: tipo.permite_sobreposicao,
      inicio: b.inicio, fim, ignorarId: b.ignorarAgendamentoId ?? null,
    });
    const avisos = await avisosDeEscala(prisma, tipo.categoria, b.profissionalId, b.inicio, fim);
    res.json({ temConflito: conflitos.length > 0, inicio: b.inicio, fim, conflitos, avisos });
  }),
);

// ---------- Escrita ----------

// Sessão de fisioterapia ligada a plano (US-079): o plano precisa ser do mesmo idoso e estar ativo;
// fora do período do plano a sessão é aceita com aviso.
async function avisosDoPlano(db, { planoId, categoria, idosoRef, inicio }) {
  if (!planoId) return [];
  if (categoria !== "fisioterapia") throw erroCampo("planoFisioterapiaId", "Plano de fisioterapia só em sessão de fisioterapia.");
  const rows = await db.$queryRaw`
    SELECT idoso_ref, situacao::text AS situacao,
           (${inicio}::timestamptz AT TIME ZONE grupo3.fuso_horario())::date AS dia,
           data_inicio, data_fim
    FROM grupo3.plano_fisioterapia WHERE id = ${planoId}::uuid
  `;
  const plano = rows[0];
  if (!plano) throw erroCampo("planoFisioterapiaId", "Plano de fisioterapia não encontrado.");
  if (plano.idoso_ref !== idosoRef) throw erroCampo("planoFisioterapiaId", "O plano é de outro idoso.");
  if (plano.situacao !== "ativo") throw erroCampo("planoFisioterapiaId", "O plano não está ativo.");
  const dentro = plano.dia >= plano.data_inicio && (!plano.data_fim || plano.dia <= plano.data_fim);
  return dentro ? [] : [{ codigo: "fora_do_periodo_do_plano", mensagem: "A sessão está fora do período do plano de fisioterapia." }];
}

/**
 * Cria um agendamento dentro de uma transação já aberta (usado por POST /agendamentos e pela programação
 * semanal da fisioterapia). Valida tipo, profissional, local de consulta e conflito; gera lembretes,
 * histórico e auditoria. Devolve { id, avisos }.
 */
export async function criarAgendamento(tx, usuario, idoso, b) {
  const tipo = await carregarTipo(tx, b.tipoId);
  if (!tipo) throw erroCampo("tipoId", "Tipo de atendimento não encontrado.");
  if (!tipo.ativo) throw erroCampo("tipoId", "Tipo de atendimento inativo.");
  await exigirProfissionalAtivo(tx, b.profissionalId);
  if (ehConsulta(tipo.categoria) && !b.local) throw erroCampo("local", "Consulta exige o local do atendimento.");
  const avisosPlano = await avisosDoPlano(tx, { planoId: b.planoFisioterapiaId, categoria: tipo.categoria, idosoRef: idoso.ref, inicio: b.inicio });
  const duracao = b.duracaoMin ?? tipo.duracao_padrao_min;
  const fim = calcularFim(b.inicio, duracao);
  await travarProfissional(tx, b.profissionalId);
  const conflitos = await buscarConflitos(tx, {
    profissionalId: b.profissionalId, tipoId: tipo.id, permiteSobreposicao: tipo.permite_sobreposicao,
    inicio: b.inicio, fim,
  });
  if (conflitos.length) throw erroConflito(conflitos);
  const rows = await tx.$queryRaw`
    INSERT INTO grupo3.agendamento (idoso_ref, tipo_id, profissional_id, inicio, duracao_min, local, observacoes, plano_fisioterapia_id, criado_por_ref)
    VALUES (${idoso.ref}::uuid, ${tipo.id}::uuid, ${b.profissionalId}::uuid, ${b.inicio}, ${duracao},
            ${b.local ?? null}, ${b.observacoes ?? null}, ${b.planoFisioterapiaId ?? null}::uuid, ${usuario.ref}::uuid)
    RETURNING id
  `;
  const novoId = rows[0].id;
  await gerarLembretes(tx, novoId);
  await registrarHistorico(tx, {
    agendamentoId: novoId, acao: "criado", autorRef: usuario.ref,
    novo: { inicio: b.inicio, duracaoMin: duracao, profissionalId: b.profissionalId, tipoId: tipo.id, status: "agendado" },
  });
  await audit(tx, {
    userId: usuario.id, action: "agendamento.criar", entity: "grupo3.agendamento", entityId: novoId,
    payload: { resultado: "sucesso", tipoId: tipo.id, profissionalId: b.profissionalId, inicio: b.inicio, planoFisioterapiaId: b.planoFisioterapiaId ?? null },
  });
  return { id: novoId, avisos: [...(await avisosDeEscala(tx, tipo.categoria, b.profissionalId, b.inicio, fim)), ...avisosPlano] };
}

export async function exigirIdosoAtivo(idosoIdParam) {
  const idoso = await buscarIdoso(idosoIdParam);
  if (!idoso) throw erroCampo("idosoId", "Idoso não encontrado.");
  if (!idoso.ativo) throw erroCampo("idosoId", "Idoso inativo.");
  return idoso;
}

export { auditarRecusa };

router.post(
  "/agendamentos",
  requirePerm("agenda.criar"),
  validate(z.object({
    idosoId,
    tipoId: uuid,
    profissionalId: uuid,
    inicio: dataHora,
    duracaoMin: duracaoMin.optional(),
    local: texto(120).nullish(),
    observacoes: texto(2000).nullish(),
    planoFisioterapiaId: uuid.nullish(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const idoso = await exigirIdosoAtivo(b.idosoId);
    let resultado;
    try {
      resultado = await prisma.$transaction((tx) => criarAgendamento(tx, req.user, idoso, b));
    } catch (error) {
      await auditarRecusa(req, "agendamento.criar", null, error);
      throw error;
    }
    res.status(201).json({ ...(await buscarAgendamento(resultado.id)), avisos: resultado.avisos });
  }),
);

router.post(
  "/agendamentos/:id/reagendar",
  requirePerm("agenda.editar"),
  validate(idParam, "params"),
  validate(z.object({
    inicio: dataHora,
    duracaoMin: duracaoMin.optional(),
    profissionalId: uuid.optional(),
    motivo: motivo.optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    let avisos;
    try {
      avisos = await prisma.$transaction(async (tx) => {
        const atual = await travarAgendamento(tx, req.params.id);
        if (!atual) notFound("Agendamento não encontrado.");
        if (!podeAlterar(atual.status)) throw new HttpError(409, `Agendamento ${atual.status.replace("_", " ")} não pode ser reagendado.`);
        if (exigeMotivo({ exigeMotivoReagendamento: atual.exige_motivo_reagendamento }, "reagendar") && !motivoValido(b.motivo)) {
          throw erroCampo("motivo", "Este tipo de atendimento exige motivo para reagendar.");
        }
        const profissionalId = b.profissionalId ?? atual.profissional_id;
        const duracao = b.duracaoMin ?? atual.duracao_min;
        const mudou = b.inicio.getTime() !== atual.inicio.getTime() || duracao !== atual.duracao_min || profissionalId !== atual.profissional_id;
        if (!mudou) throw erroCampo("inicio", "Informe nova data/hora, duração ou profissional.");
        if (profissionalId !== atual.profissional_id) await exigirProfissionalAtivo(tx, profissionalId);
        const fim = calcularFim(b.inicio, duracao);
        await travarProfissional(tx, profissionalId);
        const conflitos = await buscarConflitos(tx, {
          profissionalId, tipoId: atual.tipo_id, permiteSobreposicao: atual.permite_sobreposicao,
          inicio: b.inicio, fim, ignorarId: atual.id,
        });
        if (conflitos.length) throw erroConflito(conflitos);
        await tx.$executeRaw`
          UPDATE grupo3.agendamento
          SET inicio = ${b.inicio}, duracao_min = ${duracao}, profissional_id = ${profissionalId}::uuid
          WHERE id = ${atual.id}::uuid
        `;
        await cancelarLembretes(tx, atual.id);
        await gerarLembretes(tx, atual.id);
        const anterior = { inicio: atual.inicio, duracaoMin: atual.duracao_min, profissionalId: atual.profissional_id };
        const novo = { inicio: b.inicio, duracaoMin: duracao, profissionalId };
        await registrarHistorico(tx, { agendamentoId: atual.id, acao: "reagendado", anterior, novo, motivo: b.motivo ?? null, autorRef: req.user.ref });
        await audit(tx, {
          userId: req.user.id, action: "agendamento.reagendar", entity: "grupo3.agendamento", entityId: atual.id,
          payload: { resultado: "sucesso", anterior, novo },
        });
        const avisosPlano = await avisosDoPlano(tx, {
          planoId: atual.plano_fisioterapia_id, categoria: atual.categoria, idosoRef: atual.idoso_ref, inicio: b.inicio,
        });
        return [...(await avisosDeEscala(tx, atual.categoria, profissionalId, b.inicio, fim)), ...avisosPlano];
      });
    } catch (error) {
      await auditarRecusa(req, "agendamento.reagendar", req.params.id, error);
      throw error;
    }
    const colaborador = await colaboradorDoUsuario(req.user);
    res.json({ ...mascarar(await buscarAgendamento(req.params.id), req.user, colaborador?.id), avisos });
  }),
);

router.post(
  "/agendamentos/:id/cancelar",
  requirePerm("agenda.editar"),
  validate(idParam, "params"),
  validate(z.object({ motivo: motivo.optional() })),
  asyncHandler(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const atual = await travarAgendamento(tx, req.params.id);
      if (!atual) notFound("Agendamento não encontrado.");
      if (!podeAlterar(atual.status)) throw new HttpError(409, `Agendamento ${atual.status.replace("_", " ")} não pode ser cancelado.`);
      if (exigeMotivo({ exigeMotivoCancelamento: atual.exige_motivo_cancelamento }, "cancelar") && !motivoValido(req.body.motivo)) {
        throw erroCampo("motivo", "Este tipo de atendimento exige motivo para cancelar.");
      }
      await tx.$executeRaw`
        UPDATE grupo3.agendamento
        SET status = 'cancelado', motivo_status = ${req.body.motivo ?? null}, concluido_em = now(),
            registrado_por_ref = ${req.user.ref}::uuid
        WHERE id = ${atual.id}::uuid
      `;
      await cancelarLembretes(tx, atual.id);
      await registrarHistorico(tx, {
        agendamentoId: atual.id, acao: "cancelado", anterior: { status: "agendado" }, novo: { status: "cancelado" },
        motivo: req.body.motivo ?? null, autorRef: req.user.ref,
      });
      await audit(tx, {
        userId: req.user.id, action: "agendamento.cancelar", entity: "grupo3.agendamento", entityId: atual.id,
        payload: { resultado: "sucesso" },
      });
    });
    const colaborador = await colaboradorDoUsuario(req.user);
    res.json(mascarar(await buscarAgendamento(req.params.id), req.user, colaborador?.id));
  }),
);

// US-069 — realizado / não realizado, com responsável e observação.
// O responsável padrão é o profissional do agendamento; quem registrou fica em registrado_por_ref.
router.post(
  "/agendamentos/:id/realizacao",
  requirePerm("agenda.editar"),
  validate(idParam, "params"),
  validate(z.object({
    status: z.enum(["realizado", "nao_realizado"]),
    responsavelId: uuid.optional(),
    observacao: texto(2000).nullish(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const atual = await travarAgendamento(tx, req.params.id);
      if (!atual) notFound("Agendamento não encontrado.");
      if (!podeAlterar(atual.status)) throw new HttpError(409, `Agendamento já está ${atual.status.replace("_", " ")}.`);
      if (!podeRegistrarRealizacao(atual.inicio, atual.tolerancia_realizacao_min)) {
        throw erroCampo("status", `A realização só pode ser registrada a partir de ${atual.tolerancia_realizacao_min} min antes do início.`);
      }
      const responsavelId = b.responsavelId ?? atual.profissional_id;
      if (b.responsavelId && !(await carregarProfissional(tx, responsavelId))) {
        throw erroCampo("responsavelId", "Responsável não encontrado.");
      }
      await tx.$executeRaw`
        UPDATE grupo3.agendamento
        SET status = ${b.status}::grupo3.status_agendamento, responsavel_realizacao_id = ${responsavelId}::uuid,
            observacao_realizacao = ${b.observacao ?? null}, concluido_em = now(), registrado_por_ref = ${req.user.ref}::uuid
        WHERE id = ${atual.id}::uuid
      `;
      await cancelarLembretes(tx, atual.id);
      await registrarHistorico(tx, {
        agendamentoId: atual.id, acao: b.status, anterior: { status: "agendado" },
        novo: { status: b.status, responsavelId, observacaoRealizacao: b.observacao ?? null }, autorRef: req.user.ref,
      });
      await audit(tx, {
        userId: req.user.id, action: `agendamento.${b.status}`, entity: "grupo3.agendamento", entityId: atual.id,
        payload: { resultado: "sucesso", responsavelId },
      });
    });
    const colaborador = await colaboradorDoUsuario(req.user);
    res.json(mascarar(await buscarAgendamento(req.params.id), req.user, colaborador?.id));
  }),
);

// Correção de realização já registrada. Só administração da agenda, com motivo. O gatilho do banco
// só aceita esta alteração com grupo3.correcao_realizacao ligado na transação e apenas nos campos
// da realização.
router.post(
  "/agendamentos/:id/corrigir-realizacao",
  requirePerm("agenda.administrar"),
  validate(idParam, "params"),
  validate(z.object({
    motivo,
    status: z.enum(["realizado", "nao_realizado"]).optional(),
    responsavelId: uuid.optional(),
    observacao: texto(2000).nullable().optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await prisma.$transaction(async (tx) => {
      const atual = await travarAgendamento(tx, req.params.id);
      if (!atual) notFound("Agendamento não encontrado.");
      if (!["realizado", "nao_realizado"].includes(atual.status)) {
        throw new HttpError(409, "Só é possível corrigir agendamento realizado ou não realizado.");
      }
      if (b.responsavelId && !(await carregarProfissional(tx, b.responsavelId))) {
        throw erroCampo("responsavelId", "Responsável não encontrado.");
      }
      const anterior = {
        status: atual.status, responsavelId: atual.responsavel_realizacao_id, observacaoRealizacao: atual.observacao_realizacao,
      };
      const novo = {
        status: b.status ?? anterior.status,
        responsavelId: b.responsavelId ?? anterior.responsavelId,
        observacaoRealizacao: b.observacao !== undefined ? b.observacao : anterior.observacaoRealizacao,
      };
      if (Object.keys(novo).every((campo) => novo[campo] === anterior[campo])) {
        throw erroCampo("status", "Informe ao menos um campo diferente do registro atual.");
      }
      await tx.$queryRaw`SELECT set_config('grupo3.correcao_realizacao', 'on', true)`;
      await tx.$executeRaw`
        UPDATE grupo3.agendamento
        SET status = ${novo.status}::grupo3.status_agendamento, responsavel_realizacao_id = ${novo.responsavelId}::uuid,
            observacao_realizacao = ${novo.observacaoRealizacao}
        WHERE id = ${atual.id}::uuid
      `;
      await tx.$queryRaw`SELECT set_config('grupo3.correcao_realizacao', 'off', true)`;
      await registrarHistorico(tx, { agendamentoId: atual.id, acao: "corrigido", anterior, novo, motivo: b.motivo, autorRef: req.user.ref });
      await audit(tx, {
        userId: req.user.id, action: "agendamento.corrigir_realizacao", entity: "grupo3.agendamento", entityId: atual.id,
        payload: { resultado: "sucesso", anterior: { status: anterior.status, responsavelId: anterior.responsavelId }, novo: { status: novo.status, responsavelId: novo.responsavelId } },
      });
    });
    const colaborador = await colaboradorDoUsuario(req.user);
    res.json(mascarar(await buscarAgendamento(req.params.id), req.user, colaborador?.id));
  }),
);

export default router;

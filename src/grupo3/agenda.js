import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { buscarIdososPorRef } from "./portas/idosos.js";
import { filtrarConflitos, mascarar } from "./regras.js";

// Um agendamento "agendado" está em conflito quando outro "agendado" do mesmo profissional se
// sobrepõe e os dois não são do mesmo tipo com permite_sobreposicao (mesma regra de regras.js).
const conflitoSql = Prisma.sql`
  a.status = 'agendado' AND EXISTS (
    SELECT 1 FROM grupo3.agendamento o
    WHERE o.profissional_id = a.profissional_id
      AND o.id <> a.id
      AND o.status = 'agendado'
      AND o.inicio < a.fim AND o.fim > a.inicio
      AND NOT (o.tipo_id = a.tipo_id AND t.permite_sobreposicao)
  )
`;

const selectSql = Prisma.sql`
  SELECT a.id, a.idoso_ref, a.inicio, a.fim, a.duracao_min, a.local, a.observacoes, a.plano_fisioterapia_id,
         a.status::text AS status, a.motivo_status, a.observacao_realizacao, a.concluido_em,
         a.criado_em, a.atualizado_em,
         t.id AS tipo_id, t.nome AS tipo_nome, t.categoria::text AS tipo_categoria,
         t.permite_sobreposicao,
         p.id AS profissional_id, p.nome AS profissional_nome,
         r.id AS responsavel_id, r.nome AS responsavel_nome,
         ru.id AS registrado_por_id, ru.name AS registrado_por_nome,
         (${conflitoSql}) AS em_conflito
  FROM grupo3.agendamento a
  JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
  JOIN grupo3.colaborador p ON p.id = a.profissional_id
  LEFT JOIN grupo3.colaborador r ON r.id = a.responsavel_realizacao_id
  LEFT JOIN public.users ru ON ru.ref = a.registrado_por_ref
`;

function paraAgendamento(row, idosos) {
  const idoso = idosos.get(row.idoso_ref);
  return {
    id: row.id,
    idoso: idoso ? { id: idoso.id, nome: idoso.nome } : null,
    tipo: { id: row.tipo_id, nome: row.tipo_nome, categoria: row.tipo_categoria },
    profissional: { id: row.profissional_id, nome: row.profissional_nome },
    inicio: row.inicio,
    fim: row.fim,
    duracaoMin: row.duracao_min,
    local: row.local,
    observacoes: row.observacoes,
    status: row.status,
    motivoStatus: row.motivo_status,
    responsavelRealizacao: row.responsavel_id ? { id: row.responsavel_id, nome: row.responsavel_nome } : null,
    observacaoRealizacao: row.observacao_realizacao,
    registradoPor: row.registrado_por_id ? { id: row.registrado_por_id, nome: row.registrado_por_nome } : null,
    concluidoEm: row.concluido_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    emConflito: row.em_conflito === true,
    planoFisioterapiaId: row.plano_fisioterapia_id ?? null,
  };
}

export function filtrosAgendamento({
  inicio, fim, profissionalId, idosoRef, tipoId, categoria, status, responsavelRealizacaoId, janelaInicio, janelaFim,
}) {
  const conds = [];
  if (inicio) conds.push(Prisma.sql`a.fim > ${inicio}`);
  if (fim) conds.push(Prisma.sql`a.inicio < ${fim}`);
  if (profissionalId) conds.push(Prisma.sql`a.profissional_id = ${profissionalId}::uuid`);
  if (idosoRef) conds.push(Prisma.sql`a.idoso_ref = ${idosoRef}::uuid`);
  if (tipoId) conds.push(Prisma.sql`a.tipo_id = ${tipoId}::uuid`);
  if (categoria) conds.push(Prisma.sql`t.categoria = ${categoria}::grupo3.categoria_atendimento`);
  if (status) conds.push(Prisma.sql`a.status = ${status}::grupo3.status_agendamento`);
  if (responsavelRealizacaoId) conds.push(Prisma.sql`a.responsavel_realizacao_id = ${responsavelRealizacaoId}::uuid`);
  // Janela de atendimento: hora de início, no fuso da instituição, dentro de [janelaInicio, janelaFim).
  if (janelaInicio) conds.push(Prisma.sql`(a.inicio AT TIME ZONE grupo3.fuso_horario())::time >= ${janelaInicio}::time`);
  if (janelaFim) conds.push(Prisma.sql`(a.inicio AT TIME ZONE grupo3.fuso_horario())::time < ${janelaFim}::time`);
  return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
}

export async function listarAgendamentos(filtros, { limit, offset, ordem = "asc" } = {}, db = prisma) {
  const where = filtrosAgendamento(filtros);
  const order = ordem === "desc" ? Prisma.sql`ORDER BY a.inicio DESC, a.id` : Prisma.sql`ORDER BY a.inicio, a.id`;
  const page = limit ? Prisma.sql`LIMIT ${limit} OFFSET ${offset ?? 0}` : Prisma.empty;
  const [rows, total] = await Promise.all([
    db.$queryRaw`${selectSql} ${where} ${order} ${page}`,
    db.$queryRaw`
      SELECT count(*)::int AS total
      FROM grupo3.agendamento a JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
      ${where}
    `,
  ]);
  const idosos = await buscarIdososPorRef(rows.map((row) => row.idoso_ref), db);
  return { data: rows.map((row) => paraAgendamento(row, idosos)), total: total[0].total };
}

export async function buscarAgendamento(id, db = prisma) {
  const rows = await db.$queryRaw`${selectSql} WHERE a.id = ${id}::uuid`;
  if (!rows[0]) return null;
  const idosos = await buscarIdososPorRef([rows[0].idoso_ref], db);
  return paraAgendamento(rows[0], idosos);
}

// Linha crua com as regras do tipo, travada para atualização dentro da transação.
export async function travarAgendamento(tx, id) {
  const rows = await tx.$queryRaw`
    SELECT a.id, a.idoso_ref, a.tipo_id, a.profissional_id, a.inicio, a.fim, a.duracao_min,
           a.status::text AS status, a.responsavel_realizacao_id, a.observacao_realizacao, a.plano_fisioterapia_id,
           t.categoria::text AS categoria, t.permite_sobreposicao,
           t.exige_motivo_cancelamento, t.exige_motivo_reagendamento, t.tolerancia_realizacao_min
    FROM grupo3.agendamento a
    JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
    WHERE a.id = ${id}::uuid
    FOR UPDATE OF a
  `;
  return rows[0] ?? null;
}

// Serializa as gravações do mesmo profissional para a checagem de conflito não ter corrida.
export async function travarProfissional(tx, profissionalId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`grupo3.agenda:${profissionalId}`}, 0))`;
}

/**
 * Agendamentos que impedem o intervalo informado. `ignorarId` exclui o próprio agendamento no
 * reagendamento.
 */
export async function buscarConflitos(db, { profissionalId, tipoId, permiteSobreposicao, inicio, fim, ignorarId = null }) {
  const rows = await db.$queryRaw`
    SELECT a.id, a.tipo_id, a.profissional_id, a.inicio, a.fim, a.status::text AS status, t.nome AS tipo_nome
    FROM grupo3.agendamento a
    JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
    WHERE a.profissional_id = ${profissionalId}::uuid
      AND a.status = 'agendado'
      AND a.inicio < ${fim} AND a.fim > ${inicio}
      AND (${ignorarId}::uuid IS NULL OR a.id <> ${ignorarId}::uuid)
    ORDER BY a.inicio
  `;
  const novo = { id: ignorarId, profissionalId, tipoId, permiteSobreposicao, inicio, fim };
  const existentes = rows.map((row) => ({
    id: row.id,
    profissionalId: row.profissional_id,
    tipoId: row.tipo_id,
    tipoNome: row.tipo_nome,
    inicio: row.inicio,
    fim: row.fim,
    status: row.status,
  }));
  return filtrarConflitos(novo, existentes).map((item) => ({
    agendamentoId: item.id,
    tipo: { id: item.tipoId, nome: item.tipoNome },
    inicio: item.inicio,
    fim: item.fim,
  }));
}

export function erroConflito(conflitos) {
  return new HttpError(409, "O profissional já tem agendamento nesse horário.", { conflitos });
}

export async function registrarHistorico(tx, { agendamentoId, acao, anterior = null, novo = null, motivo = null, autorRef }) {
  await tx.$executeRaw`
    INSERT INTO grupo3.historico_agendamento (agendamento_id, acao, anterior, novo, motivo, autor_ref)
    VALUES (
      ${agendamentoId}::uuid, ${acao},
      ${anterior ? JSON.stringify(anterior) : null}::jsonb,
      ${novo ? JSON.stringify(novo) : null}::jsonb,
      ${motivo}, ${autorRef}::uuid
    )
  `;
}

export async function listarHistorico(agendamentoId, db = prisma) {
  const rows = await db.$queryRaw`
    SELECT h.id, h.acao, h.anterior, h.novo, h.motivo, h.em, u.id AS autor_id, u.name AS autor_nome
    FROM grupo3.historico_agendamento h
    LEFT JOIN public.users u ON u.ref = h.autor_ref
    WHERE h.agendamento_id = ${agendamentoId}::uuid
    ORDER BY h.em, h.id
  `;
  return rows.map((row) => ({
    id: row.id,
    acao: row.acao,
    anterior: row.anterior,
    novo: row.novo,
    motivo: row.motivo,
    em: row.em,
    autor: row.autor_id ? { id: row.autor_id, nome: row.autor_nome } : null,
  }));
}

export async function colaboradorDoUsuario(usuario, db = prisma) {
  if (!usuario?.ref) return null;
  const rows = await db.$queryRaw`
    SELECT id, nome, vinculo::text AS vinculo, status::text AS status
    FROM grupo3.colaborador WHERE usuario_ref = ${usuario.ref}::uuid
  `;
  return rows[0] ?? null;
}

export async function periodoAgenda(visao, data, db = prisma) {
  const rows = await db.$queryRaw`
    SELECT p.inicio, p.fim, grupo3.fuso_horario() AS fuso,
           to_char(coalesce(${data}::date, (now() AT TIME ZONE grupo3.fuso_horario())::date), 'YYYY-MM-DD') AS data
    FROM grupo3.periodo(coalesce(${data}::date, (now() AT TIME ZONE grupo3.fuso_horario())::date), ${visao}) p
  `;
  return rows[0];
}

export function resumoAgenda(itens) {
  const resumo = { total: itens.length, agendado: 0, realizado: 0, nao_realizado: 0, cancelado: 0, emConflito: 0 };
  for (const item of itens) {
    resumo[item.status] += 1;
    if (item.emConflito) resumo.emConflito += 1;
  }
  return resumo;
}

export function mascararLista(itens, usuario, colaboradorId) {
  return itens.map((item) => mascarar(item, usuario, colaboradorId));
}

// Indicadores agregados do Grupo 3 para o dashboard do Grupo 5 (US-119, US-123, US-100, US-128).
// Só números: nenhum nome ou identificador de idoso. Taxas com denominador zero são null.
// Períodos e "hoje" no fuso da instituição (grupo3.configuracao.fuso_horario).
// Permissão proposta: modulo.dashboard (a confirmar com o G5).
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { taxa } from "../../grupo3/regras.js";
import { dia } from "../../grupo3/validacao.js";

const router = Router();
export const PERMISSAO_INDICADORES = "modulo.dashboard";

async function hojeEFuso() {
  const rows = await prisma.$queryRaw`
    SELECT to_char((now() AT TIME ZONE grupo3.fuso_horario())::date, 'YYYY-MM-DD') AS hoje, grupo3.fuso_horario() AS fuso
  `;
  return rows[0];
}

// Padrão: do primeiro dia do mês corrente até hoje.
async function periodo(query) {
  const { hoje, fuso } = await hojeEFuso();
  const inicio = query.inicio ?? `${hoje.slice(0, 7)}-01`;
  const fim = query.fim ?? hoje;
  if (fim < inicio) throw new HttpError(422, "Dados inválidos", [{ path: "fim", message: "O fim precisa ser igual ou depois do início." }]);
  return { inicio, fim, fuso };
}

const periodoQuery = z.object({ inicio: dia.optional(), fim: dia.optional() });

router.get(
  "/indicadores/atendimentos",
  requirePerm(PERMISSAO_INDICADORES),
  validate(periodoQuery, "query"),
  asyncHandler(async (req, res) => {
    const p = await periodo(req.query);
    const rows = await prisma.$queryRaw`
      SELECT t.categoria::text AS categoria,
             count(*)::int AS total,
             count(*) FILTER (WHERE a.status = 'agendado')::int AS agendados,
             count(*) FILTER (WHERE a.status = 'realizado')::int AS realizados,
             count(*) FILTER (WHERE a.status = 'nao_realizado')::int AS nao_realizados,
             count(*) FILTER (WHERE a.status = 'cancelado')::int AS cancelados,
             count(*) FILTER (WHERE a.status = 'agendado' AND a.fim < now())::int AS pendentes_de_registro
      FROM grupo3.agendamento a JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
      WHERE a.inicio >= (${p.inicio}::date::timestamp AT TIME ZONE grupo3.fuso_horario())
        AND a.inicio < ((${p.fim}::date + 1)::timestamp AT TIME ZONE grupo3.fuso_horario())
      GROUP BY t.categoria ORDER BY t.categoria
    `;
    const soma = (campo) => rows.reduce((acc, row) => acc + row[campo], 0);
    const bloco = (r) => ({
      total: r.total,
      previstos: r.total - r.cancelados,
      agendados: r.agendados,
      realizados: r.realizados,
      naoRealizados: r.nao_realizados,
      cancelados: r.cancelados,
      pendentesDeRegistro: r.pendentes_de_registro,
      taxaRealizacao: taxa(r.realizados, r.realizados + r.nao_realizados),
      taxaCancelamento: taxa(r.cancelados, r.total),
    });
    const geral = {
      total: soma("total"), agendados: soma("agendados"), realizados: soma("realizados"),
      nao_realizados: soma("nao_realizados"), cancelados: soma("cancelados"), pendentes_de_registro: soma("pendentes_de_registro"),
    };
    res.json({
      periodo: p,
      ...bloco(geral),
      porCategoria: rows.map((r) => ({ categoria: r.categoria, ...bloco(r) })),
    });
  }),
);

router.get(
  "/indicadores/tarefas",
  requirePerm(PERMISSAO_INDICADORES),
  validate(periodoQuery, "query"),
  asyncHandler(async (req, res) => {
    const p = await periodo(req.query);
    const agora = (await prisma.$queryRaw`
      SELECT t.prioridade::text AS prioridade,
             count(*) FILTER (WHERE t.status IN ('pendente','em_andamento'))::int AS abertas,
             count(*) FILTER (WHERE t.status IN ('pendente','em_andamento') AND t.prazo < now())::int AS atrasadas
      FROM grupo3.tarefa t GROUP BY t.prioridade
    `);
    const noPeriodo = (await prisma.$queryRaw`
      WITH limites AS (
        SELECT (${p.inicio}::date::timestamp AT TIME ZONE grupo3.fuso_horario()) AS i,
               ((${p.fim}::date + 1)::timestamp AT TIME ZONE grupo3.fuso_horario()) AS f
      )
      SELECT
        (SELECT count(*)::int FROM grupo3.tarefa t, limites l WHERE t.criado_em >= l.i AND t.criado_em < l.f) AS criadas,
        (SELECT count(*)::int FROM grupo3.tarefa t, limites l WHERE t.concluida_em >= l.i AND t.concluida_em < l.f) AS concluidas,
        (SELECT count(*)::int FROM grupo3.tarefa t, limites l
          WHERE t.concluida_em >= l.i AND t.concluida_em < l.f AND t.concluida_em <= t.prazo) AS concluidas_no_prazo,
        (SELECT count(*)::int FROM grupo3.historico_tarefa h, limites l
          WHERE h.status_novo = 'cancelada' AND h.em >= l.i AND h.em < l.f) AS canceladas
    `)[0];
    const ordem = ["urgente", "alta", "media", "baixa"];
    const porPrioridade = ordem.map((prioridade) => {
      const row = agora.find((r) => r.prioridade === prioridade);
      return { prioridade, abertas: row?.abertas ?? 0, atrasadas: row?.atrasadas ?? 0 };
    });
    const abertas = porPrioridade.reduce((s, r) => s + r.abertas, 0);
    const atrasadas = porPrioridade.reduce((s, r) => s + r.atrasadas, 0);
    res.json({
      periodo: p,
      agora: { abertas, atrasadas, taxaAtraso: taxa(atrasadas, abertas), porPrioridade },
      noPeriodo: {
        criadas: noPeriodo.criadas,
        concluidas: noPeriodo.concluidas,
        concluidasNoPrazo: noPeriodo.concluidas_no_prazo,
        canceladas: noPeriodo.canceladas,
        taxaConclusaoNoPrazo: taxa(noPeriodo.concluidas_no_prazo, noPeriodo.concluidas),
      },
    });
  }),
);

router.get(
  "/indicadores/equipe",
  requirePerm(PERMISSAO_INDICADORES),
  validate(z.object({ data: dia.optional() }), "query"),
  asyncHandler(async (req, res) => {
    const { hoje, fuso } = await hojeEFuso();
    const data = req.query.data ?? hoje;
    const ativos = await prisma.$queryRaw`
      SELECT vinculo::text AS vinculo, count(*)::int AS total FROM grupo3.colaborador WHERE status = 'ativo' GROUP BY vinculo
    `;
    const presencas = await prisma.$queryRaw`
      SELECT c.vinculo::text AS vinculo,
             count(*) FILTER (WHERE p.situacao = 'presente')::int AS presentes,
             count(*) FILTER (WHERE p.situacao = 'ausente')::int AS ausentes
      FROM grupo3.presenca p JOIN grupo3.colaborador c ON c.id = p.colaborador_id
      WHERE p.data = ${data}::date GROUP BY c.vinculo
    `;
    const emAndamento = (await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM grupo3.presenca WHERE situacao = 'presente' AND saida_em IS NULL
    `)[0].n;
    const escalas = (await prisma.$queryRaw`
      SELECT count(*)::int AS escalas,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM grupo3.presenca p WHERE p.escala_id = e.id AND p.situacao = 'presente'))::int AS com_presenca
      FROM grupo3.escala e
      WHERE e.situacao <> 'cancelada'
        AND e.inicio >= (${data}::date::timestamp AT TIME ZONE grupo3.fuso_horario())
        AND e.inicio < ((${data}::date + 1)::timestamp AT TIME ZONE grupo3.fuso_horario())
    `)[0];
    const vinculos = ["funcionario", "voluntario", "externo"];
    const porVinculo = vinculos.map((vinculo) => ({
      vinculo,
      ativos: ativos.find((r) => r.vinculo === vinculo)?.total ?? 0,
      presentes: presencas.find((r) => r.vinculo === vinculo)?.presentes ?? 0,
      ausentes: presencas.find((r) => r.vinculo === vinculo)?.ausentes ?? 0,
    }));
    res.json({
      data,
      fuso,
      colaboradoresAtivos: porVinculo.reduce((s, r) => s + r.ativos, 0),
      presentesNoDia: porVinculo.reduce((s, r) => s + r.presentes, 0),
      ausentesNoDia: porVinculo.reduce((s, r) => s + r.ausentes, 0),
      presentesAgora: emAndamento,
      escalasNoDia: escalas.escalas,
      escalasComPresenca: escalas.com_presenca,
      taxaPresencaEscala: taxa(escalas.com_presenca, escalas.escalas),
      porVinculo,
    });
  }),
);

export default router;

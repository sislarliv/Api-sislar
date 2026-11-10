// Relatórios P2 (US-081, US-090). Não existe serviço de relatórios/exportação do Grupo 5 (T-006) no
// repositório: os relatórios são endpoints JSON com filtros e paginação; a exportação (PDF/planilha) fica com
// o G5 (suposição D-013). Período máximo de 12 meses por consulta. Leitura auditada.
import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { auditarLeitura } from "../../grupo3/auditoria.js";
import { buscarIdoso, buscarIdososPorRef } from "../../grupo3/portas/idosos.js";
import { podeVerIdoso } from "../../grupo3/portas/prontuario.js";
import { periodoAte12Meses, taxa } from "../../grupo3/regras.js";
import { dia, idosoId, temPermissao, uuid } from "../../grupo3/validacao.js";

const router = Router();

function erroCampo(path, message) {
  return new HttpError(422, "Dados inválidos", [{ path, message }]);
}

// Padrão: primeiro dia do mês corrente até hoje (fuso da instituição). Máximo de 12 meses.
async function periodoDoRelatorio(query) {
  const hoje = (await prisma.$queryRaw`SELECT to_char((now() AT TIME ZONE grupo3.fuso_horario())::date, 'YYYY-MM-DD') AS d`)[0].d;
  const inicio = query.inicio ?? `${hoje.slice(0, 7)}-01`;
  const fim = query.fim ?? hoje;
  if (fim < inicio) throw erroCampo("fim", "O fim precisa ser igual ou depois do início.");
  if (!periodoAte12Meses(inicio, fim)) throw erroCampo("fim", "O período do relatório pode ter no máximo 12 meses.");
  return { inicio, fim };
}

async function idosoDoFiltro(req, id) {
  if (!id) return null;
  const idoso = await buscarIdoso(id);
  if (!idoso) throw new HttpError(404, "Idoso não encontrado.");
  if (!(await podeVerIdoso(req.user, idoso))) throw new HttpError(403, "Você não tem autorização para esta ação.");
  return idoso;
}

// ============================ US-081 — evolução da fisioterapia ============================

router.get(
  "/fisioterapia/relatorios/evolucao",
  requirePerm("fisioterapia.visualizar"),
  validate(pageSchema.extend({
    inicio: dia.optional(), fim: dia.optional(), idosoId: idosoId.optional(), planoId: uuid.optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, planoId } = req.query;
    const periodo = await periodoDoRelatorio(req.query);
    const idoso = await idosoDoFiltro(req, req.query.idosoId);
    // Planos cujo período toca o período do relatório.
    const planos = await prisma.$queryRaw`
      SELECT p.id, p.idoso_ref, p.objetivo, to_char(p.data_inicio, 'YYYY-MM-DD') AS data_inicio,
             to_char(p.data_fim, 'YYYY-MM-DD') AS data_fim, p.frequencia_semanal, p.situacao::text AS situacao,
             c.id AS responsavel_id, c.nome AS responsavel_nome, count(*) OVER()::int AS total
      FROM grupo3.plano_fisioterapia p JOIN grupo3.colaborador c ON c.id = p.responsavel_id
      WHERE p.data_inicio <= ${periodo.fim}::date AND (p.data_fim IS NULL OR p.data_fim >= ${periodo.inicio}::date)
        AND (${idoso?.ref ?? null}::uuid IS NULL OR p.idoso_ref = ${idoso?.ref ?? null}::uuid)
        AND (${planoId ?? null}::uuid IS NULL OR p.id = ${planoId ?? null}::uuid)
      ORDER BY p.data_inicio, p.id
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `;
    const ids = planos.map((p) => p.id);
    const idosos = await buscarIdososPorRef(planos.map((p) => p.idoso_ref));
    const lista = ids.length ? Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`)) : null;
    const limites = Prisma.sql`
      a.inicio >= (${periodo.inicio}::date::timestamp AT TIME ZONE grupo3.fuso_horario())
      AND a.inicio < ((${periodo.fim}::date + 1)::timestamp AT TIME ZONE grupo3.fuso_horario())
    `;
    const [sessoes, atividades, evolucoes] = lista ? await Promise.all([
      prisma.$queryRaw`
        SELECT a.plano_fisioterapia_id AS plano_id,
               count(*)::int AS total,
               count(*) FILTER (WHERE a.status = 'agendado')::int AS agendadas,
               count(*) FILTER (WHERE a.status = 'realizado')::int AS realizadas,
               count(*) FILTER (WHERE a.status = 'nao_realizado')::int AS nao_realizadas,
               count(*) FILTER (WHERE a.status = 'cancelado')::int AS canceladas
        FROM grupo3.agendamento a
        WHERE a.plano_fisioterapia_id IN (${lista}) AND ${limites}
        GROUP BY a.plano_fisioterapia_id
      `,
      prisma.$queryRaw`
        SELECT at.plano_id, at.id, at.descricao, at.ativa,
               count(e.id) FILTER (WHERE e.status = 'realizada')::int AS realizada,
               count(e.id) FILTER (WHERE e.status = 'parcial')::int AS parcial,
               count(e.id) FILTER (WHERE e.status = 'nao_realizada')::int AS nao_realizada
        FROM grupo3.atividade_fisioterapia at
        LEFT JOIN grupo3.execucao_atividade e ON e.atividade_id = at.id
          AND EXISTS (SELECT 1 FROM grupo3.agendamento a WHERE a.id = e.agendamento_id AND ${limites})
        WHERE at.plano_id IN (${lista})
        GROUP BY at.plano_id, at.id, at.descricao, at.ativa
        ORDER BY at.criado_em
      `,
      prisma.$queryRaw`
        SELECT ev.plano_id, ev.id, ev.texto, ev.registrado_em, ev.agendamento_id, u.id AS autor_id, u.name AS autor_nome
        FROM grupo3.evolucao_fisioterapia ev LEFT JOIN public.users u ON u.ref = ev.autor_ref
        WHERE ev.plano_id IN (${lista})
          AND ev.registrado_em >= (${periodo.inicio}::date::timestamp AT TIME ZONE grupo3.fuso_horario())
          AND ev.registrado_em < ((${periodo.fim}::date + 1)::timestamp AT TIME ZONE grupo3.fuso_horario())
        ORDER BY ev.registrado_em, ev.id
      `,
    ]) : [[], [], []];
    const data = planos.map((p) => {
      const s = sessoes.find((x) => x.plano_id === p.id) ?? { total: 0, agendadas: 0, realizadas: 0, nao_realizadas: 0, canceladas: 0 };
      const dono = idosos.get(p.idoso_ref);
      return {
        plano: {
          id: p.id, objetivo: p.objetivo, dataInicio: p.data_inicio, dataFim: p.data_fim, frequenciaSemanal: p.frequencia_semanal,
          situacao: p.situacao, responsavel: { id: p.responsavel_id, nome: p.responsavel_nome },
        },
        idoso: dono ? { id: dono.id, nome: dono.nome } : null,
        sessoes: {
          total: s.total, agendadas: s.agendadas, realizadas: s.realizadas, naoRealizadas: s.nao_realizadas, canceladas: s.canceladas,
          taxaRealizacao: taxa(s.realizadas, s.realizadas + s.nao_realizadas),
        },
        atividades: atividades.filter((a) => a.plano_id === p.id).map((a) => ({
          id: a.id, descricao: a.descricao, ativa: a.ativa,
          execucoes: { realizada: a.realizada, parcial: a.parcial, naoRealizada: a.nao_realizada, total: a.realizada + a.parcial + a.nao_realizada },
        })),
        evolucoes: evolucoes.filter((e) => e.plano_id === p.id).map((e) => ({
          id: e.id, registradoEm: e.registrado_em, agendamentoId: e.agendamento_id, texto: e.texto,
          autor: e.autor_id ? { id: e.autor_id, nome: e.autor_nome } : null,
        })),
      };
    });
    await auditarLeitura(req, {
      entidade: "relatorio_fisioterapia", rota: "/fisioterapia/relatorios/evolucao",
      idosoIds: data.map((d) => d.idoso?.id), ids: data.map((d) => d.plano.id),
    });
    res.json({ periodo, data, meta: pageMeta(page, limit, planos[0]?.total ?? 0) });
  }),
);

// ============================ US-090 — consultas e tratamentos ============================

router.get(
  "/relatorios/consultas-tratamentos",
  requirePerm("atendimento-clinico.visualizar", "modulo.relatorios"),
  validate(pageSchema.extend({
    inicio: dia.optional(),
    fim: dia.optional(),
    area: z.enum(["medica", "odontologica"]).optional(),
    profissionalId: uuid.optional(),
    idosoId: idosoId.optional(),
    status: z.enum(["agendado", "realizado", "nao_realizado", "cancelado"]).optional(),
    incluirConteudo: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, area, profissionalId, status, incluirConteudo } = req.query;
    // Conteúdo clínico só com atendimento-clinico.visualizar; por padrão, só metadados.
    if (incluirConteudo && !temPermissao(req.user, "atendimento-clinico.visualizar")) {
      throw new HttpError(403, "Conteúdo clínico exige a permissão atendimento-clinico.visualizar.");
    }
    const periodo = await periodoDoRelatorio(req.query);
    const idoso = await idosoDoFiltro(req, req.query.idosoId);
    const idosoRef = idoso?.ref ?? null;
    const inicioTs = Prisma.sql`(${periodo.inicio}::date::timestamp AT TIME ZONE grupo3.fuso_horario())`;
    const fimTs = Prisma.sql`((${periodo.fim}::date + 1)::timestamp AT TIME ZONE grupo3.fuso_horario())`;
    // Tratamento externo não tem colaborador nem status de agenda: sai com filtro de profissional ou status
    // diferente de "realizado".
    const incluiTratamentos = !profissionalId && (!status || status === "realizado");
    const base = Prisma.sql`
      SELECT 'consulta' AS origem, a.id, a.inicio AS data, a.idoso_ref,
             CASE t.categoria WHEN 'consulta_odontologica' THEN 'odontologica' ELSE 'medica' END AS area,
             t.nome AS tipo, a.status::text AS status, c.id AS profissional_id, c.nome AS profissional_nome,
             a.local, r.id AS registro_id, r.status::text AS registro_status, r.resumo, r.conteudo,
             NULL::text AS local_externo, NULL::text AS instituicao, NULL::text AS observacoes
      FROM grupo3.agendamento a
      JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
      JOIN grupo3.colaborador c ON c.id = a.profissional_id
      LEFT JOIN grupo3.registro_clinico r ON r.agendamento_id = a.id AND r.adendo_de IS NULL
      WHERE t.categoria IN ('consulta_medica','consulta_odontologica')
        AND a.inicio >= ${inicioTs} AND a.inicio < ${fimTs}
        AND (${area ?? null}::text IS NULL OR (CASE t.categoria WHEN 'consulta_odontologica' THEN 'odontologica' ELSE 'medica' END) = ${area ?? null})
        AND (${profissionalId ?? null}::uuid IS NULL OR a.profissional_id = ${profissionalId ?? null}::uuid)
        AND (${idosoRef}::uuid IS NULL OR a.idoso_ref = ${idosoRef}::uuid)
        AND (${status ?? null}::text IS NULL OR a.status::text = ${status ?? null})
      ${incluiTratamentos ? Prisma.sql`
      UNION ALL
      SELECT 'tratamento_externo', te.id, (te.data::timestamp AT TIME ZONE grupo3.fuso_horario()), te.idoso_ref,
             te.area::text, te.tipo, 'realizado', NULL::uuid, te.profissional_nome,
             NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb,
             te.local_externo, te.instituicao, te.observacoes
      FROM grupo3.tratamento_externo te
      WHERE te.data BETWEEN ${periodo.inicio}::date AND ${periodo.fim}::date
        AND (${area ?? null}::text IS NULL OR te.area::text = ${area ?? null})
        AND (${idosoRef}::uuid IS NULL OR te.idoso_ref = ${idosoRef}::uuid)` : Prisma.empty}
    `;
    const [rows, totais] = await Promise.all([
      prisma.$queryRaw`
        SELECT x.*, count(*) OVER()::int AS total FROM (${base}) x ORDER BY x.data DESC, x.id LIMIT ${limit} OFFSET ${(page - 1) * limit}
      `,
      prisma.$queryRaw`SELECT x.origem, x.status, count(*)::int AS n FROM (${base}) x GROUP BY x.origem, x.status`,
    ]);
    const idosos = await buscarIdososPorRef(rows.map((r) => r.idoso_ref));
    const data = rows.map((r) => {
      const dono = idosos.get(r.idoso_ref);
      const item = {
        origem: r.origem,
        id: r.id,
        data: r.data,
        idoso: dono ? { id: dono.id, nome: dono.nome } : null,
        area: r.area,
        tipo: r.tipo,
        status: r.status,
        profissional: r.profissional_id ? { id: r.profissional_id, nome: r.profissional_nome } : (r.profissional_nome ? { id: null, nome: r.profissional_nome } : null),
      };
      if (!incluirConteudo) return item;
      return {
        ...item,
        conteudo: r.origem === "consulta"
          ? { local: r.local, registroClinico: r.registro_id ? { id: r.registro_id, status: r.registro_status, resumo: r.resumo, conteudo: r.conteudo } : null }
          : { localExterno: r.local_externo, instituicao: r.instituicao, observacoes: r.observacoes },
      };
    });
    const resumo = { consultas: 0, tratamentosExternos: 0, porStatus: {} };
    for (const t of totais) {
      if (t.origem === "consulta") resumo.consultas += t.n;
      else resumo.tratamentosExternos += t.n;
      resumo.porStatus[t.status] = (resumo.porStatus[t.status] ?? 0) + t.n;
    }
    await auditarLeitura(req, {
      entidade: "relatorio_consultas_tratamentos", rota: `/relatorios/consultas-tratamentos${incluirConteudo ? "?incluirConteudo=true" : ""}`,
      idosoIds: data.map((d) => d.idoso?.id), ids: data.map((d) => d.id),
    });
    res.json({
      periodo,
      filtros: { area: area ?? null, profissionalId: profissionalId ?? null, idosoId: idoso?.id ?? null, status: status ?? null, incluirConteudo },
      resumo,
      data,
      meta: pageMeta(page, limit, rows[0]?.total ?? 0),
    });
  }),
);

export default router;

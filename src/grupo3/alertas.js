// Jobs de alerta (T-008): tarefas atrasadas (US-096) e pendências odontológicas do ciclo (US-089).
// Sem notificação repetida: o que já foi avisado fica em grupo3.notificacao_controle (chave única).
import { prisma } from "../db/prisma.js";
import { permissionsFor } from "../lib/permissions.js";
import { enviarNotificacao } from "./portas/notificacoes.js";
import { chaveCicloOdonto, periodoDoCiclo, textoPendenciasOdonto } from "./regras.js";

async function configuracao(db, chave, padrao) {
  const rows = await db.$queryRaw`SELECT valor FROM grupo3.configuracao WHERE chave = ${chave}`;
  return rows[0]?.valor ?? padrao;
}

/**
 * Tarefas atrasadas: uma notificação por tarefa para o responsável (usuário do colaborador). Se o responsável
 * não tem usuário ativo, avisa uma vez quem criou a tarefa. A chave do responsável só é gravada quando o aviso
 * sai: ao vincular um usuário ao colaborador, a próxima rodada avisa o responsável das tarefas que continuam
 * abertas e atrasadas (mesmo comportamento dos lembretes).
 */
export async function processarTarefasAtrasadas({ agora = new Date(), limite = 100, enviar = enviarNotificacao } = {}) {
  const resumo = { processados: 0, notificadas: 0, notificadasAoCriador: 0, semDestinatario: 0, falhas: 0 };
  await prisma.$transaction(async (tx) => {
    const fuso = await configuracao(tx, "fuso_horario", "America/Sao_Paulo");
    const tarefas = await tx.$queryRaw`
      SELECT t.id, t.titulo, t.prazo, c.nome AS responsavel_nome,
             (u.id IS NOT NULL AND u.active) AS responsavel_tem_usuario, u.id AS usuario_id,
             (cr.id IS NOT NULL AND cr.active) AS criador_ativo, cr.id AS criador_id
      FROM grupo3.tarefa t
      JOIN grupo3.colaborador c ON c.id = t.responsavel_id
      LEFT JOIN public.users u ON u.ref = c.usuario_ref
      LEFT JOIN public.users cr ON cr.ref = t.criado_por_ref
      WHERE t.status IN ('pendente','em_andamento') AND t.prazo < ${agora}
        AND (
          (u.id IS NOT NULL AND u.active AND NOT EXISTS (
            SELECT 1 FROM grupo3.notificacao_controle n WHERE n.chave = 'tarefa_atrasada:' || t.id::text))
          OR (NOT (u.id IS NOT NULL AND u.active) AND NOT EXISTS (
            SELECT 1 FROM grupo3.notificacao_controle n WHERE n.chave = 'tarefa_atrasada_criador:' || t.id::text))
        )
      ORDER BY t.prazo
      LIMIT ${limite}
      FOR UPDATE OF t SKIP LOCKED
    `;
    for (const tarefa of tarefas) {
      resumo.processados += 1;
      const prazo = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, dateStyle: "short", timeStyle: "short" }).format(tarefa.prazo);
      const paraResponsavel = tarefa.responsavel_tem_usuario;
      const destinatario = paraResponsavel ? tarefa.usuario_id : (tarefa.criador_ativo ? tarefa.criador_id : null);
      const chave = paraResponsavel ? `tarefa_atrasada:${tarefa.id}` : `tarefa_atrasada_criador:${tarefa.id}`;
      const tipo = paraResponsavel ? "tarefa_atrasada" : "tarefa_atrasada_criador";
      await tx.$executeRawUnsafe("SAVEPOINT alerta_tarefa");
      try {
        const marcada = await tx.$queryRaw`
          INSERT INTO grupo3.notificacao_controle (chave, tipo, status, destinatarios)
          VALUES (${chave}, ${tipo}, ${destinatario ? "enviada" : "sem_destinatario"}, ${destinatario ? 1 : 0})
          ON CONFLICT (chave) DO NOTHING
          RETURNING chave
        `;
        if (marcada.length && destinatario) {
          await enviar({
            usuarioId: destinatario,
            tipo: "tarefa",
            titulo: "Tarefa atrasada",
            corpo: paraResponsavel
              ? `"${tarefa.titulo}" passou do prazo (${prazo}).`
              : `"${tarefa.titulo}" passou do prazo (${prazo}). O responsável (${tarefa.responsavel_nome}) não tem acesso ao sistema.`,
            link: `/tarefas/${tarefa.id}`,
          }, tx);
        }
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT alerta_tarefa");
        if (marcada.length) {
          if (!destinatario) resumo.semDestinatario += 1;
          else resumo[paraResponsavel ? "notificadas" : "notificadasAoCriador"] += 1;
        }
      } catch {
        // Sem marcação: tenta de novo na próxima rodada.
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT alerta_tarefa");
        resumo.falhas += 1;
      }
    }
  }, { timeout: 60_000 });
  return resumo;
}

// Usuários ativos com a permissão (calculada pelos perfis, como na Fundação).
async function usuariosComPermissao(db, permissao) {
  const rows = await db.$queryRaw`
    SELECT u.id, array_agg(up.profile) AS perfis
    FROM public.users u JOIN public.user_profiles up ON up.user_id = u.id
    WHERE u.active
    GROUP BY u.id
  `;
  return rows.filter((row) => permissionsFor(row.perfis).has(permissao)).map((row) => row.id);
}

/**
 * Pendências odontológicas do ciclo vigente: um aviso por idoso por ciclo. Cada rodada que encontra idosos
 * ainda não avisados manda UM resumo (sem nomes) para cada usuário com atendimento-clinico.administrar.
 */
export async function processarPendenciasOdontologicas({ hoje = null, enviar = enviarNotificacao } = {}) {
  const resumo = { processados: 0, notificadas: 0, idososNovos: 0 };
  await prisma.$transaction(async (tx) => {
    // Uma rodada por vez entre instâncias.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('grupo3.alerta_odonto', 0))`;
    const dia = hoje ?? (await tx.$queryRaw`SELECT to_char((now() AT TIME ZONE grupo3.fuso_horario())::date, 'YYYY-MM-DD') AS d`)[0].d;
    const periodo = periodoDoCiclo(await configuracao(tx, "odontologia.ciclo", { modo: "semestre_civil", dias: 180 }), {}, dia);
    const ciclo = chaveCicloOdonto(periodo, dia);
    const pendentes = await tx.$queryRaw`
      WITH registros AS (
        SELECT idoso_ref, (realizado_em AT TIME ZONE grupo3.fuso_horario())::date AS data
        FROM grupo3.registro_clinico WHERE area = 'odontologica' AND status = 'finalizado'
        UNION ALL
        SELECT idoso_ref, data FROM grupo3.tratamento_externo WHERE area = 'odontologica'
      )
      SELECT p.ref::text AS ref
      FROM public.patients p
      WHERE NOT EXISTS (
        SELECT 1 FROM registros r WHERE r.idoso_ref = p.ref AND r.data BETWEEN ${periodo.inicio}::date AND ${periodo.fim}::date
      )
      AND NOT EXISTS (
        SELECT 1 FROM grupo3.notificacao_controle n WHERE n.chave = 'odonto_pendente:' || ${ciclo} || ':' || p.ref::text
      )
    `;
    resumo.processados = pendentes.length;
    if (!pendentes.length) return;
    const destinatarios = await usuariosComPermissao(tx, "atendimento-clinico.administrar");
    // Sem destinatário, não marca: o aviso sai quando houver alguém com a permissão.
    if (!destinatarios.length) return;
    for (const { ref } of pendentes) {
      await tx.$executeRaw`
        INSERT INTO grupo3.notificacao_controle (chave, tipo, status, destinatarios)
        VALUES (${`odonto_pendente:${ciclo}:${ref}`}, 'odonto_pendente', 'enviada', ${destinatarios.length})
        ON CONFLICT (chave) DO NOTHING
      `;
    }
    for (const usuarioId of destinatarios) {
      await enviar({
        usuarioId, tipo: "odontologia", titulo: "Pendências odontológicas",
        corpo: textoPendenciasOdonto(pendentes.length, periodo.rotulo),
        link: periodo.modo === "semestre_civil" ? `/odontologia/pendencias?ciclo=${periodo.rotulo}` : "/odontologia/pendencias",
      }, tx);
      resumo.notificadas += 1;
    }
    resumo.idososNovos = pendentes.length;
  }, { timeout: 60_000 });
  return resumo;
}

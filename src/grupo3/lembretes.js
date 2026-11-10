// US-074 — Lembretes de atendimento. O Grupo 3 agenda o envio e registra o status; a entrega é
// feita pela porta de notificações.
import { prisma } from "../db/prisma.js";
import { buscarIdososPorRef } from "./portas/idosos.js";
import { enviarNotificacao } from "./portas/notificacoes.js";
import { calcularEnvios, statusAposFalha, statusInicialLembrete } from "./regras.js";

async function configuracao(db, chave, padrao) {
  const rows = await db.$queryRaw`SELECT valor FROM grupo3.configuracao WHERE chave = ${chave}`;
  return rows[0]?.valor ?? padrao;
}

export async function antecedenciasDoTipo(db, tipoId) {
  const rows = await db.$queryRaw`SELECT antecedencias_lembrete_min FROM grupo3.tipo_atendimento WHERE id = ${tipoId}::uuid`;
  const doTipo = rows[0]?.antecedencias_lembrete_min;
  if (Array.isArray(doTipo)) return doTipo;
  return configuracao(db, "lembretes.antecedencias_min", [1440]);
}

/** Cria os lembretes do profissional de um agendamento "agendado". */
export async function gerarLembretes(db, agendamentoId, agora = new Date()) {
  const rows = await db.$queryRaw`
    SELECT a.id, a.inicio, a.tipo_id, a.status::text AS status, c.id AS colaborador_id, c.usuario_ref
    FROM grupo3.agendamento a JOIN grupo3.colaborador c ON c.id = a.profissional_id
    WHERE a.id = ${agendamentoId}::uuid
  `;
  const agendamento = rows[0];
  if (!agendamento || agendamento.status !== "agendado") return [];
  const envios = calcularEnvios(agendamento.inicio, await antecedenciasDoTipo(db, agendamento.tipo_id), agora);
  const status = statusInicialLembrete(agendamento.usuario_ref);
  const erro = status === "sem_destinatario" ? "Colaborador sem usuário do sistema vinculado." : null;
  for (const envio of envios) {
    await db.$executeRaw`
      INSERT INTO grupo3.lembrete_agendamento (agendamento_id, colaborador_id, usuario_ref, antecedencia_min, enviar_em, status, ultimo_erro)
      VALUES (${agendamento.id}::uuid, ${agendamento.colaborador_id}::uuid, ${agendamento.usuario_ref}::uuid,
              ${envio.antecedenciaMin}, ${envio.enviarEm}, ${status}::grupo3.status_lembrete, ${erro})
    `;
  }
  return envios;
}

/** Cancela lembretes ainda não enviados (agendamento cancelado, realizado ou reagendado). */
export async function cancelarLembretes(db, agendamentoId) {
  await db.$executeRaw`
    UPDATE grupo3.lembrete_agendamento SET status = 'cancelado'
    WHERE agendamento_id = ${agendamentoId}::uuid AND status IN ('pendente','sem_destinatario')
  `;
}

/** Colaborador que ganhou usuário: lembretes futuros sem destinatário voltam para a fila. */
export async function reativarLembretesSemDestinatario(db, colaboradorId, usuarioRef) {
  if (!usuarioRef) return;
  await db.$executeRaw`
    UPDATE grupo3.lembrete_agendamento l
    SET status = 'pendente', usuario_ref = ${usuarioRef}::uuid, ultimo_erro = NULL
    FROM grupo3.agendamento a
    WHERE a.id = l.agendamento_id AND a.status = 'agendado' AND a.inicio > now()
      AND l.colaborador_id = ${colaboradorId}::uuid AND l.status = 'sem_destinatario'
  `;
}

export async function listarLembretes(agendamentoId, db = prisma) {
  const rows = await db.$queryRaw`
    SELECT l.id, l.antecedencia_min, l.enviar_em, l.canal, l.status::text AS status, l.tentativas, l.ultimo_erro,
           l.enviado_em, l.entregue_em, l.criado_em, c.id AS colaborador_id, c.nome AS colaborador_nome, u.id AS usuario_id
    FROM grupo3.lembrete_agendamento l
    JOIN grupo3.colaborador c ON c.id = l.colaborador_id
    LEFT JOIN public.users u ON u.ref = l.usuario_ref
    WHERE l.agendamento_id = ${agendamentoId}::uuid
    ORDER BY l.criado_em, l.enviar_em
  `;
  return rows.map((row) => ({
    id: row.id,
    destinatario: { colaboradorId: row.colaborador_id, nome: row.colaborador_nome, usuarioId: row.usuario_id ?? null },
    antecedenciaMin: row.antecedencia_min,
    enviarEm: row.enviar_em,
    canal: row.canal,
    status: row.status,
    tentativas: row.tentativas,
    ultimoErro: row.ultimo_erro,
    enviadoEm: row.enviado_em,
    entregueEm: row.entregue_em,
    criadoEm: row.criado_em,
  }));
}

function mensagem(item, idoso, fuso) {
  const quando = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, dateStyle: "short", timeStyle: "short" }).format(item.inicio);
  return {
    usuarioId: item.usuario_id,
    titulo: `Lembrete: ${item.tipo_nome}`,
    // Sem observações clínicas: só tipo, idoso, data/hora e local.
    corpo: `${item.tipo_nome} com ${idoso?.nome ?? "idoso"} em ${quando}${item.local ? ` · ${item.local}` : ""}.`,
    link: `/agenda/agendamentos/${item.agendamento_id}`,
  };
}

/**
 * Job (T-008): envia os lembretes vencidos. Usa FOR UPDATE SKIP LOCKED para mais de uma instância não
 * enviar o mesmo lembrete. `enviar` é injetável para teste.
 */
export async function processarLembretes({ agora = new Date(), limite = 50, enviar = enviarNotificacao } = {}) {
  const resumo = { processados: 0, entregues: 0, enviados: 0, falhas: 0, reagendados: 0, semDestinatario: 0, cancelados: 0 };
  await prisma.$transaction(async (tx) => {
    const fuso = await configuracao(tx, "fuso_horario", "America/Sao_Paulo");
    const maxTentativas = Number(await configuracao(tx, "lembretes.max_tentativas", 3));
    const itens = await tx.$queryRaw`
      SELECT l.id, l.agendamento_id, l.tentativas, a.status::text AS agendamento_status, a.inicio, a.local, a.idoso_ref,
             t.nome AS tipo_nome, u.id AS usuario_id, u.active AS usuario_ativo
      FROM grupo3.lembrete_agendamento l
      JOIN grupo3.agendamento a ON a.id = l.agendamento_id
      JOIN grupo3.tipo_atendimento t ON t.id = a.tipo_id
      LEFT JOIN public.users u ON u.ref = l.usuario_ref
      WHERE l.status = 'pendente' AND l.enviar_em <= ${agora}
      ORDER BY l.enviar_em
      LIMIT ${limite}
      FOR UPDATE OF l SKIP LOCKED
    `;
    const idosos = await buscarIdososPorRef(itens.map((item) => item.idoso_ref), tx);
    for (const item of itens) {
      resumo.processados += 1;
      if (item.agendamento_status !== "agendado") {
        await tx.$executeRaw`UPDATE grupo3.lembrete_agendamento SET status = 'cancelado' WHERE id = ${item.id}::uuid`;
        resumo.cancelados += 1;
        continue;
      }
      // Atendimento que já começou (ex.: job parado por um tempo) não recebe lembrete atrasado.
      if (item.inicio.getTime() <= agora.getTime()) {
        await tx.$executeRaw`
          UPDATE grupo3.lembrete_agendamento
          SET status = 'cancelado', ultimo_erro = 'Atendimento já iniciado antes do envio.'
          WHERE id = ${item.id}::uuid
        `;
        resumo.cancelados += 1;
        continue;
      }
      if (!item.usuario_id || !item.usuario_ativo) {
        await tx.$executeRaw`
          UPDATE grupo3.lembrete_agendamento
          SET status = 'sem_destinatario', ultimo_erro = 'Usuário do colaborador ausente ou inativo.'
          WHERE id = ${item.id}::uuid
        `;
        resumo.semDestinatario += 1;
        continue;
      }
      await tx.$executeRawUnsafe("SAVEPOINT lembrete");
      try {
        const resultado = await enviar(mensagem(item, idosos.get(item.idoso_ref), fuso), tx);
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT lembrete");
        const entregue = resultado.status === "entregue";
        await tx.$executeRaw`
          UPDATE grupo3.lembrete_agendamento
          SET status = ${resultado.status}::grupo3.status_lembrete, canal = ${resultado.canal},
              notificacao_id = ${resultado.referencia ?? null}, tentativas = tentativas + 1, ultimo_erro = NULL,
              enviado_em = now(), entregue_em = ${entregue ? new Date() : null}
          WHERE id = ${item.id}::uuid
        `;
        resumo[entregue ? "entregues" : "enviados"] += 1;
      } catch (error) {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT lembrete");
        const tentativas = item.tentativas + 1;
        const status = statusAposFalha(tentativas, maxTentativas);
        await tx.$executeRaw`
          UPDATE grupo3.lembrete_agendamento
          SET status = ${status}::grupo3.status_lembrete, tentativas = ${tentativas},
              ultimo_erro = ${String(error?.message || "Falha no envio.").slice(0, 500)}
          WHERE id = ${item.id}::uuid
        `;
        resumo[status === "falha" ? "falhas" : "reagendados"] += 1;
      }
    }
  }, { timeout: 60_000 });
  return resumo;
}

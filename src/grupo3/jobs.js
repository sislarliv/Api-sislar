// Jobs agendados do Grupo 3 (T-008). O repositório não tinha mecanismo de jobs: o agendador roda no
// próprio processo e só liga com JOBS_ENABLED=true (desligado nos testes). Com várias instâncias, cada job
// usa FOR UPDATE SKIP LOCKED para não processar o mesmo item duas vezes.
import { processarPendenciasOdontologicas, processarTarefasAtrasadas } from "./alertas.js";
import { processarLembretes } from "./lembretes.js";

export const JOBS_PADRAO = [
  { nome: "lembretes", executar: () => processarLembretes() },
  { nome: "tarefas_atrasadas", executar: () => processarTarefasAtrasadas() },
  { nome: "pendencias_odontologicas", executar: () => processarPendenciasOdontologicas() },
];

let timerAtual = null;

/**
 * Executa uma rodada. Cada job tem try/catch próprio: um erro vira log e nunca rejeita a promessa
 * (no Node 20 uma rejeição não tratada encerra o processo). Se a rodada anterior de um job ainda está
 * rodando, a nova rodada desse job é pulada.
 */
export function criarRodada(jobs, { log = console } = {}) {
  const emExecucao = new Set();
  const jaRodou = new Set();
  return async function rodar() {
    await Promise.all(jobs.map(async (job) => {
      if (emExecucao.has(job.nome)) return;
      emExecucao.add(job.nome);
      try {
        const resumo = await job.executar();
        // Primeira execução de cada job sempre vai para o log (confirma que o agendador está rodando); depois,
        // só quando houve trabalho. O resumo tem apenas contagens.
        if (!jaRodou.has(job.nome)) {
          jaRodou.add(job.nome);
          log.log(`[grupo3:${job.nome}] primeira execução ok ${JSON.stringify(resumo ?? {})}`);
        } else if (resumo?.processados) {
          log.log(`[grupo3:${job.nome}] ${JSON.stringify(resumo)}`);
        }
      } catch (error) {
        // Só a mensagem técnica: sem payload, idoso ou destinatário.
        try {
          log.error(`[grupo3:${job.nome}] falhou: ${error?.message || "erro desconhecido"}`);
        } catch {
          // Nem o log pode derrubar o processo.
        }
      } finally {
        emExecucao.delete(job.nome);
      }
    }));
  };
}

export function iniciarJobs({
  intervaloSeg = Number(process.env.JOBS_INTERVALO_SEG || 60),
  jobs = JOBS_PADRAO,
  log = console,
} = {}) {
  pararJobs();
  const rodar = criarRodada(jobs, { log });
  timerAtual = setInterval(() => {
    rodar().catch(() => {});
  }, Math.max(intervaloSeg, 10) * 1000);
  timerAtual.unref?.();
  return pararJobs;
}

export function pararJobs() {
  if (timerAtual) {
    clearInterval(timerAtual);
    timerAtual = null;
  }
}

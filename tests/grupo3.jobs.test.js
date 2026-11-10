import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { iniciarJobs, pararJobs } from "../src/grupo3/jobs.js";

const silencioso = { log: mock.fn(), error: mock.fn() };

// Deixa as promessas pendentes avançarem (setImmediate não está no relógio falso).
async function fluir() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("grupo3 · agendador de jobs (T-008)", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setInterval"] });
    silencioso.log.mock.resetCalls();
    silencioso.error.mock.resetCalls();
  });

  afterEach(() => {
    pararJobs();
    mock.timers.reset();
  });

  it("dispara a cada intervalo e para com pararJobs()", async () => {
    const executar = mock.fn(async () => ({ processados: 0 }));
    iniciarJobs({ intervaloSeg: 30, jobs: [{ nome: "teste", executar }], log: silencioso });
    mock.timers.tick(29_999);
    await fluir();
    assert.equal(executar.mock.callCount(), 0);
    mock.timers.tick(1);
    await fluir();
    assert.equal(executar.mock.callCount(), 1);
    mock.timers.tick(30_000);
    await fluir();
    assert.equal(executar.mock.callCount(), 2);
    pararJobs();
    mock.timers.tick(90_000);
    await fluir();
    assert.equal(executar.mock.callCount(), 2);
  });

  it("sobrevive a um erro do job sem rejeição não tratada", async () => {
    const naoTratadas = [];
    const ouvinte = (motivo) => naoTratadas.push(motivo);
    process.on("unhandledRejection", ouvinte);
    try {
      let chamada = 0;
      const executar = mock.fn(async () => {
        chamada += 1;
        if (chamada === 1) throw new Error("banco indisponível");
        return { processados: 0 };
      });
      iniciarJobs({ intervaloSeg: 10, jobs: [{ nome: "lembretes", executar }], log: silencioso });
      mock.timers.tick(10_000);
      await fluir();
      mock.timers.tick(10_000);
      await fluir();
      assert.equal(executar.mock.callCount(), 2);
      assert.equal(silencioso.error.mock.callCount(), 1);
      assert.equal(silencioso.error.mock.calls[0].arguments[0], "[grupo3:lembretes] falhou: banco indisponível");
      assert.deepEqual(naoTratadas, []);
    } finally {
      process.off("unhandledRejection", ouvinte);
    }
  });

  it("não sobrepõe execuções: pula a rodada se a anterior ainda roda", async () => {
    let liberar;
    const executar = mock.fn(() => new Promise((resolve) => { liberar = resolve; }));
    iniciarJobs({ intervaloSeg: 10, jobs: [{ nome: "lento", executar }], log: silencioso });
    mock.timers.tick(10_000);
    await fluir();
    mock.timers.tick(10_000);
    await fluir();
    mock.timers.tick(10_000);
    await fluir();
    assert.equal(executar.mock.callCount(), 1);
    liberar({ processados: 0 });
    await fluir();
    mock.timers.tick(10_000);
    await fluir();
    assert.equal(executar.mock.callCount(), 2);
  });

  it("registra no log a primeira execução de cada job e depois só quando há trabalho", async () => {
    const vazio = mock.fn(async () => ({ processados: 0 }));
    const comTrabalho = mock.fn(async () => ({ processados: 2 }));
    iniciarJobs({ intervaloSeg: 10, jobs: [{ nome: "vazio", executar: vazio }, { nome: "ocupado", executar: comTrabalho }], log: silencioso });
    mock.timers.tick(10_000);
    await fluir();
    mock.timers.tick(10_000);
    await fluir();
    const linhas = silencioso.log.mock.calls.map((c) => c.arguments[0]);
    assert.equal(linhas.filter((l) => l.startsWith("[grupo3:vazio] primeira execução ok")).length, 1);
    assert.equal(linhas.filter((l) => l.startsWith("[grupo3:vazio]")).length, 1);
    assert.equal(linhas.filter((l) => l.startsWith("[grupo3:ocupado]")).length, 2);
  });

  it("respeita o intervalo mínimo de 10 s", async () => {
    const executar = mock.fn(async () => ({}));
    iniciarJobs({ intervaloSeg: 1, jobs: [{ nome: "rapido", executar }], log: silencioso });
    mock.timers.tick(9_999);
    await fluir();
    assert.equal(executar.mock.callCount(), 0);
    mock.timers.tick(1);
    await fluir();
    assert.equal(executar.mock.callCount(), 1);
  });
});

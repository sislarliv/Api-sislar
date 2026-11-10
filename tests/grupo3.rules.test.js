import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  periodoAte12Meses,
  somarMeses,
  chaveCicloOdonto,
  tarefaAtrasada,
  textoPendenciasOdonto,
  transicaoTarefaValida,
  cargaPorDia,
  diasDaSemana,
  taxa,
  areaClinica,
  periodoDoCiclo,
  recortarNoDia,
  segmentosDoTurno,
  turnoDentroDaDisponibilidade,
  calcularEnvios,
  calcularLacunas,
  dentroDaDisponibilidade,
  diaSemanaIso,
  mascararContatos,
  calcularFim,
  janelaValida,
  emConflito,
  exigeMotivo,
  filtrarConflitos,
  mascarar,
  mascararHistorico,
  motivoValido,
  podeAlterar,
  podeRegistrarRealizacao,
  podeTransitar,
  sobrepoe,
  statusAposFalha,
  statusInicialLembrete,
} from "../src/grupo3/regras.js";

const P = "prof-1";
const INDIVIDUAL = "tipo-individual";
const GRUPO = "tipo-grupo";

function ag(inicio, minutos, extra = {}) {
  const i = new Date(`2030-03-12T${inicio}:00Z`);
  return { profissionalId: P, tipoId: INDIVIDUAL, permiteSobreposicao: false, inicio: i, fim: calcularFim(i, minutos), ...extra };
}

describe("grupo3 · sobreposição de horário", () => {
  it("encostar no fim do outro não sobrepõe (intervalo semiaberto)", () => {
    assert.equal(sobrepoe(ag("10:00", 30), ag("10:30", 30)), false);
    assert.equal(sobrepoe(ag("10:30", 30), ag("10:00", 30)), false);
  });

  it("um minuto dentro do outro sobrepõe", () => {
    assert.equal(sobrepoe(ag("10:00", 30), ag("10:29", 30)), true);
    assert.equal(sobrepoe(ag("10:00", 60), ag("10:15", 10)), true);
  });
});

describe("grupo3 · regra de conflito (US-073)", () => {
  it("mesmo profissional e horário sobreposto é conflito", () => {
    assert.equal(emConflito(ag("10:00", 30), ag("10:15", 30, { id: "a" })), true);
  });

  it("outro profissional não conflita", () => {
    assert.equal(emConflito(ag("10:00", 30), ag("10:00", 30, { id: "a", profissionalId: "prof-2" })), false);
  });

  it("cancelado, realizado e não realizado não conflitam", () => {
    for (const status of ["cancelado", "realizado", "nao_realizado"]) {
      assert.equal(emConflito(ag("10:00", 30), ag("10:00", 30, { id: "a", status })), false, status);
    }
  });

  it("mesmo tipo com permite_sobreposicao é exceção", () => {
    const novo = ag("10:00", 60, { tipoId: GRUPO, permiteSobreposicao: true });
    assert.equal(emConflito(novo, ag("10:00", 60, { id: "a", tipoId: GRUPO })), false);
  });

  it("tipos diferentes conflitam mesmo se um deles permitir sobreposição", () => {
    const grupo = ag("10:00", 60, { tipoId: GRUPO, permiteSobreposicao: true });
    const individual = ag("10:00", 30);
    assert.equal(emConflito(grupo, { ...individual, id: "a" }), true);
    assert.equal(emConflito(individual, { ...grupo, id: "b" }), true);
  });

  it("mesmo tipo sem permite_sobreposicao conflita", () => {
    assert.equal(emConflito(ag("10:00", 30), ag("10:00", 30, { id: "a" })), true);
  });

  it("no reagendamento o próprio agendamento é ignorado", () => {
    const existentes = [ag("10:00", 30, { id: "self" }), ag("11:00", 30, { id: "outro" })];
    assert.deepEqual(filtrarConflitos(ag("10:10", 30, { id: "self" }), existentes), []);
    assert.equal(filtrarConflitos(ag("10:50", 30, { id: "self" }), existentes).length, 1);
  });
});

describe("grupo3 · status e motivo (US-068, US-069)", () => {
  it("só sai de agendado para realizado, não realizado ou cancelado", () => {
    assert.equal(podeTransitar("agendado", "realizado"), true);
    assert.equal(podeTransitar("agendado", "nao_realizado"), true);
    assert.equal(podeTransitar("agendado", "cancelado"), true);
    assert.equal(podeTransitar("realizado", "cancelado"), false);
    assert.equal(podeTransitar("cancelado", "agendado"), false);
    assert.equal(podeAlterar("agendado"), true);
    assert.equal(podeAlterar("nao_realizado"), false);
  });

  it("realização respeita a tolerância antes do início", () => {
    const inicio = new Date("2030-03-12T10:00:00Z");
    assert.equal(podeRegistrarRealizacao(inicio, 60, new Date("2030-03-12T09:00:00Z")), true);
    assert.equal(podeRegistrarRealizacao(inicio, 60, new Date("2030-03-12T08:59:59Z")), false);
    assert.equal(podeRegistrarRealizacao(inicio, 0, new Date("2030-03-12T09:59:00Z")), false);
    assert.equal(podeRegistrarRealizacao(inicio, 0, inicio), true);
  });

  it("motivo obrigatório segue a configuração do tipo", () => {
    const tipo = { exigeMotivoCancelamento: true, exigeMotivoReagendamento: false };
    assert.equal(exigeMotivo(tipo, "cancelar"), true);
    assert.equal(exigeMotivo(tipo, "reagendar"), false);
    assert.equal(motivoValido("  "), false);
    assert.equal(motivoValido("ok"), false);
    assert.equal(motivoValido("Idoso internado"), true);
  });
});

describe("grupo3 · LGPD na agenda", () => {
  const consulta = {
    id: "a", tipo: { categoria: "consulta_medica" }, profissional: { id: "c1" },
    observacoes: "Revisão de pressão", motivoStatus: null, observacaoRealizacao: "PA 13x8",
  };

  it("esconde texto clínico de quem não tem permissão clínica", () => {
    const visto = mascarar(consulta, { permissions: ["agenda.visualizar"] });
    assert.equal(visto.observacoes, null);
    assert.equal(visto.observacaoRealizacao, null);
    assert.equal(visto.conteudoRestrito, true);
  });

  it("mostra para quem tem a permissão clínica e para o próprio profissional", () => {
    assert.equal(mascarar(consulta, { permissions: ["atendimento-clinico.visualizar"] }).observacoes, "Revisão de pressão");
    assert.equal(mascarar(consulta, { permissions: [] }, "c1").observacoes, "Revisão de pressão");
  });

  it("cuidado pessoal não é dado clínico", () => {
    const corte = { ...consulta, tipo: { categoria: "cuidado_pessoal" } };
    assert.equal(mascarar(corte, { permissions: [] }).observacoes, "Revisão de pressão");
  });

  it("histórico clínico perde motivo e texto livre sem permissão", () => {
    const item = { acao: "realizado", novo: { status: "realizado", observacaoRealizacao: "PA 13x8" }, motivo: "x" };
    const visto = mascararHistorico(item, "fisioterapia", { permissions: ["agenda.visualizar"] });
    assert.equal(visto.novo.observacaoRealizacao, undefined);
    assert.equal(visto.novo.status, "realizado");
    assert.equal(visto.motivo, null);
  });
});

describe("grupo3 · lembretes (US-074)", () => {
  const inicio = new Date("2030-03-12T13:00:00Z");

  it("agenda cada antecedência antes do início", () => {
    const envios = calcularEnvios(inicio, [60, 1440], new Date("2030-03-10T12:00:00Z"));
    assert.deepEqual(envios.map((e) => [e.antecedenciaMin, e.enviarEm.toISOString()]), [
      [1440, "2030-03-11T13:00:00.000Z"],
      [60, "2030-03-12T12:00:00.000Z"],
    ]);
  });

  it("antecedências vencidas viram um único envio imediato", () => {
    const agora = new Date("2030-03-12T12:30:00Z");
    const envios = calcularEnvios(inicio, [1440, 60, 120], agora);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].antecedenciaMin, 60);
    assert.equal(envios[0].enviarEm.toISOString(), agora.toISOString());
  });

  it("atendimento já iniciado ou sem antecedência não gera lembrete", () => {
    assert.deepEqual(calcularEnvios(inicio, [1440], inicio), []);
    assert.deepEqual(calcularEnvios(inicio, [], new Date("2030-03-01T00:00:00Z")), []);
  });

  it("sem usuário vinculado o lembrete nasce sem destinatário", () => {
    assert.equal(statusInicialLembrete(null), "sem_destinatario");
    assert.equal(statusInicialLembrete("a2f1c7e0-0000-4000-8000-000000000000"), "pendente");
  });

  it("falha volta para a fila até esgotar as tentativas", () => {
    assert.equal(statusAposFalha(1, 3), "pendente");
    assert.equal(statusAposFalha(3, 3), "falha");
  });
});

describe("grupo3 · janela de atendimento (US-070)", () => {
  it("fim da janela precisa ser depois do início", () => {
    assert.equal(janelaValida("08:00", "10:00"), true);
    assert.equal(janelaValida("10:00", "10:00"), false);
    assert.equal(janelaValida("10:00", undefined), true);
  });
});

describe("grupo3 · lacunas da escala (US-084)", () => {
  const necessidade = { inicio: "08:00", fim: "12:00", minimo: 2 };

  it("sem ninguém escalado a faixa inteira é lacuna", () => {
    assert.deepEqual(calcularLacunas(necessidade, []), [
      { inicio: "08:00", fim: "12:00", necessario: 2, escalados: 0, faltam: 2 },
    ]);
  });

  it("aponta só os trechos abaixo do mínimo", () => {
    const turnos = [{ inicio: "08:00", fim: "10:00" }, { inicio: "09:00", fim: "12:00" }];
    assert.deepEqual(calcularLacunas(necessidade, turnos), [
      { inicio: "08:00", fim: "09:00", necessario: 2, escalados: 1, faltam: 1 },
      { inicio: "10:00", fim: "12:00", necessario: 2, escalados: 1, faltam: 1 },
    ]);
  });

  it("turno fora da faixa não conta e cobertura completa não gera lacuna", () => {
    assert.equal(calcularLacunas({ ...necessidade, minimo: 1 }, [{ inicio: "13:00", fim: "17:00" }]).length, 1);
    assert.deepEqual(calcularLacunas({ ...necessidade, minimo: 1 }, [{ inicio: "07:00", fim: "13:00" }]), []);
  });

  it("une trechos vizinhos com a mesma contagem", () => {
    const turnos = [{ inicio: "08:00", fim: "09:00" }, { inicio: "09:00", fim: "12:00" }];
    assert.deepEqual(calcularLacunas(necessidade, turnos), [
      { inicio: "08:00", fim: "12:00", necessario: 2, escalados: 1, faltam: 1 },
    ]);
  });

  it("dia da semana ISO", () => {
    assert.equal(diaSemanaIso("2030-06-03"), 1);
    assert.equal(diaSemanaIso("2030-06-04"), 2);
    assert.equal(diaSemanaIso("2030-06-09"), 7);
  });
});

describe("grupo3 · disponibilidade e contatos (US-082, US-091, US-092)", () => {
  const disp = [{ diaSemana: 2, inicio: "08:00", fim: "12:00" }];

  it("turno dentro, fora ou sem disponibilidade declarada", () => {
    assert.equal(dentroDaDisponibilidade(disp, 2, "08:00", "12:00"), true);
    assert.equal(dentroDaDisponibilidade(disp, 2, "11:00", "13:00"), false);
    assert.equal(dentroDaDisponibilidade(disp, 3, "08:00", "09:00"), false);
    assert.equal(dentroDaDisponibilidade([], 2, "08:00", "09:00"), null);
  });

  it("contatos só com equipe.visualizar", () => {
    const colaborador = { nome: "Fulana", email: "f@x.example", telefone: "(11) 90000-0000", cargo: "Cuidadora" };
    const restrito = mascararContatos(colaborador, { permissions: ["agenda.criar"] });
    assert.equal(restrito.email, null);
    assert.equal(restrito.telefone, null);
    assert.equal(restrito.cargo, "Cuidadora");
    assert.equal(restrito.contatosRestritos, true);
    assert.equal(mascararContatos(colaborador, { permissions: ["equipe.visualizar"] }).email, "f@x.example");
  });
});

describe("grupo3 · turnos que atravessam a meia-noite", () => {
  it("divide 19h–07h em dois trechos e 19h–00h em um", () => {
    assert.deepEqual(segmentosDoTurno("2030-06-05", "19:00", "07:00"), [
      { data: "2030-06-05", diaSemana: 3, inicio: "19:00", fim: "24:00" },
      { data: "2030-06-06", diaSemana: 4, inicio: "00:00", fim: "07:00" },
    ]);
    assert.equal(segmentosDoTurno("2030-06-05", "19:00", "00:00").length, 1);
  });

  it("disponibilidade conferida trecho a trecho no fuso local", () => {
    const disp = [{ diaSemana: 3, inicio: "19:00", fim: "24:00" }, { diaSemana: 4, inicio: "00:00", fim: "07:00" }];
    assert.equal(turnoDentroDaDisponibilidade(disp, "2030-06-05", "19:00", "07:00"), true);
    assert.equal(turnoDentroDaDisponibilidade(disp, "2030-06-05", "19:00", "08:00"), false);
    assert.equal(turnoDentroDaDisponibilidade([], "2030-06-05", "19:00", "07:00"), null);
  });

  it("recorta o turno no dia e a lacuna aceita minutos", () => {
    assert.deepEqual(recortarNoDia("2030-06-05 19:00", "2030-06-06 05:00", "2030-06-06"), { inicio: 0, fim: 300 });
    assert.deepEqual(recortarNoDia("2030-06-05 19:00", "2030-06-06 05:00", "2030-06-05"), { inicio: 1140, fim: 1440 });
    assert.equal(recortarNoDia("2030-06-05 08:00", "2030-06-05 12:00", "2030-06-06"), null);
    assert.deepEqual(calcularLacunas({ inicio: "00:00", fim: "07:00", minimo: 1 }, [{ inicio: 0, fim: 300 }]), [
      { inicio: "05:00", fim: "07:00", necessario: 1, escalados: 0, faltam: 1 },
    ]);
    assert.deepEqual(calcularLacunas({ inicio: "19:00", fim: "24:00", minimo: 1 }, [{ inicio: 1140, fim: 1440 }]), []);
  });
});

describe("grupo3 · ciclo odontológico (US-089)", () => {
  const semestre = { modo: "semestre_civil", dias: 180 };

  it("semestre civil pelo parâmetro AAAA-S ou pela data de referência", () => {
    assert.deepEqual(periodoDoCiclo(semestre, { ciclo: "2026-1" }, "2026-11-09"),
      { modo: "semestre_civil", rotulo: "2026-1", inicio: "2026-01-01", fim: "2026-06-30" });
    assert.equal(periodoDoCiclo(semestre, {}, "2026-11-09").rotulo, "2026-2");
    assert.equal(periodoDoCiclo(semestre, { referencia: "2026-06-30" }, "2026-11-09").rotulo, "2026-1");
    assert.equal(periodoDoCiclo(semestre, { referencia: "2026-07-01" }, "2026-11-09").inicio, "2026-07-01");
  });

  it("ciclo inválido e parâmetro trocado de modo são recusados", () => {
    assert.throws(() => periodoDoCiclo(semestre, { ciclo: "2026-3" }, "2026-11-09"), /AAAA-S/);
    assert.throws(() => periodoDoCiclo({ modo: "dias_corridos", dias: 90 }, { ciclo: "2026-2" }, "2026-11-09"), /semestre_civil/);
  });

  it("dias corridos termina na referência, inclusive", () => {
    assert.deepEqual(periodoDoCiclo({ modo: "dias_corridos", dias: 30 }, { referencia: "2026-03-01" }, "2026-11-09"),
      { modo: "dias_corridos", rotulo: "30 dias até 2026-03-01", inicio: "2026-01-31", fim: "2026-03-01" });
  });

  it("área clínica pela categoria do tipo", () => {
    assert.equal(areaClinica("consulta_medica"), "medica");
    assert.equal(areaClinica("consulta_odontologica"), "odontologica");
    assert.equal(areaClinica("avaliacao"), null);
  });
});

describe("grupo3 · rotina semanal da fisioterapia (US-079)", () => {
  it("semana de segunda a domingo", () => {
    assert.deepEqual(diasDaSemana("2030-09-04"), ["2030-09-02", "2030-09-03", "2030-09-04", "2030-09-05", "2030-09-06", "2030-09-07", "2030-09-08"]);
    assert.equal(diasDaSemana("2030-09-08")[0], "2030-09-02");
  });

  it("carga por dia conta só agendado e realizado", () => {
    const p = { id: "c1", nome: "Renata" };
    const sessoes = [
      { data: "2030-09-02", status: "agendado", duracaoMin: 40, profissional: p },
      { data: "2030-09-02", status: "realizado", duracaoMin: 30, profissional: p },
      { data: "2030-09-02", status: "cancelado", duracaoMin: 40, profissional: p },
      { data: "2030-09-03", status: "nao_realizado", duracaoMin: 40, profissional: p },
    ];
    const carga = cargaPorDia(diasDaSemana("2030-09-02"), sessoes);
    assert.equal(carga[0].sessoes, 2);
    assert.equal(carga[0].minutos, 70);
    assert.deepEqual(carga[0].porProfissional, [{ id: "c1", nome: "Renata", sessoes: 2, minutos: 70 }]);
    assert.equal(carga[1].sessoes, 0);
  });

  it("taxa com uma casa decimal e sem divisão por zero", () => {
    assert.equal(taxa(2, 3), 66.7);
    assert.equal(taxa(0, 0), null);
  });
});

describe("grupo3 · tarefas e alertas (US-095, US-096, T-008)", () => {
  it("transições de status: concluída e cancelada são finais", () => {
    assert.equal(transicaoTarefaValida("pendente", "em_andamento"), true);
    assert.equal(transicaoTarefaValida("em_andamento", "pendente"), true);
    assert.equal(transicaoTarefaValida("em_andamento", "concluida"), true);
    assert.equal(transicaoTarefaValida("pendente", "pendente"), false);
    assert.equal(transicaoTarefaValida("concluida", "pendente"), false);
    assert.equal(transicaoTarefaValida("cancelada", "em_andamento"), false);
  });

  it("atrasada: prazo vencido e tarefa aberta", () => {
    const agora = new Date("2030-01-10T12:00:00Z");
    assert.equal(tarefaAtrasada({ status: "pendente", prazo: "2030-01-10T11:59:00Z" }, agora), true);
    assert.equal(tarefaAtrasada({ status: "em_andamento", prazo: "2030-01-10T12:00:00Z" }, agora), false);
    assert.equal(tarefaAtrasada({ status: "concluida", prazo: "2030-01-01T00:00:00Z" }, agora), false);
  });

  it("texto de pendência odontológica só com o resumo", () => {
    assert.equal(textoPendenciasOdonto(5, "2026-2"), "5 idosos sem avaliação odontológica no ciclo 2026-2");
    assert.equal(textoPendenciasOdonto(1, "2026-2"), "1 idoso sem avaliação odontológica no ciclo 2026-2");
  });

  it("chave do ciclo para não repetir aviso", () => {
    assert.equal(chaveCicloOdonto({ modo: "semestre_civil", rotulo: "2026-2" }, "2026-11-09"), "2026-2");
    assert.equal(chaveCicloOdonto({ modo: "dias_corridos", rotulo: "180 dias até 2026-11-09" }, "2026-11-09"), "dias_corridos:2026-11");
  });
});

describe("grupo3 · período dos relatórios (US-081, US-090)", () => {
  it("até 12 meses: de 2025-01-01 vai no máximo até 2025-12-31", () => {
    assert.equal(periodoAte12Meses("2025-01-01", "2025-12-31"), true);
    assert.equal(periodoAte12Meses("2025-01-01", "2026-01-01"), false);
    assert.equal(periodoAte12Meses("2025-03-10", "2025-03-01"), false);
  });

  it("soma de meses respeita o fim do mês", () => {
    assert.equal(somarMeses("2024-02-29", 12), "2025-02-28");
    assert.equal(somarMeses("2025-01-31", 1), "2025-02-28");
  });
});

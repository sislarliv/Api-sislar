// Regras de negócio do Grupo 3 sem acesso a banco, para teste unitário.

export const STATUS_AGENDAMENTO = ["agendado", "realizado", "nao_realizado", "cancelado"];
export const STATUS_REALIZACAO = ["realizado", "nao_realizado"];

export const CATEGORIAS = [
  "consulta_medica",
  "consulta_odontologica",
  "fisioterapia",
  "cuidado_pessoal",
  "farmacia",
  "avaliacao",
  "outro",
];

// Categorias com dado de saúde (LGPD): o conteúdo livre só aparece para quem tem a permissão clínica.
const PERMISSAO_CLINICA = {
  consulta_medica: "atendimento-clinico.visualizar",
  consulta_odontologica: "atendimento-clinico.visualizar",
  avaliacao: "atendimento-clinico.visualizar",
  fisioterapia: "fisioterapia.visualizar",
};

const CAMPOS_SENSIVEIS = ["observacoes", "motivoStatus", "observacaoRealizacao"];

function ms(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function calcularFim(inicio, duracaoMin) {
  return new Date(ms(inicio) + duracaoMin * 60_000);
}

// Intervalos semiabertos [inicio, fim): encostar no fim do outro não é sobreposição.
export function sobrepoe(a, b) {
  return ms(a.inicio) < ms(b.fim) && ms(b.inicio) < ms(a.fim);
}

/**
 * Há conflito quando o mesmo profissional tem outro agendamento "agendado" que se sobrepõe.
 * Exceção: os dois são do MESMO tipo e esse tipo permite sobreposição (ex.: atendimento em grupo).
 * `novo` e cada `existente` têm { id?, profissionalId, tipoId, permiteSobreposicao, inicio, fim, status? }.
 */
export function emConflito(novo, existente) {
  if (existente.id && novo.id && existente.id === novo.id) return false;
  if ((existente.status ?? "agendado") !== "agendado") return false;
  if (existente.profissionalId !== novo.profissionalId) return false;
  if (!sobrepoe(novo, existente)) return false;
  const mesmoTipoComExcecao = existente.tipoId === novo.tipoId && novo.permiteSobreposicao === true;
  return !mesmoTipoComExcecao;
}

export function filtrarConflitos(novo, existentes) {
  return existentes.filter((existente) => emConflito(novo, existente));
}

export function podeAlterar(status) {
  return status === "agendado";
}

export function podeTransitar(de, para) {
  return de === "agendado" && ["realizado", "nao_realizado", "cancelado"].includes(para);
}

// A realização pode ser registrada a partir de `toleranciaMin` minutos antes do início.
export function podeRegistrarRealizacao(inicio, toleranciaMin, agora = new Date()) {
  return ms(agora) >= ms(inicio) - toleranciaMin * 60_000;
}

export function exigeMotivo(tipo, acao) {
  if (acao === "cancelar") return tipo.exigeMotivoCancelamento === true;
  if (acao === "reagendar") return tipo.exigeMotivoReagendamento === true;
  return false;
}

export function motivoValido(motivo) {
  return typeof motivo === "string" && motivo.trim().length >= 3;
}

export function permissaoClinica(categoria) {
  return PERMISSAO_CLINICA[categoria] ?? null;
}

/**
 * Esconde texto livre de agendamentos clínicos para quem não tem a permissão clínica.
 * O profissional do próprio agendamento sempre vê o conteúdo.
 */
export function mascarar(agendamento, usuario, colaboradorId = null) {
  const exigida = permissaoClinica(agendamento.tipo?.categoria);
  if (!exigida) return agendamento;
  if (usuario.permissions.includes(exigida)) return agendamento;
  if (colaboradorId && agendamento.profissional?.id === colaboradorId) return agendamento;
  const copia = { ...agendamento, conteudoRestrito: true };
  for (const campo of CAMPOS_SENSIVEIS) {
    if (copia[campo] != null) copia[campo] = null;
  }
  return copia;
}

export function mascararHistorico(item, categoria, usuario, ehProfissional = false) {
  const exigida = permissaoClinica(categoria);
  if (!exigida || ehProfissional || usuario.permissions.includes(exigida)) return item;
  const limpar = (valor) => {
    if (!valor) return valor;
    const copia = { ...valor };
    for (const campo of CAMPOS_SENSIVEIS) delete copia[campo];
    return copia;
  };
  return { ...item, anterior: limpar(item.anterior), novo: limpar(item.novo), motivo: null, conteudoRestrito: true };
}

// ---------- Lembretes (US-074) ----------

export const STATUS_LEMBRETE = ["pendente", "enviado", "entregue", "falha", "sem_destinatario", "cancelado"];

/**
 * Horários de envio dos lembretes de um agendamento. Atendimento já iniciado não gera lembrete.
 * Antecedências que já passaram viram um único envio imediato (o de menor antecedência), para não
 * disparar vários avisos atrasados de uma vez.
 */
export function calcularEnvios(inicio, antecedencias, agora = new Date()) {
  const inicioMs = ms(inicio);
  const agoraMs = ms(agora);
  if (inicioMs <= agoraMs) return [];
  const unicas = [...new Set(antecedencias)].sort((a, b) => b - a);
  const futuros = [];
  let atrasada = null;
  for (const antecedenciaMin of unicas) {
    const enviarMs = inicioMs - antecedenciaMin * 60_000;
    if (enviarMs > agoraMs) futuros.push({ antecedenciaMin, enviarEm: new Date(enviarMs) });
    else if (atrasada === null || antecedenciaMin < atrasada) atrasada = antecedenciaMin;
  }
  if (atrasada !== null) futuros.push({ antecedenciaMin: atrasada, enviarEm: new Date(agoraMs) });
  return futuros;
}

export function statusInicialLembrete(usuarioRef) {
  return usuarioRef ? "pendente" : "sem_destinatario";
}

// Depois de uma falha: volta para a fila até esgotar as tentativas.
export function statusAposFalha(tentativas, maxTentativas) {
  return tentativas >= maxTentativas ? "falha" : "pendente";
}

// ---------- Janela de atendimento (US-070) ----------

export function minutosDoDia(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function janelaValida(inicio, fim) {
  if (!inicio || !fim) return true;
  return minutosDoDia(fim) > minutosDoDia(inicio);
}

// ---------- Escala e cobertura (US-083, US-084) ----------

export function minutosParaHorario(minutos) {
  const h = String(Math.floor(minutos / 60)).padStart(2, "0");
  const m = String(minutos % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// Dia da semana ISO (1 = segunda ... 7 = domingo) de uma data AAAA-MM-DD.
export function diaSemanaIso(data) {
  const dia = new Date(`${data}T00:00:00Z`).getUTCDay();
  return dia === 0 ? 7 : dia;
}

export function horariosSobrepoem(a, b) {
  return minutosDoDia(a.inicio) < minutosDoDia(b.fim) && minutosDoDia(b.inicio) < minutosDoDia(a.fim);
}

/**
 * Trechos da faixa necessária com menos profissionais escalados que o mínimo.
 * `necessidade` = { inicio: "HH:MM", fim: "HH:MM" (aceita "24:00"), minimo }; `turnos` = [{ inicio, fim }] do
 * mesmo dia e área, em "HH:MM" ou em minutos desde a meia-noite (0 a 1440) já recortados para o dia.
 * Trechos vizinhos com a mesma contagem são unidos.
 */
export function calcularLacunas(necessidade, turnos) {
  const paraMin = (valor) => (typeof valor === "number" ? valor : minutosDoDia(valor));
  const ini = paraMin(necessidade.inicio);
  const fim = paraMin(necessidade.fim);
  const faixas = turnos.map((t) => [paraMin(t.inicio), paraMin(t.fim)]);
  const marcos = new Set([ini, fim]);
  for (const [a, b] of faixas) {
    if (a > ini && a < fim) marcos.add(a);
    if (b > ini && b < fim) marcos.add(b);
  }
  const ordenados = [...marcos].sort((x, y) => x - y);
  const lacunas = [];
  for (let i = 0; i < ordenados.length - 1; i += 1) {
    const a = ordenados[i];
    const b = ordenados[i + 1];
    const escalados = faixas.filter(([t0, t1]) => t0 <= a && t1 >= b).length;
    if (escalados >= necessidade.minimo) continue;
    const ultima = lacunas[lacunas.length - 1];
    if (ultima && ultima.fimMin === a && ultima.escalados === escalados) {
      ultima.fimMin = b;
    } else {
      lacunas.push({ inicioMin: a, fimMin: b, escalados });
    }
  }
  return lacunas.map((l) => ({
    inicio: minutosParaHorario(l.inicioMin),
    fim: minutosParaHorario(l.fimMin),
    necessario: necessidade.minimo,
    escalados: l.escalados,
    faltam: necessidade.minimo - l.escalados,
  }));
}

/**
 * O turno cabe numa disponibilidade declarada? Sem disponibilidade cadastrada, devolve null (sem aviso).
 * `disponibilidades` = [{ diaSemana, inicio: "HH:MM", fim: "HH:MM" }].
 */
export function dentroDaDisponibilidade(disponibilidades, diaSemana, inicio, fim) {
  if (!disponibilidades.length) return null;
  return disponibilidades.some((d) => d.diaSemana === diaSemana
    && minutosDoDia(d.inicio) <= minutosDoDia(inicio) && minutosDoDia(d.fim) >= minutosDoDia(fim));
}

// ---------- Contatos da equipe ----------

const CAMPOS_CONTATO = ["email", "telefone"];

// Contatos e dados pessoais do colaborador só com equipe.visualizar.
export function mascararContatos(colaborador, usuario) {
  if (usuario.permissions.includes("equipe.visualizar")) return colaborador;
  const copia = { ...colaborador, contatosRestritos: true };
  for (const campo of CAMPOS_CONTATO) copia[campo] = null;
  return copia;
}

// ---------- Turnos que atravessam a meia-noite ----------

export function somarDias(data, dias) {
  return new Date(Date.parse(`${data}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}

// Fim menor ou igual ao início indica que o turno termina no dia seguinte.
export function cruzaMeiaNoite(horaInicio, horaFim) {
  return minutosDoDia(horaFim) <= minutosDoDia(horaInicio);
}

/** Divide um turno local em trechos por dia: 19:00–07:00 vira [dia 19:00–24:00, dia+1 00:00–07:00]. */
export function segmentosDoTurno(data, horaInicio, horaFim) {
  if (!cruzaMeiaNoite(horaInicio, horaFim)) {
    return [{ data, diaSemana: diaSemanaIso(data), inicio: horaInicio, fim: horaFim }];
  }
  const seguinte = somarDias(data, 1);
  const segmentos = [{ data, diaSemana: diaSemanaIso(data), inicio: horaInicio, fim: "24:00" }];
  if (horaFim !== "00:00") segmentos.push({ data: seguinte, diaSemana: diaSemanaIso(seguinte), inicio: "00:00", fim: horaFim });
  return segmentos;
}

/** Turno inteiro dentro da disponibilidade (comparada no fuso da instituição, trecho a trecho). */
export function turnoDentroDaDisponibilidade(disponibilidades, data, horaInicio, horaFim) {
  if (!disponibilidades.length) return null;
  return segmentosDoTurno(data, horaInicio, horaFim)
    .every((seg) => dentroDaDisponibilidade(disponibilidades, seg.diaSemana, seg.inicio, seg.fim) === true);
}

/**
 * Recorta um turno (horários locais "AAAA-MM-DD HH:MM") para os minutos de um dia: { inicio, fim } em
 * 0..1440, ou null se o turno não toca o dia.
 */
export function recortarNoDia(inicioLocal, fimLocal, data) {
  const base = Date.parse(`${data}T00:00:00Z`);
  const ini = (Date.parse(`${inicioLocal.replace(" ", "T")}:00Z`) - base) / 60_000;
  const fim = (Date.parse(`${fimLocal.replace(" ", "T")}:00Z`) - base) / 60_000;
  const a = Math.max(ini, 0);
  const b = Math.min(fim, 1440);
  return b > a ? { inicio: a, fim: b } : null;
}

// ---------- Atendimento médico e odontológico (US-085 a US-089) ----------

const AREA_POR_CATEGORIA = { consulta_medica: "medica", consulta_odontologica: "odontologica" };

export function areaClinica(categoria) {
  return AREA_POR_CATEGORIA[categoria] ?? null;
}

export function ehConsulta(categoria) {
  return areaClinica(categoria) !== null;
}

/**
 * Período do ciclo odontológico (US-089).
 * - semestre_civil: `ciclo` = "AAAA-S" (S = 1 jan–jun, 2 jul–dez); padrão = semestre da data de referência.
 * - dias_corridos: janela de `dias` dias terminando na data de referência (inclusive).
 * Lança Error com `campo` quando o parâmetro não serve para o modo configurado.
 */
export function periodoDoCiclo(config, { ciclo, referencia }, hoje) {
  const ref = referencia ?? hoje;
  if (config.modo === "dias_corridos") {
    if (ciclo) throw Object.assign(new Error("O ciclo AAAA-S só vale no modo semestre_civil; use referencia."), { campo: "ciclo" });
    const dias = Number(config.dias);
    return { modo: "dias_corridos", rotulo: `${dias} dias até ${ref}`, inicio: somarDias(ref, -(dias - 1)), fim: ref };
  }
  let ano;
  let semestre;
  if (ciclo) {
    const m = /^(\d{4})-([12])$/.exec(ciclo);
    if (!m) throw Object.assign(new Error("Use o ciclo no formato AAAA-S, com S = 1 ou 2 (ex.: 2026-2)."), { campo: "ciclo" });
    ano = Number(m[1]);
    semestre = Number(m[2]);
  } else {
    ano = Number(ref.slice(0, 4));
    semestre = Number(ref.slice(5, 7)) <= 6 ? 1 : 2;
  }
  return {
    modo: "semestre_civil",
    rotulo: `${ano}-${semestre}`,
    inicio: semestre === 1 ? `${ano}-01-01` : `${ano}-07-01`,
    fim: semestre === 1 ? `${ano}-06-30` : `${ano}-12-31`,
  };
}

// ---------- Fisioterapia (US-079, US-080) ----------

// Segunda a domingo da semana que contém a data.
export function diasDaSemana(data) {
  const segunda = somarDias(data, 1 - diaSemanaIso(data));
  return Array.from({ length: 7 }, (_, i) => somarDias(segunda, i));
}

export const STATUS_QUE_CONTAM_NA_CARGA = ["agendado", "realizado"];

/**
 * Carga por dia da semana: só sessões "agendado" ou "realizado".
 * `sessoes` = [{ data: "AAAA-MM-DD" (local), status, duracaoMin, profissional: { id, nome } }].
 */
export function cargaPorDia(dias, sessoes) {
  return dias.map((data) => {
    const doDia = sessoes.filter((s) => s.data === data && STATUS_QUE_CONTAM_NA_CARGA.includes(s.status));
    const porProfissional = new Map();
    for (const s of doDia) {
      const atual = porProfissional.get(s.profissional.id) ?? { ...s.profissional, sessoes: 0, minutos: 0 };
      atual.sessoes += 1;
      atual.minutos += s.duracaoMin;
      porProfissional.set(s.profissional.id, atual);
    }
    return {
      data,
      diaSemana: diaSemanaIso(data),
      sessoes: doDia.length,
      minutos: doDia.reduce((soma, s) => soma + s.duracaoMin, 0),
      porProfissional: [...porProfissional.values()],
    };
  });
}

export function taxa(parte, total) {
  return total ? Math.round((parte / total) * 1000) / 10 : null;
}

// ---------- Tarefas (US-094 a US-096) ----------

export const STATUS_TAREFA = ["pendente", "em_andamento", "concluida", "cancelada"];
export const STATUS_TAREFA_ABERTA = ["pendente", "em_andamento"];

// Concluída e cancelada são finais; entre pendente e em_andamento pode ir e voltar.
export function transicaoTarefaValida(de, para) {
  return STATUS_TAREFA_ABERTA.includes(de) && STATUS_TAREFA.includes(para) && de !== para;
}

// Atrasada é derivado: prazo vencido e tarefa ainda aberta.
export function tarefaAtrasada(tarefa, agora = new Date()) {
  return STATUS_TAREFA_ABERTA.includes(tarefa.status) && ms(tarefa.prazo) < ms(agora);
}

// ---------- Notificações dos jobs (T-008) ----------

/**
 * Chave do ciclo odontológico usada para não repetir aviso: o rótulo do semestre (ex.: "2026-2") ou, em
 * dias corridos, o mês corrente (no máximo um aviso por idoso por mês).
 */
export function chaveCicloOdonto(periodo, hoje) {
  return periodo.modo === "semestre_civil" ? periodo.rotulo : `dias_corridos:${hoje.slice(0, 7)}`;
}

// Texto da notificação de pendência odontológica: só o resumo, sem nomes de idosos.
export function textoPendenciasOdonto(quantidade, rotulo) {
  const idosos = quantidade === 1 ? "1 idoso" : `${quantidade} idosos`;
  return `${idosos} sem avaliação odontológica no ciclo ${rotulo}`;
}

// ---------- Relatórios (US-081, US-090) ----------

// Mesma data, N meses depois (dia limitado ao fim do mês).
export function somarMeses(data, meses) {
  const [ano, mes, diaDoMes] = data.split("-").map(Number);
  const alvo = new Date(Date.UTC(ano, mes - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(diaDoMes, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

// Período de até 12 meses: de 2025-01-01 vai no máximo até 2025-12-31.
export function periodoAte12Meses(inicio, fim) {
  return fim >= inicio && fim < somarMeses(inicio, 12);
}

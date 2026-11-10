// OpenAPI do Grupo 3 — Agenda, atendimentos e profissionais. Juntado em openapi.js.

const uuid = { type: "string", format: "uuid" };
const dataHora = { type: "string", format: "date-time", example: "2026-11-10T14:00:00-03:00" };
const idosoId = { type: "string", pattern: "^[A-Za-z0-9_-]+$", example: "p02" };
const categoria = {
  type: "string",
  enum: ["consulta_medica", "consulta_odontologica", "fisioterapia", "cuidado_pessoal", "farmacia", "avaliacao", "outro"],
};
const statusAgendamento = { type: "string", enum: ["agendado", "realizado", "nao_realizado", "cancelado"] };

const path = (name, schema = uuid) => ({ name, in: "path", required: true, schema });
const query = (name, schema, description) => ({ name, in: "query", required: false, schema, ...(description ? { description } : {}) });
const pagina = [
  query("page", { type: "integer", minimum: 1, default: 1 }),
  query("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 }),
];

const erro = (message, details = null) => ({ error: { message, details } });
const ERROS = {
  401: { $ref: "#/components/responses/NaoAutenticado" },
  403: { $ref: "#/components/responses/SemPermissao" },
  404: { $ref: "#/components/responses/NaoEncontrado" },
  409: { $ref: "#/components/responses/Conflito" },
  422: { $ref: "#/components/responses/Invalido" },
};

function op(tag, summary, perm, extras = {}) {
  const status = String(extras.status || 200);
  const operation = {
    tags: [tag],
    summary,
    description: [perm ? `Permissão: \`${perm}\`.` : "Exige sessão autenticada.", extras.description].filter(Boolean).join("\n\n"),
    security: [{ bearerAuth: [] }],
    responses: {
      [status]: {
        description: status === "201" ? "Criado." : "Sucesso.",
        content: { "application/json": { schema: extras.schema || { type: "object", additionalProperties: true }, ...(extras.example ? { example: extras.example } : {}) } },
      },
      401: ERROS[401],
      403: ERROS[403],
      422: ERROS[422],
    },
  };
  for (const code of extras.errors || []) operation.responses[code] = ERROS[code];
  if (extras.conflictExample) {
    operation.responses[409] = {
      description: "Conflito de agenda ou estado atual impede a operação.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Erro" }, example: extras.conflictExample } },
    };
  }
  const parameters = [...(extras.params || []), ...(extras.query || [])];
  if (parameters.length) operation.parameters = parameters;
  if (extras.body) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: extras.body, ...(extras.bodyExample ? { example: extras.bodyExample } : {}) } },
    };
  }
  return operation;
}

// ---------- Exemplos ----------

const exemploTipo = {
  id: "0b7f9a64-3f1e-4c55-9f0a-0d6f3b1f6a10",
  nome: "Fisioterapia em grupo",
  categoria: "fisioterapia",
  descricao: null,
  duracaoPadraoMin: 60,
  exigeMotivoCancelamento: true,
  exigeMotivoReagendamento: false,
  permiteSobreposicao: true,
  toleranciaRealizacaoMin: 60,
  antecedenciasLembreteMin: null,
  ativo: true,
  criadoEm: "2026-11-09T12:00:00.000Z",
  atualizadoEm: "2026-11-09T12:00:00.000Z",
};

const exemploColaborador = {
  id: "5d2c8f0e-8a7b-4b8e-9b61-7c3f3e2a1b00",
  nome: "Renata Gouveia",
  vinculo: "funcionario",
  status: "ativo",
  cargo: "Fisioterapeuta",
  setor: "Fisioterapia",
  especialidade: { id: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", nome: "Fisioterapia" },
  registroProfissional: "CREFITO-3 000.321",
  email: "renata.gouveia@lardoirmaovelho.example",
  telefone: "(11) 90000-0006",
  usuario: { id: "s06", nome: "Renata Gouveia" },
  criadoEm: "2026-11-09T12:00:00.000Z",
  atualizadoEm: "2026-11-09T12:00:00.000Z",
};

const exemploAgendamento = {
  id: "9a1c6e1e-2f43-4d0b-8a8e-1f0c2b3d4e5f",
  idoso: { id: "p02", nome: "Antônio Pereira" },
  tipo: { id: exemploTipo.id, nome: "Sessão de fisioterapia", categoria: "fisioterapia" },
  profissional: { id: exemploColaborador.id, nome: "Renata Gouveia" },
  inicio: "2026-11-10T17:00:00.000Z",
  fim: "2026-11-10T17:40:00.000Z",
  duracaoMin: 40,
  local: "Sala de fisioterapia",
  observacoes: "Treino de marcha com andador.",
  status: "agendado",
  motivoStatus: null,
  responsavelRealizacao: null,
  observacaoRealizacao: null,
  registradoPor: null,
  concluidoEm: null,
  criadoEm: "2026-11-09T12:00:00.000Z",
  atualizadoEm: "2026-11-09T12:00:00.000Z",
  emConflito: false,
  planoFisioterapiaId: null,
};

const exemploConflito = erro("O profissional já tem agendamento nesse horário.", {
  conflitos: [{
    agendamentoId: "1f2e3d4c-5b6a-4789-8a0b-1c2d3e4f5a6b",
    tipo: { id: exemploTipo.id, nome: "Sessão de fisioterapia" },
    inicio: "2026-11-10T17:00:00.000Z",
    fim: "2026-11-10T17:40:00.000Z",
  }],
});

const lista = (item) => ({ data: [item], meta: { page: 1, limit: 20, total: 1, pages: 1 } });

// ---------- Corpos ----------

const corpoTipo = {
  type: "object",
  required: ["nome", "categoria", "duracaoPadraoMin"],
  properties: {
    nome: { type: "string", minLength: 2, maxLength: 120 },
    categoria,
    descricao: { type: "string", maxLength: 1000, nullable: true },
    duracaoPadraoMin: { type: "integer", minimum: 5, maximum: 720 },
    exigeMotivoCancelamento: { type: "boolean", default: true },
    exigeMotivoReagendamento: { type: "boolean", default: true },
    permiteSobreposicao: {
      type: "boolean",
      default: false,
      description: "Permite sobrepor apenas agendamentos do MESMO tipo (ex.: atendimento em grupo).",
    },
    toleranciaRealizacaoMin: {
      type: "integer", minimum: 0, maximum: 1440, default: 60,
      description: "Minutos antes do início a partir dos quais a realização pode ser registrada.",
    },
    antecedenciasLembreteMin: {
      type: "array", nullable: true, maxItems: 5, default: null,
      items: { type: "integer", minimum: 5, maximum: 10080 },
      description: "Antecedências dos lembretes, em minutos. `null` usa o padrão da instituição (24 h); `[]` desliga os lembretes do tipo.",
    },
  },
};

const especialidadeId = {
  type: "string", format: "uuid",
  description: "Especialidade do catálogo (`/api/especialidades`), ativa. É a chave da cobertura da escala.",
};
const horario = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", example: "08:00" };
const horarioFim = { type: "string", pattern: "^(([01]\\d|2[0-3]):[0-5]\\d|24:00)$", example: "24:00", description: "Aceita 24:00 (fim do dia)." };
const dataDia = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-11-10" };

const corpoColaborador = {
  type: "object",
  required: ["nome", "vinculo"],
  description: "Sem CPF nem documento: não há uso definido para esses dados.",
  properties: {
    nome: { type: "string", minLength: 3, maxLength: 160 },
    vinculo: { type: "string", enum: ["funcionario", "voluntario", "externo"] },
    cargo: { type: "string", minLength: 2, maxLength: 120, nullable: true },
    setor: { type: "string", minLength: 2, maxLength: 120, nullable: true },
    especialidadeId: { ...especialidadeId, nullable: true },
    registroProfissional: { type: "string", maxLength: 60, nullable: true, example: "CRM-SP 000.000" },
    email: { type: "string", format: "email", maxLength: 160, nullable: true },
    telefone: { type: "string", pattern: "^[0-9 ()+-]{8,20}$", nullable: true },
    usuarioId: { type: "string", nullable: true, description: "Usuário do sistema (opcional). Um usuário vincula a um só colaborador." },
  },
};

const janela = [
  query("janelaInicio", horario, "Hora de início a partir de (HH:MM, fuso da instituição)."),
  query("janelaFim", horario, "Hora de início antes de (HH:MM, exclusivo). Precisa ser depois de janelaInicio."),
];

const filtrosAgenda = [
  query("inicio", dataHora, "Agendamentos que terminam depois deste instante."),
  query("fim", dataHora, "Agendamentos que começam antes deste instante."),
  query("profissionalId", uuid),
  query("responsavelRealizacaoId", uuid, "Quem realizou o atendimento."),
  query("tipoId", uuid),
  query("categoria", categoria),
  query("status", statusAgendamento),
  ...janela,
];

const visaoCategoria = [
  query("visao", { type: "string", enum: ["dia", "semana", "mes"], default: "semana" }),
  query("data", { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-11-10" }, "Dia de referência no fuso da instituição. Padrão: hoje."),
  query("profissionalId", uuid, "Responsável pelo atendimento."),
  query("responsavelRealizacaoId", uuid),
  query("status", statusAgendamento),
  ...janela,
];

const visaoAgenda = [
  query("visao", { type: "string", enum: ["dia", "semana", "mes"], default: "semana" }),
  query("data", { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-11-10" }, "Dia de referência no fuso da instituição. Padrão: hoje."),
  query("status", statusAgendamento),
];

const exemploAgenda = {
  colaborador: { id: exemploColaborador.id, nome: "Renata Gouveia", vinculo: "funcionario" },
  periodo: { visao: "dia", data: "2026-11-10", inicio: "2026-11-10T03:00:00.000Z", fim: "2026-11-11T03:00:00.000Z", fuso: "America/Sao_Paulo" },
  resumo: { total: 1, agendado: 1, realizado: 0, nao_realizado: 0, cancelado: 0, emConflito: 0 },
  data: [exemploAgendamento],
};

function exemploVisaoCategoria(cat) {
  const item = { ...exemploAgendamento, tipo: { ...exemploAgendamento.tipo, categoria: cat }, observacoes: null };
  return {
    categoria: cat,
    periodo: { visao: "dia", data: "2026-11-10", inicio: "2026-11-10T03:00:00.000Z", fim: "2026-11-11T03:00:00.000Z", fuso: "America/Sao_Paulo" },
    janela: { inicio: "08:00", fim: "10:00" },
    resumo: { total: 1, agendado: 1, realizado: 0, nao_realizado: 0, cancelado: 0, emConflito: 0 },
    porProfissional: [{ id: exemploColaborador.id, nome: exemploColaborador.nome, total: 1 }],
    data: [item],
  };
}

const contatos = "`email` e `telefone` voltam `null`, com `contatosRestritos: true`, para quem não tem `equipe.visualizar`.";

const exemploEscala = {
  id: "3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7",
  colaborador: { id: exemploColaborador.id, nome: "Enf. Marcos Teles", vinculo: "funcionario" },
  especialidade: { id: "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", nome: "Enfermagem" },
  local: "Posto de enfermagem",
  data: "2026-11-10",
  horaInicio: "19:00",
  horaFim: "07:00",
  cruzaMeiaNoite: true,
  inicio: "2026-11-10T22:00:00.000Z",
  fim: "2026-11-11T10:00:00.000Z",
  situacao: "confirmada",
  observacao: null,
  motivoCancelamento: null,
  criadoEm: "2026-11-09T12:00:00.000Z",
  atualizadoEm: "2026-11-09T12:00:00.000Z",
};

const corpoEscala = {
  type: "object",
  required: ["colaboradorId", "local", "data", "horaInicio", "horaFim"],
  properties: {
    colaboradorId: uuid,
    especialidadeId: { ...especialidadeId, nullable: true, description: "Padrão: especialidade do colaborador." },
    local: { type: "string", minLength: 2, maxLength: 120 },
    data: { ...dataDia, description: "Dia de início do turno, no fuso da instituição." },
    horaInicio: horario,
    horaFim: { ...horario, description: "Menor ou igual a horaInicio = termina no dia seguinte (plantão 19:00–07:00 é um registro só). Igual a horaInicio é recusado." },
    situacao: { type: "string", enum: ["prevista", "confirmada"], default: "prevista" },
    observacao: { type: "string", maxLength: 500, nullable: true },
  },
};

const periodoDias = [
  query("inicio", dataDia, "Padrão: hoje (fuso da instituição)."),
  query("fim", dataDia, "Padrão: início + 6 dias. Máximo de 62 dias."),
];

const exemploPresenca = {
  id: "4f5a6b7c-8d9e-4f0a-b1c2-d3e4f5a6b7c8",
  colaborador: { id: exemploColaborador.id, nome: "Carla Beatriz Nunes", vinculo: "funcionario" },
  data: "2026-11-10",
  situacao: "presente",
  horaEntrada: "07:00",
  horaSaida: null,
  saidaNoDiaSeguinte: false,
  entradaEm: "2026-11-10T10:00:00.000Z",
  saidaEm: null,
  emAndamento: true,
  atividade: "Plantão diurno",
  justificativa: null,
  escalaId: exemploEscala.id,
  registradoPor: { id: "s02", nome: "Ricardo Almeida Teixeira" },
  criadoEm: "2026-11-10T10:00:00.000Z",
  atualizadoEm: "2026-11-10T10:00:00.000Z",
};

const exemploRegistro = {
  id: "9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e",
  agendamentoId: exemploAgendamento.id,
  adendoDe: null,
  acompanhamentoId: null,
  idoso: { id: "p09", nome: "José Almeida" },
  area: "medica",
  profissional: { id: exemploColaborador.id, nome: "Dr. Paulo Ferraz Neto" },
  tipo: "Consulta médica",
  realizadoEm: "2026-11-10T12:00:00.000Z",
  resumo: "Paciente estável, sem queixas. PA controlada.",
  conteudo: { pressaoArterial: "12x8", conduta: "Manter medicação", retornoDias: 90 },
  status: "finalizado",
  autor: { id: "s05", nome: "Dr. Paulo Ferraz Neto" },
  finalizadoEm: "2026-11-10T12:40:00.000Z",
  finalizadoPor: { id: "s05", nome: "Dr. Paulo Ferraz Neto" },
  publicacao: { status: "publicado", prontuarioRef: "e3f4a5b6-0000-4000-8000-000000000001" },
  criadoEm: "2026-11-10T12:30:00.000Z",
  atualizadoEm: "2026-11-10T12:40:00.000Z",
};
const conteudoClinico = {
  type: "object",
  additionalProperties: { oneOf: [{ type: "string", maxLength: 4000 }, { type: "number" }, { type: "boolean" }, { type: "array", maxItems: 50, items: { oneOf: [{ type: "string" }, { type: "number" }] } }], nullable: true },
  maxProperties: 50,
  description: "Conteúdo definido pela instituição (pendente): objeto plano, até 50 chaves `[A-Za-z][A-Za-z0-9_]*`, até 20 KB.",
};
const leituraAuditada = "A leitura é auditada (`audit_log`: usuário, data/hora, idosos acessados).";
const exemploAcompanhamento = {
  id: "0c1d2e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f",
  idoso: { id: "p03", nome: "Maria da Silva" },
  responsavel: { id: exemploColaborador.id, nome: "Dra. Luciana Prado" },
  plano: "Revisão de prótese e higiene oral a cada seis meses.",
  periodicidadeDias: 180,
  proximaAvaliacao: "2027-04-01",
  situacao: "em_acompanhamento",
  observacoes: null,
  ultimoRegistroEm: "2026-10-20T17:00:00.000Z",
  criadoEm: "2026-10-20T17:00:00.000Z",
  atualizadoEm: "2026-10-20T17:00:00.000Z",
};
const corpoAcompanhamento = {
  type: "object",
  required: ["plano"],
  properties: {
    responsavelId: { ...uuid, nullable: true },
    plano: { type: "string", minLength: 5, maxLength: 4000 },
    periodicidadeDias: { type: "integer", minimum: 7, maximum: 730, default: 180 },
    proximaAvaliacao: { ...dataDia, nullable: true },
    situacao: { type: "string", enum: ["em_tratamento", "em_acompanhamento", "concluido", "suspenso"], default: "em_acompanhamento" },
    observacoes: { type: "string", maxLength: 2000, nullable: true },
  },
};
const exemploTratamento = {
  id: "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
  idoso: { id: "p05", nome: "Ana Souza" },
  agendamentoId: null,
  area: "odontologica",
  tipo: "Extração dentária",
  localExterno: "Centro de Especialidades Odontológicas",
  data: "2026-10-10",
  profissionalNome: null,
  instituicao: "CEO Municipal",
  observacoes: "Sem intercorrências.",
  registradoPor: { id: "s01", nome: "Marta Oliveira Lima" },
  criadoEm: "2026-10-10T18:00:00.000Z",
  atualizadoEm: "2026-10-10T18:00:00.000Z",
};
const corpoTratamento = {
  type: "object",
  required: ["idosoId", "area", "tipo", "localExterno", "data"],
  properties: {
    idosoId,
    agendamentoId: { ...uuid, nullable: true, description: "Opcional; precisa ser do mesmo idoso." },
    area: { type: "string", enum: ["medica", "odontologica", "outra"] },
    tipo: { type: "string", minLength: 2, maxLength: 120 },
    localExterno: { type: "string", minLength: 2, maxLength: 160 },
    data: { ...dataDia, description: "Hoje ou passado." },
    profissionalNome: { type: "string", maxLength: 160, nullable: true },
    instituicao: { type: "string", maxLength: 160, nullable: true },
    observacoes: { type: "string", maxLength: 4000, nullable: true },
  },
};

const exemploPlano = {
  id: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
  idoso: { id: "p02", nome: "Antônio Pereira" },
  responsavel: { id: exemploColaborador.id, nome: "Renata Gouveia" },
  objetivo: "Melhorar a marcha e reduzir o risco de quedas.",
  dataInicio: "2026-10-10",
  dataFim: "2027-01-08",
  frequenciaSemanal: 2,
  observacoes: null,
  situacao: "ativo",
  vigente: true,
  criadoEm: "2026-10-10T12:00:00.000Z",
  atualizadoEm: "2026-10-10T12:00:00.000Z",
};
const exemploAtividade = {
  id: "6f7a8b9c-0d1e-4f2a-b3c4-d5e6f7a8b9c0",
  descricao: "Treino de marcha com andador",
  frequenciaSemanal: 2,
  duracaoMin: 15,
  intensidade: "Leve",
  configuracao: { apoio: "andador", series: 3 },
  observacoes: null,
  ativa: true,
  criadoEm: "2026-10-10T12:00:00.000Z",
  atualizadoEm: "2026-10-10T12:00:00.000Z",
};
const corpoPlano = {
  type: "object",
  required: ["responsavelId", "objetivo", "dataInicio", "frequenciaSemanal"],
  properties: {
    responsavelId: uuid,
    objetivo: { type: "string", minLength: 5, maxLength: 2000 },
    dataInicio: dataDia,
    dataFim: { ...dataDia, nullable: true },
    frequenciaSemanal: { type: "integer", minimum: 1, maximum: 14, description: "Sessões por semana." },
    observacoes: { type: "string", maxLength: 4000, nullable: true },
    situacao: { type: "string", enum: ["ativo", "suspenso", "concluido", "cancelado"], default: "ativo" },
  },
};
const corpoAtividade = {
  type: "object",
  required: ["descricao"],
  properties: {
    descricao: { type: "string", minLength: 3, maxLength: 500 },
    frequenciaSemanal: { type: "integer", minimum: 1, maximum: 14, nullable: true },
    duracaoMin: { type: "integer", minimum: 1, maximum: 240, nullable: true },
    intensidade: { type: "string", maxLength: 120, nullable: true },
    configuracao: { ...conteudoClinico, description: "Intensidade/configuração conforme o modelo da instituição (ainda não validado): objeto plano, até 50 chaves, até 20 KB." },
    observacoes: { type: "string", maxLength: 2000, nullable: true },
    ativa: { type: "boolean", default: true },
  },
};

const statusTarefa = { type: "string", enum: ["pendente", "em_andamento", "concluida", "cancelada"] };
const prioridadeTarefa = { type: "string", enum: ["baixa", "media", "alta", "urgente"] };
const exemploTarefa = {
  id: "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
  titulo: "Revisar escala de fisioterapia da semana",
  descricao: null,
  responsavel: { id: exemploColaborador.id, nome: "Renata Gouveia" },
  prazo: "2026-11-12T21:00:00.000Z",
  prioridade: "alta",
  status: "pendente",
  atrasada: false,
  concluidaEm: null,
  criadoPor: { id: "s02", nome: "Ricardo Almeida Teixeira" },
  criadoEm: "2026-11-09T12:00:00.000Z",
  atualizadoEm: "2026-11-09T12:00:00.000Z",
};
const historicoTarefa = [
  { id: "h1", evento: "criada", statusAnterior: null, statusNovo: "pendente", observacao: "Tarefa criada.", em: "2026-11-09T12:00:00.000Z", autor: { id: "s02", nome: "Ricardo Almeida Teixeira" } },
  { id: "h2", evento: "status", statusAnterior: "pendente", statusNovo: "em_andamento", observacao: "Comecei hoje.", em: "2026-11-10T11:00:00.000Z", autor: { id: "s06", nome: "Renata Gouveia" } },
];
const corpoTarefa = {
  type: "object",
  required: ["titulo", "responsavelId", "prazo"],
  properties: {
    titulo: { type: "string", minLength: 3, maxLength: 160 },
    descricao: { type: "string", maxLength: 4000, nullable: true },
    responsavelId: { ...uuid, description: "Colaborador ativo." },
    prazo: dataHora,
    prioridade: { ...prioridadeTarefa, default: "media" },
  },
};
const periodoIndicador = [
  query("inicio", dataDia, "Padrão: primeiro dia do mês corrente (fuso da instituição)."),
  query("fim", dataDia, "Padrão: hoje (fuso da instituição)."),
];

const periodoRelatorio = [
  query("inicio", dataDia, "Padrão: primeiro dia do mês corrente (fuso da instituição)."),
  query("fim", dataDia, "Padrão: hoje. No máximo 12 meses depois do início (422 acima disso)."),
];
const periodo12 = "Período máximo de 12 meses (ex.: de 2025-01-01 até 2025-12-31); acima disso, 422.";

const lgpd = "Em consultas, fisioterapia e avaliações, `observacoes`, `motivoStatus` e `observacaoRealizacao` voltam `null` "
  + "com `conteudoRestrito: true` para quem não tem a permissão clínica (`atendimento-clinico.visualizar` ou "
  + "`fisioterapia.visualizar`), exceto o próprio profissional do agendamento.";

export const tagsGrupo3 = [
  { name: "G3 · Tipos de atendimento", description: "US-065. Tipos e serviços da agenda única." },
  { name: "G3 · Agenda", description: "US-066 a US-073. Agendamentos, conflitos, reagendamento, cancelamento e realização." },
  { name: "G3 · Equipe", description: "US-082, US-091, US-092, US-093. Cadastro único de colaboradores, disponibilidade e presença." },
  { name: "G3 · Escalas", description: "US-083, US-084. Escala de atendimento (planejado), cobertura necessária e lacunas." },
  { name: "G3 · Especialidades", description: "Catálogo de especialidades/áreas usado por colaborador, escala e cobertura." },
  { name: "G3 · Fisioterapia", description: "US-075 a US-080. Planos, atividades, execução por sessão, evolução, rotina semanal e indicadores. Sessão = agendamento de categoria fisioterapia com `planoFisioterapiaId`. Leitura auditada." },
  { name: "G3 · Tarefas", description: "US-094 a US-096. Tarefas da equipe, status com histórico imutável e atrasadas (derivado)." },
  { name: "G3 · Indicadores", description: "Leitura agregada para o dashboard do Grupo 5 (US-119, US-123, US-100, US-128). Só números." },
  { name: "G3 · Relatórios", description: "US-081 e US-090 (P2). Endpoints JSON com filtros e paginação; a exportação (PDF/planilha) fica com o Grupo 5. Período máximo de 12 meses." },
  { name: "G3 · Atendimento clínico", description: "US-085 a US-089. Registro clínico de consulta (rascunho → finalizado, correção por adendo), acompanhamento odontológico, tratamento externo e pendências do ciclo. Toda leitura é auditada." },
];

export const pathsGrupo3 = {
  "/api/tipos-atendimento": {
    get: op("G3 · Tipos de atendimento", "Listar tipos de atendimento", "agenda.visualizar", {
      query: [...pagina, query("categoria", categoria), query("ativo", { type: "boolean" })],
      example: lista(exemploTipo),
    }),
    post: op("G3 · Tipos de atendimento", "Criar tipo de atendimento", "agenda.administrar", {
      status: 201,
      body: corpoTipo,
      bodyExample: { nome: "Fisioterapia em grupo", categoria: "fisioterapia", duracaoPadraoMin: 60, permiteSobreposicao: true, exigeMotivoReagendamento: false },
      example: exemploTipo,
      conflictExample: erro("Já existe um tipo de atendimento com esse nome."),
    }),
  },
  "/api/tipos-atendimento/{id}": {
    get: op("G3 · Tipos de atendimento", "Detalhe do tipo", "agenda.visualizar", { params: [path("id")], errors: [404], example: exemploTipo }),
    put: op("G3 · Tipos de atendimento", "Editar tipo", "agenda.administrar", {
      params: [path("id")], body: corpoTipo, errors: [404], example: exemploTipo,
      conflictExample: erro("Já existe um tipo de atendimento com esse nome."),
    }),
  },
  "/api/tipos-atendimento/{id}/status": {
    patch: op("G3 · Tipos de atendimento", "Ativar ou inativar tipo", "agenda.administrar", {
      params: [path("id")],
      body: { type: "object", required: ["ativo"], properties: { ativo: { type: "boolean" } } },
      bodyExample: { ativo: false },
      errors: [404],
      example: { ...exemploTipo, ativo: false },
      description: "Tipo inativo não aceita novos agendamentos; os existentes são preservados.",
    }),
  },

  "/api/colaboradores": {
    get: op("G3 · Equipe", "Listar colaboradores", "equipe.visualizar, agenda.criar ou agenda.editar", {
      query: [
        ...pagina,
        query("vinculo", { type: "string", enum: ["funcionario", "voluntario", "externo"] }),
        query("status", { type: "string", enum: ["ativo", "inativo"] }),
        query("setor", { type: "string", maxLength: 120 }),
        query("especialidadeId", especialidadeId),
        query("q", { type: "string", maxLength: 80 }),
      ],
      example: lista(exemploColaborador),
      description: contatos,
    }),
    post: op("G3 · Equipe", "Cadastrar colaborador", "equipe.criar", {
      status: 201, body: corpoColaborador,
      bodyExample: {
        nome: "Renata Gouveia", vinculo: "funcionario", cargo: "Fisioterapeuta", setor: "Fisioterapia", especialidadeId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
        registroProfissional: "CREFITO-3 000.321", email: "renata.gouveia@lardoirmaovelho.example", telefone: "(11) 90000-0006", usuarioId: "s06",
      },
      example: exemploColaborador,
      conflictExample: erro("Este usuário já está vinculado a outro colaborador."),
    }),
  },
  "/api/colaboradores/{id}": {
    get: op("G3 · Equipe", "Detalhe do colaborador", "equipe.visualizar, agenda.criar ou agenda.editar", { params: [path("id")], errors: [404], example: exemploColaborador, description: contatos }),
    put: op("G3 · Equipe", "Editar colaborador", "equipe.editar", {
      params: [path("id")], body: corpoColaborador, errors: [404], example: exemploColaborador,
      conflictExample: erro("Este usuário já está vinculado a outro colaborador."),
    }),
  },
  "/api/colaboradores/{id}/status": {
    patch: op("G3 · Equipe", "Ativar ou inativar colaborador", "equipe.excluir", {
      params: [path("id")],
      body: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["ativo", "inativo"] } } },
      bodyExample: { status: "inativo" },
      errors: [404],
      example: { ...exemploColaborador, status: "inativo" },
      description: "Não há exclusão física. Colaborador inativo não recebe novos agendamentos.",
    }),
  },
  "/api/especialidades": {
    get: op("G3 · Especialidades", "Listar especialidades", "equipe.visualizar, equipe.administrar, agenda.visualizar, agenda.criar ou atendimento-clinico.visualizar", {
      query: [...pagina, query("ativo", { type: "boolean" })],
      example: lista({ id: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", nome: "Clínica médica", ativo: true, criadoEm: "2026-11-09T12:00:00.000Z", atualizadoEm: "2026-11-09T12:00:00.000Z" }),
    }),
    post: op("G3 · Especialidades", "Cadastrar especialidade", "equipe.administrar", {
      status: 201,
      body: { type: "object", required: ["nome"], properties: { nome: { type: "string", minLength: 2, maxLength: 80 } } },
      bodyExample: { nome: "Geriatria" },
      example: { id: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", nome: "Geriatria", ativo: true, criadoEm: "2026-11-09T12:00:00.000Z", atualizadoEm: "2026-11-09T12:00:00.000Z" },
      conflictExample: erro("Já existe uma especialidade com esse nome."),
      description: "Nome único, sem diferenciar maiúsculas e espaços nas pontas.",
    }),
  },
  "/api/especialidades/{id}": {
    get: op("G3 · Especialidades", "Detalhe da especialidade", "mesmas da listagem", { params: [path("id")], errors: [404] }),
    put: op("G3 · Especialidades", "Renomear especialidade", "equipe.administrar", {
      params: [path("id")],
      body: { type: "object", required: ["nome"], properties: { nome: { type: "string", minLength: 2, maxLength: 80 } } },
      errors: [404], conflictExample: erro("Já existe uma especialidade com esse nome."),
    }),
  },
  "/api/especialidades/{id}/status": {
    patch: op("G3 · Especialidades", "Ativar ou inativar especialidade", "equipe.administrar", {
      params: [path("id")],
      body: { type: "object", required: ["ativo"], properties: { ativo: { type: "boolean" } } },
      bodyExample: { ativo: false },
      errors: [404],
      description: "Sem exclusão física. Especialidade inativa não pode ser atribuída a colaborador, escala ou cobertura (422); as referências existentes ficam.",
    }),
  },
  "/api/colaboradores/{id}/disponibilidades": {
    get: op("G3 · Equipe", "Disponibilidade semanal do colaborador", "equipe.visualizar, agenda.criar ou agenda.editar", {
      params: [path("id")], errors: [404],
      example: { colaborador: { id: exemploColaborador.id, nome: "Dra. Luciana Prado" }, data: [{ id: "d1", diaSemana: 2, horaInicio: "13:00", horaFim: "17:00", observacao: null }] },
      description: "`diaSemana` ISO: 1 = segunda ... 7 = domingo.",
    }),
    put: op("G3 · Equipe", "Substituir a disponibilidade", "equipe.editar", {
      params: [path("id")],
      body: {
        type: "object", required: ["disponibilidades"],
        properties: {
          disponibilidades: {
            type: "array", maxItems: 28,
            items: {
              type: "object", required: ["diaSemana", "horaInicio", "horaFim"],
              properties: {
                diaSemana: { type: "integer", minimum: 1, maximum: 7 }, horaInicio: horario, horaFim: horarioFim,
                observacao: { type: "string", maxLength: 300, nullable: true },
              },
            },
          },
        },
      },
      bodyExample: { disponibilidades: [{ diaSemana: 2, horaInicio: "13:00", horaFim: "17:00" }, { diaSemana: 4, horaInicio: "13:00", horaFim: "17:00" }] },
      errors: [404],
      example: { data: [{ id: "d1", diaSemana: 2, horaInicio: "13:00", horaFim: "17:00", observacao: null }] },
      description: "Substitui a lista inteira (vazia = sem disponibilidade declarada). 422 para horários sobrepostos no mesmo dia. Disponibilidade noturna: dois dias (ex.: qua 19:00–24:00 e qui 00:00–07:00).",
    }),
  },
  "/api/escalas": {
    get: op("G3 · Escalas", "Listar escalas", "equipe.visualizar, agenda.visualizar ou atendimento-clinico.visualizar", {
      query: [
        ...pagina, ...periodoDias, query("colaboradorId", uuid), query("especialidadeId", especialidadeId),
        query("situacao", { type: "string", enum: ["prevista", "confirmada", "cancelada"] }), query("local", { type: "string", maxLength: 120 }),
      ],
      example: { periodo: { inicio: "2026-11-10", fim: "2026-11-16" }, ...lista(exemploEscala) },
    }),
    post: op("G3 · Escalas", "Cadastrar escala (turno planejado)", "equipe.criar", {
      status: 201, body: corpoEscala,
      bodyExample: { colaboradorId: exemploColaborador.id, local: "Posto de enfermagem", data: "2026-11-10", horaInicio: "19:00", horaFim: "07:00", situacao: "confirmada" },
      example: { ...exemploEscala, avisos: [{ codigo: "fora_da_disponibilidade", mensagem: "Turno fora da disponibilidade declarada pelo colaborador." }] },
      conflictExample: erro("O colaborador já está escalado nesse horário.", { conflitos: [{ escalaId: exemploEscala.id, local: "Posto de enfermagem", inicio: exemploEscala.inicio, fim: exemploEscala.fim }] }),
      description: "Guarda início e fim em timestamptz. Colaborador precisa estar ativo. Turno sobreposto do mesmo colaborador (não cancelado), inclusive atravessando a meia-noite, é 409, garantido também por restrição de exclusão no banco. `avisos` indica turno fora da disponibilidade declarada (conferida trecho a trecho no fuso da instituição), sem impedir o cadastro.",
    }),
  },
  "/api/escalas/{id}": {
    get: op("G3 · Escalas", "Detalhe da escala", "equipe.visualizar, agenda.visualizar ou atendimento-clinico.visualizar", { params: [path("id")], errors: [404], example: exemploEscala }),
    put: op("G3 · Escalas", "Editar escala", "equipe.editar", {
      params: [path("id")], body: corpoEscala, errors: [404], example: { ...exemploEscala, avisos: [] },
      conflictExample: erro("Escala cancelada não pode ser alterada."),
    }),
  },
  "/api/escalas/{id}/situacao": {
    patch: op("G3 · Escalas", "Alterar situação da escala", "equipe.editar", {
      params: [path("id")],
      body: {
        type: "object", required: ["situacao"],
        properties: { situacao: { type: "string", enum: ["prevista", "confirmada", "cancelada"] }, motivo: { type: "string", minLength: 3, maxLength: 500, nullable: true } },
      },
      bodyExample: { situacao: "cancelada", motivo: "Viagem do profissional" },
      errors: [404, 409],
      example: { ...exemploEscala, situacao: "cancelada", motivoCancelamento: "Viagem do profissional" },
      description: "Sem exclusão física: cancelar libera o horário. Escala cancelada não volta a ser alterada (409).",
    }),
  },
  "/api/escalas/cobertura-necessaria": {
    get: op("G3 · Escalas", "Cobertura mínima configurada", "equipe.visualizar, agenda.visualizar ou atendimento-clinico.visualizar", {
      example: { data: [{ id: "c1", especialidade: { id: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", nome: "Clínica médica" }, diaSemana: 1, horaInicio: "08:00", horaFim: "12:00", quantidadeMinima: 1 }] },
    }),
    put: op("G3 · Escalas", "Substituir a cobertura mínima", "equipe.administrar", {
      body: {
        type: "object", required: ["coberturas"],
        properties: {
          coberturas: {
            type: "array", maxItems: 200,
            items: {
              type: "object", required: ["especialidadeId", "diaSemana", "horaInicio", "horaFim", "quantidadeMinima"],
              properties: {
                especialidadeId, diaSemana: { type: "integer", minimum: 1, maximum: 7 }, horaInicio: horario, horaFim: horarioFim,
                quantidadeMinima: { type: "integer", minimum: 1, maximum: 50 },
              },
            },
          },
        },
      },
      bodyExample: { coberturas: [
        { especialidadeId: "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", diaSemana: 3, horaInicio: "19:00", horaFim: "24:00", quantidadeMinima: 1 },
        { especialidadeId: "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", diaSemana: 4, horaInicio: "00:00", horaFim: "07:00", quantidadeMinima: 1 },
      ] },
      example: { data: [{ id: "c1", especialidade: { id: "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", nome: "Enfermagem" }, diaSemana: 3, horaInicio: "19:00", horaFim: "24:00", quantidadeMinima: 1 }] },
      description: "Substitui toda a configuração; a versão anterior fica na auditoria. 422 para faixas sobrepostas da mesma especialidade no mesmo dia e para especialidade inexistente ou inativa. Necessidade noturna: duas faixas (dia 19:00–24:00 e dia seguinte 00:00–07:00).",
    }),
  },
  "/api/escalas/lacunas": {
    get: op("G3 · Escalas", "Lacunas na escala", "equipe.visualizar, agenda.visualizar ou atendimento-clinico.visualizar", {
      query: [...periodoDias, query("especialidadeId", especialidadeId)],
      example: {
        periodo: { inicio: "2026-11-10", fim: "2026-11-16" },
        coberturasConsideradas: 7,
        resumo: { lacunas: 1, profissionaisFaltando: 1 },
        data: [{ data: "2026-11-11", diaSemana: 3, especialidade: { id: "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", nome: "Enfermagem" }, inicio: "05:00", fim: "07:00", necessario: 1, escalados: 0, faltam: 1 }],
      },
      description: "Para cada dia do período e cada cobertura configurada, os trechos com menos escalados que o mínimo. Contam escalas `prevista` e `confirmada` de colaboradores ativos, da mesma especialidade; turnos que atravessam a meia-noite contam nos dois dias.",
    }),
  },
  "/api/presencas": {
    get: op("G3 · Equipe", "Quem está trabalhando (presenças)", "equipe.visualizar", {
      query: [
        ...pagina, query("data", dataDia), query("inicio", dataDia), query("fim", dataDia), query("colaboradorId", uuid),
        query("vinculo", { type: "string", enum: ["funcionario", "voluntario", "externo"] }),
        query("situacao", { type: "string", enum: ["presente", "ausente"] }),
        query("emAndamento", { type: "boolean" }, "true = presente sem saída registrada."),
      ],
      example: lista(exemploPresenca),
    }),
    post: op("G3 · Equipe", "Registrar presença ou ausência", "equipe.criar", {
      status: 201,
      body: {
        type: "object", required: ["colaboradorId", "data"],
        properties: {
          colaboradorId: uuid, data: { ...dataDia, description: "Hoje ou passado." },
          situacao: { type: "string", enum: ["presente", "ausente"], default: "presente" },
          horaEntrada: { ...horario, nullable: true, description: "Obrigatória para presente; proibida para ausente." },
          horaSaida: { ...horario, nullable: true },
          atividade: { type: "string", maxLength: 300, nullable: true },
          justificativa: { type: "string", maxLength: 500, nullable: true },
          escalaId: { ...uuid, nullable: true, description: "Turno previsto (mesmo colaborador e data). Uma presença por escala." },
        },
      },
      bodyExample: { colaboradorId: exemploColaborador.id, data: "2026-11-10", horaEntrada: "07:00", atividade: "Plantão diurno", escalaId: exemploEscala.id },
      example: exemploPresenca,
      conflictExample: erro("O colaborador já tem presença em aberto nesta data. Registre a saída antes."),
      description: "Registro operacional do que aconteceu; **não substitui o controle de ponto**. Fica separado da escala (o planejado). horaSaida menor que horaEntrada = saída no dia seguinte. 409 se a escala já tem presença ou se o colaborador tem presença em aberto.",
    }),
  },
  "/api/presencas/{id}/saida": {
    patch: op("G3 · Equipe", "Registrar saída", "equipe.criar ou equipe.editar", {
      params: [path("id")],
      body: { type: "object", required: ["horaSaida"], properties: { horaSaida: horario } },
      bodyExample: { horaSaida: "19:00" },
      errors: [404, 409],
      example: { ...exemploPresenca, horaSaida: "19:00", emAndamento: false },
    }),
  },
  "/api/colaboradores/{id}/agenda": {
    get: op("G3 · Agenda", "Agenda do profissional (dia, semana ou mês)", "agenda.visualizar", {
      params: [path("id")], query: visaoAgenda, errors: [404], example: exemploAgenda,
      description: `A semana vai de segunda a domingo, no fuso da instituição. ${lgpd}`,
    }),
  },
  "/api/me/agenda": {
    get: op("G3 · Agenda", "Minha agenda", null, {
      query: visaoAgenda, errors: [404], example: exemploAgenda,
      description: "Agenda do colaborador vinculado ao usuário logado. É a única visão de agenda do voluntário. 404 se o usuário não tiver colaborador vinculado.",
    }),
  },

  "/api/agendamentos": {
    get: op("G3 · Agenda", "Listar agendamentos (calendário)", "agenda.visualizar", {
      query: [...pagina, ...filtrosAgenda, query("idosoId", idosoId)],
      example: lista(exemploAgendamento),
      description: `Agenda única: consultas, fisioterapia, cuidados pessoais, farmácia e avaliações. \`emConflito\` indica sobreposição com outro agendamento ativo do mesmo profissional. ${lgpd}`,
    }),
    post: op("G3 · Agenda", "Agendar atendimento", "agenda.criar", {
      status: 201,
      body: {
        type: "object",
        required: ["idosoId", "tipoId", "profissionalId", "inicio"],
        properties: {
          idosoId,
          tipoId: uuid,
          profissionalId: uuid,
          inicio: dataHora,
          duracaoMin: { type: "integer", minimum: 5, maximum: 720, description: "Padrão: duração do tipo." },
          local: { type: "string", maxLength: 120, nullable: true },
          observacoes: { type: "string", maxLength: 2000, nullable: true },
          planoFisioterapiaId: { ...uuid, nullable: true, description: "Só em sessão de fisioterapia; plano ativo do mesmo idoso. Fora do período do plano: aviso `fora_do_periodo_do_plano`." },
        },
      },
      bodyExample: { idosoId: "p02", tipoId: exemploTipo.id, profissionalId: exemploColaborador.id, inicio: "2026-11-10T14:00:00-03:00", local: "Sala de fisioterapia", observacoes: "Treino de marcha com andador." },
      example: { ...exemploAgendamento, avisos: [{ codigo: "fora_da_escala", mensagem: "O profissional não está na escala nesse horário." }] },
      conflictExample: exemploConflito,
      description: "Valida idoso, tipo ativo e profissional ativo. Recusa com 409 e a lista de conflitos se o profissional já tiver agendamento ativo sobreposto (exceto mesmo tipo com sobreposição permitida). US-085: consulta médica ou odontológica exige `local` (422) e, fora da escala do profissional, é aceita com aviso `fora_da_escala` em `avisos`.",
    }),
  },
  "/api/agendamentos/verificar-conflitos": {
    post: op("G3 · Agenda", "Verificar conflitos antes de confirmar", "agenda.criar ou agenda.editar", {
      body: {
        type: "object",
        required: ["profissionalId", "tipoId", "inicio"],
        properties: {
          profissionalId: uuid, tipoId: uuid, inicio: dataHora,
          duracaoMin: { type: "integer", minimum: 5, maximum: 720 },
          ignorarAgendamentoId: { ...uuid, description: "Use no reagendamento para não conflitar consigo mesmo." },
        },
      },
      bodyExample: { profissionalId: exemploColaborador.id, tipoId: exemploTipo.id, inicio: "2026-11-10T14:20:00-03:00" },
      example: { temConflito: true, inicio: "2026-11-10T17:20:00.000Z", fim: "2026-11-10T18:00:00.000Z", conflitos: exemploConflito.error.details.conflitos, avisos: [] },
    }),
  },
  "/api/agendamentos/{id}": {
    get: op("G3 · Agenda", "Detalhe do agendamento", "agenda.visualizar (ou ser o profissional do agendamento)", {
      params: [path("id")], errors: [404], example: exemploAgendamento, description: lgpd,
    }),
  },
  "/api/agendamentos/{id}/reagendar": {
    post: op("G3 · Agenda", "Reagendar", "agenda.editar", {
      params: [path("id")],
      body: {
        type: "object",
        required: ["inicio"],
        properties: {
          inicio: dataHora,
          duracaoMin: { type: "integer", minimum: 5, maximum: 720 },
          profissionalId: uuid,
          motivo: { type: "string", minLength: 3, maxLength: 1000, description: "Obrigatório quando o tipo exige motivo para reagendar." },
        },
      },
      bodyExample: { inicio: "2026-11-11T09:00:00-03:00", motivo: "Atraso do transporte" },
      errors: [404],
      example: { ...exemploAgendamento, inicio: "2026-11-11T12:00:00.000Z", fim: "2026-11-11T12:40:00.000Z", avisos: [] },
      conflictExample: exemploConflito,
      description: "Mantém o mesmo registro e grava anterior → novo no histórico. Revalida conflito ignorando o próprio agendamento. 409 também quando o agendamento já foi encerrado.",
    }),
  },
  "/api/agendamentos/{id}/cancelar": {
    post: op("G3 · Agenda", "Cancelar", "agenda.editar", {
      params: [path("id")],
      body: { type: "object", properties: { motivo: { type: "string", minLength: 3, maxLength: 1000 } } },
      bodyExample: { motivo: "Idoso hospitalizado" },
      errors: [404, 409],
      example: { ...exemploAgendamento, status: "cancelado", motivoStatus: "Idoso hospitalizado", concluidoEm: "2026-11-09T15:00:00.000Z" },
      description: "Sem exclusão física. Motivo obrigatório quando o tipo exige. Cancelado libera o horário.",
    }),
  },
  "/api/agendamentos/{id}/realizacao": {
    post: op("G3 · Agenda", "Registrar realização", "agenda.editar", {
      params: [path("id")],
      body: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["realizado", "nao_realizado"] },
          responsavelId: { ...uuid, description: "Padrão: o profissional do agendamento. Quem registrou fica em `registradoPor`." },
          observacao: { type: "string", maxLength: 2000, nullable: true },
        },
      },
      bodyExample: { status: "realizado", observacao: "Caminhada de 15 minutos sem dor." },
      errors: [404, 409],
      example: {
        ...exemploAgendamento, status: "realizado", responsavelRealizacao: { id: exemploColaborador.id, nome: "Renata Gouveia" },
        observacaoRealizacao: "Caminhada de 15 minutos sem dor.", registradoPor: { id: "s03", nome: "Carla Beatriz Nunes" },
        concluidoEm: "2026-11-10T17:45:00.000Z",
      },
      description: "Aceita a partir de `toleranciaRealizacaoMin` minutos antes do início (padrão 60; 422 antes disso) e uma única vez (409 se já encerrado). Para corrigir, use `corrigir-realizacao`.",
    }),
  },
  "/api/agendamentos/{id}/corrigir-realizacao": {
    post: op("G3 · Agenda", "Corrigir realização registrada", "agenda.administrar", {
      params: [path("id")],
      body: {
        type: "object",
        required: ["motivo"],
        properties: {
          motivo: { type: "string", minLength: 3, maxLength: 1000 },
          status: { type: "string", enum: ["realizado", "nao_realizado"] },
          responsavelId: uuid,
          observacao: { type: "string", maxLength: 2000, nullable: true },
        },
      },
      bodyExample: { status: "nao_realizado", observacao: "Idoso dormia", motivo: "Lançado como realizado por engano" },
      errors: [404, 409],
      example: { ...exemploAgendamento, status: "nao_realizado", observacaoRealizacao: "Idoso dormia", registradoPor: { id: "s03", nome: "Carla Beatriz Nunes" }, concluidoEm: "2026-11-10T17:45:00.000Z" },
      description: "Só para agendamento realizado ou não realizado (409 caso contrário). Troca status, responsável e observação da realização; grava `corrigido` no histórico com anterior → novo e motivo. Qualquer outra alteração de agendamento encerrado continua bloqueada pelo banco. 422 sem motivo ou sem mudança real.",
    }),
  },
  "/api/agendamentos/{id}/historico": {
    get: op("G3 · Agenda", "Histórico de alterações do agendamento", "agenda.visualizar (ou ser o profissional do agendamento)", {
      params: [path("id")], errors: [404],
      example: {
        data: [
          { id: "c1", acao: "criado", anterior: null, novo: { status: "agendado" }, motivo: null, em: "2026-11-09T12:00:00.000Z", autor: { id: "s09", nome: "Aline Barros" } },
          { id: "c2", acao: "reagendado", anterior: { inicio: "2026-11-10T17:00:00.000Z", duracaoMin: 40, profissionalId: exemploColaborador.id }, novo: { inicio: "2026-11-11T12:00:00.000Z", duracaoMin: 40, profissionalId: exemploColaborador.id }, motivo: "Atraso do transporte", em: "2026-11-09T13:00:00.000Z", autor: { id: "s09", nome: "Aline Barros" } },
        ],
      },
      description: "Histórico imutável (gatilho no banco).",
    }),
  },
  "/api/agendamentos/{id}/lembretes": {
    get: op("G3 · Agenda", "Status dos lembretes do agendamento", "agenda.visualizar (ou ser o profissional do agendamento)", {
      params: [path("id")],
      errors: [404],
      example: {
        data: [
          {
            id: "7c0e2f4a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
            destinatario: { colaboradorId: exemploColaborador.id, nome: "Renata Gouveia", usuarioId: "s06" },
            antecedenciaMin: 1440, enviarEm: "2026-11-09T17:00:00.000Z", canal: "interno", status: "entregue",
            tentativas: 1, ultimoErro: null, enviadoEm: "2026-11-09T17:00:05.000Z", entregueEm: "2026-11-09T17:00:05.000Z",
            criadoEm: "2026-11-08T12:00:00.000Z",
          },
          {
            id: "8d1f3a5b-2c3d-4e5f-9a01-b2c3d4e5f6a7",
            destinatario: { colaboradorId: "5d2c8f0e-0000-4b8e-9b61-7c3f3e2a1b01", nome: "Jorge Matias (cabeleireiro)", usuarioId: null },
            antecedenciaMin: 1440, enviarEm: "2026-11-09T13:00:00.000Z", canal: "interno", status: "sem_destinatario",
            tentativas: 0, ultimoErro: "Colaborador sem usuário do sistema vinculado.", enviadoEm: null, entregueEm: null,
            criadoEm: "2026-11-08T12:00:00.000Z",
          },
        ],
      },
      description: "Um lembrete por antecedência configurada, para o profissional do agendamento. Status: `pendente`, `enviado`, `entregue`, `falha` (tentativas esgotadas), `sem_destinatario` (colaborador sem usuário ou usuário inativo) e `cancelado` (agendamento cancelado, realizado ou reagendado). O envio é feito pelo job (`JOBS_ENABLED=true`).",
    }),
  },
  "/api/agendas/farmacia": {
    get: op("G3 · Agenda", "Agenda da farmácia", "agenda.visualizar", {
      query: visaoCategoria,
      example: exemploVisaoCategoria("farmacia"),
      description: "US-070. Agendamentos da categoria `farmacia` no período, filtrados por responsável (`profissionalId`, `responsavelRealizacaoId`) e janela de atendimento (`janelaInicio`/`janelaFim`, HH:MM no fuso da instituição, intervalo [início, fim) da hora de início).",
    }),
  },
  "/api/agendas/cuidados-pessoais": {
    get: op("G3 · Agenda", "Agenda de cuidados pessoais", "agenda.visualizar", {
      query: visaoCategoria,
      example: exemploVisaoCategoria("cuidado_pessoal"),
      description: "US-071. Cabelo, barba, unhas e outros serviços da categoria `cuidado_pessoal`, com os mesmos filtros da agenda da farmácia.",
    }),
  },
  "/api/idosos/{idosoId}/cuidados-pessoais": {
    get: op("G3 · Agenda", "Cuidados pessoais do idoso por serviço", "agenda.visualizar", {
      params: [path("idosoId", idosoId)],
      errors: [404],
      example: {
        idoso: { id: "p04", nome: "Maria das Dores" },
        data: [{
          tipo: { id: exemploTipo.id, nome: "Corte de cabelo" },
          totalRealizados: 3,
          ultimaRealizacao: { agendamentoId: exemploAgendamento.id, inicio: "2026-10-05T13:00:00.000Z", responsavel: { id: exemploColaborador.id, nome: "Jorge Matias (cabeleireiro)" } },
          proximoAgendamento: { agendamentoId: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091", inicio: "2026-11-10T13:00:00.000Z", profissional: { id: exemploColaborador.id, nome: "Jorge Matias (cabeleireiro)" } },
        }],
      },
      description: "US-071. Para cada serviço de cuidado pessoal já agendado para o idoso: total realizado, última realização (com responsável) e próximo agendamento.",
    }),
  },
  "/api/agendamentos/{id}/registro-clinico": {
    post: op("G3 · Atendimento clínico", "Registrar consulta (rascunho ou finalizado)", "atendimento-clinico.criar", {
      status: 201,
      params: [path("id")],
      body: {
        type: "object", required: ["resumo"],
        properties: {
          tipo: { type: "string", minLength: 2, maxLength: 80, nullable: true, description: "Padrão: nome do tipo de atendimento." },
          resumo: { type: "string", minLength: 10, maxLength: 8000, description: "Resumo/resultado da consulta." },
          conteudo: conteudoClinico,
          realizadoEm: { ...dataHora, description: "Padrão: início do agendamento." },
          acompanhamentoId: { ...uuid, nullable: true, description: "Só consulta odontológica; acompanhamento do mesmo idoso." },
          finalizar: { type: "boolean", default: false, description: "Cria já finalizado (exige consulta realizada)." },
        },
      },
      bodyExample: { resumo: "Paciente estável, sem queixas.", conteudo: { pressaoArterial: "13x8", conduta: "Manter medicação" } },
      errors: [404],
      example: { ...exemploRegistro, status: "rascunho", finalizadoEm: null, finalizadoPor: null, publicacao: null, adendos: [] },
      conflictExample: erro("Esta consulta já tem registro clínico. Edite o rascunho ou registre um adendo."),
      description: "Só para consulta médica ou odontológica (422 nos outros tipos). Um registro principal por consulta (409). Consulta cancelada ou não realizada não recebe registro (409). Ao finalizar, o registro é publicado no prontuário do idoso como evolução finalizada (adaptador real da US-023).",
    }),
    get: op("G3 · Atendimento clínico", "Registro clínico da consulta (com adendos)", "atendimento-clinico.visualizar", {
      params: [path("id")], errors: [404], example: { ...exemploRegistro, adendos: [] }, description: leituraAuditada,
    }),
  },
  "/api/registros-clinicos/{id}": {
    get: op("G3 · Atendimento clínico", "Detalhe do registro clínico (com adendos)", "atendimento-clinico.visualizar", {
      params: [path("id")], errors: [404], example: { ...exemploRegistro, adendos: [] }, description: leituraAuditada,
    }),
    put: op("G3 · Atendimento clínico", "Editar rascunho", "atendimento-clinico.editar (autor ou atendimento-clinico.administrar)", {
      params: [path("id")],
      body: {
        type: "object", required: ["resumo"],
        properties: {
          tipo: { type: "string", minLength: 2, maxLength: 80, nullable: true },
          resumo: { type: "string", minLength: 10, maxLength: 8000 },
          conteudo: conteudoClinico,
          realizadoEm: dataHora,
          acompanhamentoId: { ...uuid, nullable: true },
        },
      },
      errors: [404],
      example: { ...exemploRegistro, status: "rascunho", finalizadoEm: null, finalizadoPor: null, publicacao: null, adendos: [] },
      conflictExample: erro("Registro finalizado não é editado; registre um adendo."),
      description: "Só rascunho; finalizado é imutável (também no banco).",
    }),
  },
  "/api/registros-clinicos/{id}/finalizar": {
    post: op("G3 · Atendimento clínico", "Finalizar e publicar no prontuário", "atendimento-clinico.editar (autor ou atendimento-clinico.administrar)", {
      params: [path("id")], errors: [404, 409], example: { ...exemploRegistro, adendos: [] },
      description: "Exige a consulta realizada (409). Se quem finaliza tem `evolucao.create`, publica uma evolução finalizada no prontuário do idoso e guarda a referência em `publicacao`; senão `publicacao.status = \"aguardando_permissao\"`.",
    }),
  },
  "/api/registros-clinicos/republicar-pendentes": {
    post: op("G3 · Atendimento clínico", "Republicar no prontuário os registros pendentes", "atendimento-clinico.administrar", {
      example: { verificados: 3, publicados: 2, aguardandoPermissao: 1 },
      description: "Tenta publicar os registros finalizados com `publicacao.status` `aguardando_permissao`, `pendente_integracao` ou `falha`, em nome de quem finalizou, se essa pessoa agora tem `evolucao.create`. Idempotente.",
    }),
  },
  "/api/registros-clinicos/{id}/adendos": {
    post: op("G3 · Atendimento clínico", "Corrigir por adendo", "atendimento-clinico.criar", {
      status: 201,
      params: [path("id")],
      body: { type: "object", required: ["resumo"], properties: { resumo: { type: "string", minLength: 10, maxLength: 8000 }, conteudo: conteudoClinico } },
      bodyExample: { resumo: "Adendo: paciente relatou tontura leve ao levantar." },
      errors: [404, 409],
      example: {
        ...exemploRegistro,
        adendos: [{ ...exemploRegistro, id: "2e3f4a5b-6c7d-4e8f-9a0b-c1d2e3f4a5b6", adendoDe: exemploRegistro.id, resumo: "Adendo: paciente relatou tontura leve ao levantar.", conteudo: {}, realizadoEm: "2026-11-11T13:00:00.000Z" }],
      },
      description: "Correção de registro finalizado (D-004): cria um registro novo, finalizado, vinculado ao original (`adendoDe`), com autor e data, e publicado no prontuário. Adendo de adendo vai para o registro original. Rascunho não recebe adendo (409). Devolve o registro original com todos os adendos.",
    }),
  },
  "/api/idosos/{idosoId}/registros-clinicos": {
    get: op("G3 · Atendimento clínico", "Registros clínicos do idoso", "atendimento-clinico.visualizar", {
      params: [path("idosoId", idosoId)],
      query: [...pagina, query("area", { type: "string", enum: ["medica", "odontologica"] }), query("status", { type: "string", enum: ["rascunho", "finalizado"] }), query("inicio", dataHora), query("fim", dataHora)],
      errors: [404],
      example: { idoso: { id: "p09", nome: "José Almeida" }, ...lista(exemploRegistro) },
      description: `Só registros principais (os adendos vêm no detalhe). ${leituraAuditada}`,
    }),
  },
  "/api/odontologia/acompanhamentos": {
    get: op("G3 · Atendimento clínico", "Listar acompanhamentos odontológicos", "atendimento-clinico.visualizar", {
      query: [...pagina, query("idosoId", idosoId), query("situacao", { type: "string", enum: ["em_tratamento", "em_acompanhamento", "concluido", "suspenso"] })],
      example: lista(exemploAcompanhamento), description: leituraAuditada,
    }),
    post: op("G3 · Atendimento clínico", "Cadastrar acompanhamento odontológico", "atendimento-clinico.criar", {
      status: 201,
      body: { ...corpoAcompanhamento, required: ["idosoId", "plano"], properties: { idosoId, ...corpoAcompanhamento.properties } },
      bodyExample: { idosoId: "p03", plano: "Revisão de prótese e higiene oral a cada seis meses.", periodicidadeDias: 180, proximaAvaliacao: "2027-04-01" },
      example: exemploAcompanhamento,
      conflictExample: erro("O idoso já tem acompanhamento odontológico ativo."),
      description: "Um acompanhamento ativo (`em_tratamento` ou `em_acompanhamento`) por idoso (409).",
    }),
  },
  "/api/odontologia/acompanhamentos/{id}": {
    get: op("G3 · Atendimento clínico", "Detalhe do acompanhamento", "atendimento-clinico.visualizar", { params: [path("id")], errors: [404], example: exemploAcompanhamento, description: leituraAuditada }),
    put: op("G3 · Atendimento clínico", "Atualizar plano e situação", "atendimento-clinico.editar", {
      params: [path("id")], body: corpoAcompanhamento, errors: [404], example: { ...exemploAcompanhamento, situacao: "concluido" },
      conflictExample: erro("O idoso já tem acompanhamento odontológico ativo."),
    }),
  },
  "/api/tratamentos-externos": {
    get: op("G3 · Atendimento clínico", "Listar tratamentos externos", "atendimento-clinico.visualizar", {
      query: [...pagina, query("idosoId", idosoId), query("area", { type: "string", enum: ["medica", "odontologica", "outra"] }), query("inicio", dataDia), query("fim", dataDia)],
      example: lista(exemploTratamento), description: leituraAuditada,
    }),
    post: op("G3 · Atendimento clínico", "Registrar tratamento externo", "atendimento-clinico.criar", {
      status: 201, body: corpoTratamento,
      bodyExample: { idosoId: "p05", area: "odontologica", tipo: "Extração dentária", localExterno: "Centro de Especialidades Odontológicas", data: "2026-10-10", instituicao: "CEO Municipal" },
      example: exemploTratamento,
      description: "Vinculado ao idoso; agendamento opcional (do mesmo idoso). Tratamento odontológico conta para o ciclo da US-089.",
    }),
  },
  "/api/tratamentos-externos/{id}": {
    get: op("G3 · Atendimento clínico", "Detalhe do tratamento externo", "atendimento-clinico.visualizar", { params: [path("id")], errors: [404], example: exemploTratamento, description: leituraAuditada }),
    put: op("G3 · Atendimento clínico", "Editar tratamento externo", "atendimento-clinico.editar", {
      params: [path("id")], body: corpoTratamento, errors: [404], example: exemploTratamento,
      description: "O idoso não pode ser trocado (422). Sem exclusão física.",
    }),
  },
  "/api/odontologia/pendencias": {
    get: op("G3 · Atendimento clínico", "Idosos sem registro odontológico no ciclo", "atendimento-clinico.visualizar", {
      query: [
        ...pagina,
        query("ciclo", { type: "string", pattern: "^\\d{4}-[12]$", example: "2026-2" }, "Modo semestre_civil. Padrão: semestre atual."),
        query("referencia", dataDia, "Modo dias_corridos: fim da janela. Padrão: hoje."),
      ],
      example: {
        ciclo: { modo: "semestre_civil", rotulo: "2026-2", inicio: "2026-07-01", fim: "2026-12-31" },
        resumo: { totalIdosos: 52, comRegistroNoCiclo: 2, pendentes: 50 },
        data: [{ idoso: { id: "p12", nome: "Pedro Lima" }, ultimoRegistro: null, acompanhamentoAtivo: "em_tratamento" }],
        meta: { page: 1, limit: 20, total: 50, pages: 3 },
      },
      description: `Conta registro clínico odontológico finalizado ou tratamento externo odontológico dentro do ciclo. O modo vem de \`/api/odontologia/configuracao-ciclo\`. ${leituraAuditada}`,
    }),
  },
  "/api/odontologia/configuracao-ciclo": {
    get: op("G3 · Atendimento clínico", "Configuração do ciclo odontológico", "atendimento-clinico.visualizar", { example: { modo: "semestre_civil", dias: 180 } }),
    put: op("G3 · Atendimento clínico", "Alterar o ciclo odontológico", "atendimento-clinico.administrar", {
      body: { type: "object", required: ["modo"], properties: { modo: { type: "string", enum: ["semestre_civil", "dias_corridos"] }, dias: { type: "integer", minimum: 30, maximum: 730, default: 180 } } },
      bodyExample: { modo: "dias_corridos", dias: 180 },
      example: { modo: "dias_corridos", dias: 180 },
      description: "`semestre_civil` (jan–jun / jul–dez, padrão) ou `dias_corridos` (janela de `dias` até a referência). Auditado.",
    }),
  },
  "/api/fisioterapia/planos": {
    get: op("G3 · Fisioterapia", "Listar planos de fisioterapia", "fisioterapia.visualizar", {
      query: [...pagina, query("idosoId", idosoId), query("situacao", { type: "string", enum: ["ativo", "suspenso", "concluido", "cancelado"] }), query("responsavelId", uuid)],
      example: lista(exemploPlano), description: leituraAuditada,
    }),
    post: op("G3 · Fisioterapia", "Cadastrar plano de tratamento", "fisioterapia.criar", {
      status: 201,
      body: { ...corpoPlano, required: ["idosoId", ...corpoPlano.required], properties: { idosoId, ...corpoPlano.properties } },
      bodyExample: { idosoId: "p02", responsavelId: exemploColaborador.id, objetivo: "Melhorar a marcha e reduzir o risco de quedas.", dataInicio: "2026-10-10", dataFim: "2027-01-08", frequenciaSemanal: 2 },
      example: { ...exemploPlano, atividades: [] },
      description: "Mais de um plano ativo por idoso é permitido. `vigente` = ativo e hoje dentro do período.",
    }),
  },
  "/api/fisioterapia/planos/{id}": {
    get: op("G3 · Fisioterapia", "Detalhe do plano (com atividades)", "fisioterapia.visualizar", {
      params: [path("id")], errors: [404], example: { ...exemploPlano, atividades: [exemploAtividade] }, description: leituraAuditada,
    }),
    put: op("G3 · Fisioterapia", "Editar plano", "fisioterapia.editar", {
      params: [path("id")], body: corpoPlano, errors: [404], example: { ...exemploPlano, atividades: [exemploAtividade] },
      conflictExample: erro("Plano cancelado não pode ser alterado."),
    }),
  },
  "/api/idosos/{idosoId}/planos-fisioterapia": {
    get: op("G3 · Fisioterapia", "Planos de fisioterapia do idoso", "fisioterapia.visualizar", {
      params: [path("idosoId", idosoId)], query: [...pagina, query("situacao", { type: "string", enum: ["ativo", "suspenso", "concluido", "cancelado"] })],
      errors: [404], example: { idoso: { id: "p02", nome: "Antônio Pereira" }, ...lista(exemploPlano) }, description: leituraAuditada,
    }),
  },
  "/api/fisioterapia/planos/{id}/atividades": {
    get: op("G3 · Fisioterapia", "Atividades do plano", "fisioterapia.visualizar", { params: [path("id")], errors: [404], example: { planoId: exemploPlano.id, data: [exemploAtividade] } }),
    post: op("G3 · Fisioterapia", "Definir atividade do plano", "fisioterapia.criar", {
      status: 201, params: [path("id")], body: corpoAtividade,
      bodyExample: { descricao: "Agachamento assistido", frequenciaSemanal: 2, duracaoMin: 10, intensidade: "Moderada", configuracao: { series: 3, repeticoes: 10 } },
      errors: [404], example: exemploAtividade, conflictExample: erro("Plano concluído ou cancelado não recebe atividades."),
    }),
  },
  "/api/fisioterapia/atividades/{id}": {
    put: op("G3 · Fisioterapia", "Editar atividade", "fisioterapia.editar", {
      params: [path("id")], body: corpoAtividade, errors: [404], example: exemploAtividade,
      description: "Sem exclusão física: use `ativa: false`.",
    }),
  },
  "/api/fisioterapia/atividades/{id}/execucoes": {
    post: op("G3 · Fisioterapia", "Registrar realização da atividade na sessão", "fisioterapia.criar", {
      status: 201, params: [path("id")],
      body: {
        type: "object", required: ["agendamentoId", "status"],
        properties: {
          agendamentoId: { ...uuid, description: "Sessão (agendamento de fisioterapia ligado ao plano da atividade)." },
          status: { type: "string", enum: ["realizada", "parcial", "nao_realizada"] },
          profissionalId: { ...uuid, nullable: true, description: "Padrão: profissional da sessão." },
          observacoes: { type: "string", maxLength: 2000, nullable: true },
        },
      },
      bodyExample: { agendamentoId: exemploAgendamento.id, status: "realizada", observacoes: "Sem dor." },
      errors: [404],
      example: {
        id: "7a8b9c0d-1e2f-4a3b-c4d5-e6f7a8b9c0d1", sessao: { agendamentoId: exemploAgendamento.id, inicio: exemploAgendamento.inicio },
        atividade: { id: exemploAtividade.id, descricao: exemploAtividade.descricao }, profissional: { id: exemploColaborador.id, nome: "Renata Gouveia" },
        status: "realizada", observacoes: "Sem dor.", registradoEm: "2026-11-10T17:45:00.000Z", registradoPor: { id: "s06", nome: "Renata Gouveia" },
      },
      conflictExample: erro("Esta atividade já foi registrada nesta sessão."),
      description: "Sempre dentro de uma sessão: uma execução por atividade e sessão (409). A sessão precisa estar ligada ao plano da atividade (422) e ser `realizado`, ou `agendado` já dentro da tolerância do tipo; sessão `cancelado` ou `nao_realizado` é 422. Execução é imutável; correção por `POST /api/fisioterapia/execucoes/{id}/corrigir`.",
    }),
  },
  "/api/fisioterapia/execucoes/{id}": {
    get: op("G3 · Fisioterapia", "Detalhe da execução (com correções)", "fisioterapia.visualizar", {
      params: [path("id")], errors: [404], description: leituraAuditada,
    }),
  },
  "/api/fisioterapia/execucoes/{id}/corrigir": {
    post: op("G3 · Fisioterapia", "Corrigir execução de atividade", "fisioterapia.administrar", {
      params: [path("id")],
      body: {
        type: "object", required: ["motivo"],
        properties: {
          motivo: { type: "string", minLength: 3, maxLength: 1000 },
          status: { type: "string", enum: ["realizada", "parcial", "nao_realizada"] },
          profissionalId: uuid,
          observacoes: { type: "string", maxLength: 2000, nullable: true },
        },
      },
      bodyExample: { status: "realizada", motivo: "Lançada como parcial por engano" },
      errors: [404],
      example: {
        id: "7a8b9c0d-1e2f-4a3b-c4d5-e6f7a8b9c0d1", status: "realizada",
        correcoes: [{ id: "c1", anterior: { status: "parcial", profissionalId: exemploColaborador.id, observacoes: "Dor ao final." }, novo: { status: "realizada", profissionalId: exemploColaborador.id, observacoes: "Dor ao final." }, motivo: "Lançada como parcial por engano", em: "2026-11-11T10:00:00.000Z", autor: { id: "s02", nome: "Ricardo Almeida Teixeira" } }],
      },
      description: "Troca status, profissional e observações, com motivo obrigatório; grava anterior → novo em trilha imutável. Mesmo padrão de `corrigir-realizacao`: o banco só aceita a alteração com uma flag local da transação. 422 sem motivo ou sem mudança real.",
    }),
  },
  "/api/fisioterapia/planos/{id}/execucoes": {
    get: op("G3 · Fisioterapia", "Execuções do plano", "fisioterapia.visualizar", {
      params: [path("id")], query: [...pagina, query("agendamentoId", uuid)], errors: [404], description: leituraAuditada,
    }),
  },
  "/api/fisioterapia/planos/{id}/evolucoes": {
    get: op("G3 · Fisioterapia", "Evolução do plano (linha cronológica)", "fisioterapia.visualizar", {
      params: [path("id")], query: pagina, errors: [404],
      example: lista({ id: "8b9c0d1e-2f3a-4b4c-d5e6-f7a8b9c0d1e2", planoId: exemploPlano.id, agendamentoId: exemploAgendamento.id, texto: "Caminhou 20 m com andador sem dor.", registradoEm: "2026-11-10T17:50:00.000Z", autor: { id: "s06", nome: "Renata Gouveia" }, publicacao: { status: "aguardando_permissao", prontuarioRef: null } }),
      description: `Ordem cronológica crescente. ${leituraAuditada}`,
    }),
    post: op("G3 · Fisioterapia", "Registrar evolução do plano", "fisioterapia.criar", {
      status: 201, params: [path("id")],
      body: { type: "object", required: ["texto"], properties: { texto: { type: "string", minLength: 10, maxLength: 8000 }, agendamentoId: { ...uuid, nullable: true, description: "Sessão do mesmo plano (opcional)." } } },
      bodyExample: { texto: "Caminhou 20 m com andador sem dor.", agendamentoId: exemploAgendamento.id },
      errors: [404],
      description: "Imutável. Publicada no prontuário se o autor tem `evolucao.create`; senão `publicacao.status = \"aguardando_permissao\"` (mesma regra do registro clínico).",
    }),
  },
  "/api/fisioterapia/evolucoes/republicar-pendentes": {
    post: op("G3 · Fisioterapia", "Republicar evoluções pendentes no prontuário", "fisioterapia.administrar", {
      example: { verificados: 2, publicados: 1, aguardandoPermissao: 1 },
      description: "Publica, em nome do autor, as evoluções pendentes cujo autor agora tem `evolucao.create`. Idempotente.",
    }),
  },
  "/api/fisioterapia/planos/{id}/programar-semana": {
    post: op("G3 · Fisioterapia", "Programar as sessões da semana", "fisioterapia.criar e agenda.criar", {
      status: 201, params: [path("id")],
      body: {
        type: "object", required: ["semana", "tipoId", "sessoes"],
        properties: {
          semana: { ...dataDia, description: "Qualquer dia da semana (segunda a domingo)." },
          tipoId: { ...uuid, description: "Tipo de atendimento da categoria fisioterapia." },
          local: { type: "string", maxLength: 120, nullable: true },
          sessoes: {
            type: "array", minItems: 1, maxItems: 14,
            items: {
              type: "object", required: ["diaSemana", "hora"],
              properties: {
                diaSemana: { type: "integer", minimum: 1, maximum: 7 }, hora: horario,
                duracaoMin: { type: "integer", minimum: 5, maximum: 720 },
                profissionalId: { ...uuid, nullable: true, description: "Padrão: responsável do plano." },
              },
            },
          },
        },
      },
      bodyExample: { semana: "2026-11-09", tipoId: exemploTipo.id, sessoes: [{ diaSemana: 1, hora: "09:00" }, { diaSemana: 3, hora: "09:00" }] },
      errors: [404],
      example: { planoId: exemploPlano.id, sessoes: [{ ...exemploAgendamento, planoFisioterapiaId: exemploPlano.id, avisos: [] }] },
      conflictExample: erro("Sessão 2: O profissional já tem agendamento nesse horário.", { sessao: 1, conflitos: exemploConflito.error.details.conflitos }),
      description: "Cria as sessões ligadas ao plano com a mesma validação de `POST /api/agendamentos` (conflito, lembretes, histórico). Tudo ou nada: se uma sessão falha, nenhuma é criada e `details.sessao` aponta qual.",
    }),
  },
  "/api/fisioterapia/rotina-semanal": {
    get: op("G3 · Fisioterapia", "Rotina semanal e carga por dia", "fisioterapia.visualizar", {
      query: [query("semana", dataDia, "Qualquer dia da semana. Padrão: hoje."), query("profissionalId", uuid)],
      example: {
        semana: { inicio: "2026-11-09", fim: "2026-11-15", fuso: "America/Sao_Paulo" },
        resumo: { sessoesNaCarga: 2, minutosNaCarga: 80, canceladas: 1, naoRealizadas: 0 },
        cargaPorDia: [{ data: "2026-11-09", diaSemana: 1, sessoes: 1, minutos: 40, porProfissional: [{ id: exemploColaborador.id, nome: "Renata Gouveia", sessoes: 1, minutos: 40 }] }],
        sessoes: [exemploAgendamento],
      },
      description: `A carga por dia conta só sessões \`agendado\` e \`realizado\`; \`sessoes\` lista todas. ${lgpd}`,
    }),
  },
  "/api/fisioterapia/indicadores": {
    get: op("G3 · Fisioterapia", "Indicadores da fisioterapia", "fisioterapia.visualizar", {
      query: [query("inicio", dataDia, "Padrão: primeiro dia do mês."), query("fim", dataDia, "Padrão: hoje.")],
      example: {
        periodo: { inicio: "2026-11-01", fim: "2026-11-09" },
        planos: { ativos: 12, idososEmFisioterapia: 11, suspensos: 1, concluidos: 4 },
        sessoes: { previstas: 40, realizadas: 30, naoRealizadas: 2, agendadas: 8, canceladas: 3, taxaRealizacao: 93.8 },
      },
      description: "Planos ativos = situação `ativo` e hoje dentro do período. Sessões do período: previstas = não canceladas; `taxaRealizacao` = realizadas ÷ (realizadas + não realizadas), em %. Sem dados do idoso.",
    }),
  },
  "/api/tarefas": {
    get: op("G3 · Tarefas", "Listar tarefas", "tarefas.visualizar", {
      query: [
        ...pagina, query("responsavelId", uuid), query("status", statusTarefa), query("prioridade", prioridadeTarefa),
        query("atrasadas", { type: "boolean" }, "true = prazo vencido e status pendente ou em_andamento."),
        query("prazoAte", dataHora), query("q", { type: "string", maxLength: 80 }, "Busca no título."),
      ],
      example: lista(exemploTarefa),
      description: "`atrasada` é derivado (não é status gravado): prazo vencido e tarefa pendente ou em andamento.",
    }),
    post: op("G3 · Tarefas", "Criar e distribuir tarefa", "tarefas.criar", {
      status: 201, body: corpoTarefa,
      bodyExample: { titulo: "Revisar escala de fisioterapia da semana", responsavelId: exemploColaborador.id, prazo: "2026-11-12T18:00:00-03:00", prioridade: "alta" },
      example: { ...exemploTarefa, historico: [historicoTarefa[0]] },
    }),
  },
  "/api/me/tarefas": {
    get: op("G3 · Tarefas", "Minhas tarefas", "tarefas.visualizar", {
      query: [...pagina, query("status", statusTarefa), query("prioridade", prioridadeTarefa), query("atrasadas", { type: "boolean" })],
      errors: [404], example: lista(exemploTarefa),
      description: "Tarefas do colaborador vinculado ao usuário logado (404 sem vínculo).",
    }),
  },
  "/api/tarefas/{id}": {
    get: op("G3 · Tarefas", "Detalhe da tarefa (com histórico)", "tarefas.visualizar", {
      params: [path("id")], errors: [404], example: { ...exemploTarefa, historico: historicoTarefa },
    }),
    put: op("G3 · Tarefas", "Editar dados da tarefa", "tarefas.criar (quem criou) ou tarefas.administrar", {
      params: [path("id")], body: corpoTarefa, errors: [404], example: { ...exemploTarefa, historico: historicoTarefa },
      conflictExample: erro("Tarefa concluída ou cancelada não pode ser alterada."),
    }),
  },
  "/api/tarefas/{id}/status": {
    patch: op("G3 · Tarefas", "Atualizar status", "tarefas.editar (responsável) ou tarefas.administrar", {
      params: [path("id")],
      body: { type: "object", required: ["status"], properties: { status: statusTarefa, observacao: { type: "string", maxLength: 1000, nullable: true } } },
      bodyExample: { status: "em_andamento", observacao: "Comecei hoje." },
      errors: [404],
      example: { ...exemploTarefa, status: "em_andamento", historico: historicoTarefa },
      conflictExample: erro("Tarefa já concluida."),
      description: "Só o responsável (usuário vinculado ao colaborador responsável) ou quem tem `tarefas.administrar` (403). Grava `concluidaEm` ao concluir e uma linha no histórico imutável. Concluída e cancelada são finais (409; use `reabrir`); mesmo status é 422.",
    }),
  },
  "/api/tarefas/{id}/reabrir": {
    post: op("G3 · Tarefas", "Reabrir tarefa concluída ou cancelada", "tarefas.administrar", {
      params: [path("id")],
      body: {
        type: "object", required: ["motivo"],
        properties: { motivo: { type: "string", minLength: 3, maxLength: 1000 }, prazo: { ...dataHora, description: "Novo prazo (opcional)." } },
      },
      bodyExample: { motivo: "Faltou conferir o segundo andar", prazo: "2026-11-14T18:00:00-03:00" },
      errors: [404],
      example: {
        ...exemploTarefa, historico: [...historicoTarefa,
          { id: "h3", evento: "reaberta", statusAnterior: "concluida", statusNovo: "pendente", observacao: "Faltou conferir o segundo andar", em: "2026-11-11T12:00:00.000Z", autor: { id: "s02", nome: "Ricardo Almeida Teixeira" } }],
      },
      conflictExample: erro("Só tarefa concluída ou cancelada pode ser reaberta."),
      description: "Volta a tarefa para `pendente`, limpa `concluidaEm` e, se informado, troca o prazo. Grava o evento `reaberta` no histórico imutável, com autor, data e motivo. O banco só aceita a mudança com uma flag local da transação. 422 sem motivo.",
    }),
  },
  "/api/indicadores/atendimentos": {
    get: op("G3 · Indicadores", "Indicadores de atendimentos", "modulo.dashboard (proposta)", {
      query: periodoIndicador,
      example: {
        periodo: { inicio: "2026-11-01", fim: "2026-11-09", fuso: "America/Sao_Paulo" },
        total: 120, previstos: 112, agendados: 30, realizados: 75, naoRealizados: 7, cancelados: 8, pendentesDeRegistro: 3,
        taxaRealizacao: 91.5, taxaCancelamento: 6.7,
        porCategoria: [{ categoria: "fisioterapia", total: 40, previstos: 38, agendados: 10, realizados: 26, naoRealizados: 2, cancelados: 2, pendentesDeRegistro: 1, taxaRealizacao: 92.9, taxaCancelamento: 5 }],
      },
      description: "Só números, sem dados de idoso. Fórmulas: taxaRealizacao = realizados ÷ (realizados + naoRealizados); taxaCancelamento = cancelados ÷ total; previstos = total − cancelados (US-128). Taxas em %, com uma casa; denominador zero → null.",
    }),
  },
  "/api/indicadores/tarefas": {
    get: op("G3 · Indicadores", "Indicadores de tarefas", "modulo.dashboard (proposta)", {
      query: periodoIndicador,
      example: {
        periodo: { inicio: "2026-11-01", fim: "2026-11-09", fuso: "America/Sao_Paulo" },
        agora: { abertas: 12, atrasadas: 3, taxaAtraso: 25, porPrioridade: [{ prioridade: "urgente", abertas: 1, atrasadas: 1 }] },
        noPeriodo: { criadas: 20, concluidas: 15, concluidasNoPrazo: 12, canceladas: 1, taxaConclusaoNoPrazo: 80 },
      },
      description: "`agora` é a fotografia do momento; `noPeriodo` usa o período. Denominador zero → null.",
    }),
  },
  "/api/indicadores/equipe": {
    get: op("G3 · Indicadores", "Indicadores de presença da equipe", "modulo.dashboard (proposta)", {
      query: [query("data", dataDia, "Padrão: hoje no fuso da instituição.")],
      example: {
        data: "2026-11-09", fuso: "America/Sao_Paulo", colaboradoresAtivos: 33, presentesNoDia: 21, ausentesNoDia: 2, presentesAgora: 14,
        escalasNoDia: 6, escalasComPresenca: 5, taxaPresencaEscala: 83.3,
        porVinculo: [{ vinculo: "funcionario", ativos: 25, presentes: 18, ausentes: 1 }],
      },
      description: "Presença é registro operacional, não controle de ponto. Denominador zero → null.",
    }),
  },
  "/api/fisioterapia/relatorios/evolucao": {
    get: op("G3 · Relatórios", "Relatório de evolução da fisioterapia (US-081)", "fisioterapia.visualizar", {
      query: [...pagina, ...periodoRelatorio, query("idosoId", idosoId), query("planoId", uuid)],
      errors: [404],
      example: {
        periodo: { inicio: "2026-11-01", fim: "2026-11-09" },
        data: [{
          plano: { id: exemploPlano.id, objetivo: exemploPlano.objetivo, dataInicio: "2026-10-10", dataFim: null, frequenciaSemanal: 2, situacao: "ativo", responsavel: exemploPlano.responsavel },
          idoso: { id: "p02", nome: "Antônio Pereira" },
          sessoes: { total: 6, agendadas: 1, realizadas: 4, naoRealizadas: 0, canceladas: 1, taxaRealizacao: 100 },
          atividades: [{ id: exemploAtividade.id, descricao: exemploAtividade.descricao, ativa: true, execucoes: { realizada: 3, parcial: 1, naoRealizada: 0, total: 4 } }],
          evolucoes: [{ id: "e1", registradoEm: "2026-11-05T17:50:00.000Z", agendamentoId: exemploAgendamento.id, texto: "Caminhou 20 m com andador sem dor.", autor: { id: "s06", nome: "Renata Gouveia" } }],
        }],
        meta: { page: 1, limit: 20, total: 1, pages: 1 },
      },
      description: `Consolida, por plano cujo período toca o período do relatório: dados do plano, sessões (realizadas, não realizadas, canceladas, agendadas), execuções por atividade e evoluções no período. Paginado por plano. ${periodo12} ${leituraAuditada}`,
    }),
  },
  "/api/relatorios/consultas-tratamentos": {
    get: op("G3 · Relatórios", "Relatório de consultas e tratamentos (US-090)", "atendimento-clinico.visualizar ou modulo.relatorios", {
      query: [
        ...pagina, ...periodoRelatorio,
        query("area", { type: "string", enum: ["medica", "odontologica"] }),
        query("profissionalId", uuid, "Só consultas: tratamento externo não tem colaborador."),
        query("idosoId", idosoId),
        query("status", { type: "string", enum: ["agendado", "realizado", "nao_realizado", "cancelado"] }, "Tratamento externo conta como realizado."),
        query("incluirConteudo", { type: "boolean", default: false }, "Exige atendimento-clinico.visualizar (403)."),
      ],
      errors: [404],
      example: {
        periodo: { inicio: "2026-11-01", fim: "2026-11-09" },
        filtros: { area: null, profissionalId: null, idosoId: null, status: null, incluirConteudo: false },
        resumo: { consultas: 2, tratamentosExternos: 1, porStatus: { realizado: 2, cancelado: 1 } },
        data: [
          { origem: "consulta", id: exemploAgendamento.id, data: "2026-11-05T12:00:00.000Z", idoso: { id: "p09", nome: "José Almeida" }, area: "medica", tipo: "Consulta médica", status: "realizado", profissional: { id: exemploColaborador.id, nome: "Dr. Paulo Ferraz Neto" } },
          { origem: "tratamento_externo", id: exemploTratamento.id, data: "2026-11-03T03:00:00.000Z", idoso: { id: "p05", nome: "Ana Souza" }, area: "odontologica", tipo: "Extração dentária", status: "realizado", profissional: null },
        ],
        meta: { page: 1, limit: 20, total: 2, pages: 1 },
      },
      description: `Consultas (agendamentos de consulta médica ou odontológica) e tratamentos externos no período, do mais recente ao mais antigo. **Por padrão, só metadados** (data, idoso, profissional, tipo, status). Com \`incluirConteudo=true\` (só com \`atendimento-clinico.visualizar\`), cada item traz \`conteudo\`: local e registro clínico da consulta, ou local externo, instituição e observações do tratamento. ${periodo12} ${leituraAuditada}`,
    }),
  },
  "/api/idosos/{idosoId}/atendimentos": {
    get: op("G3 · Agenda", "Histórico de atendimentos do idoso", "agenda.visualizar", {
      params: [path("idosoId", idosoId)],
      query: [...pagina, ...filtrosAgenda],
      errors: [404],
      example: { idoso: { id: "p02", nome: "Antônio Pereira" }, ...lista({ ...exemploAgendamento, status: "realizado" }) },
      description: `Do mais recente ao mais antigo. Integra os registros da agenda do Grupo 3; a linha do tempo do prontuário (Grupo 1) fica atrás da porta de integração. ${lgpd}`,
    }),
  },
};

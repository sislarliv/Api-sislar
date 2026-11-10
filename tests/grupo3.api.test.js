import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { processarPendenciasOdontologicas, processarTarefasAtrasadas } from "../src/grupo3/alertas.js";
import { processarLembretes } from "../src/grupo3/lembretes.js";
import { prepare, shutdown } from "./prepare.js";

const password = "Sislar@2026";
const sessoes = {};
const EMAILS = {
  admin: "marta.lima@lardoirmaovelho.example",
  gestor: "ricardo.teixeira@lardoirmaovelho.example",
  tecnico: "joana.rocha@lardoirmaovelho.example",
  medico: "paulo.ferraz@lardoirmaovelho.example",
  fisio: "renata.gouveia@lardoirmaovelho.example",
  recepcao: "aline.barros@lardoirmaovelho.example",
  voluntaria: "helena.duarte@lardoirmaovelho.example",
};

async function como(perfil) {
  if (!sessoes[perfil]) {
    const response = await request(app).post("/api/auth/login").send({ email: EMAILS[perfil], password });
    assert.equal(response.status, 200);
    sessoes[perfil] = { Authorization: `Bearer ${response.body.token}` };
  }
  return sessoes[perfil];
}

const get = async (perfil, url) => request(app).get(url).set(await como(perfil));
const post = async (perfil, url, body) => request(app).post(url).set(await como(perfil)).send(body);

// Datas fixas fora do intervalo do seed, no fuso da instituição.
const em = (dia, hora) => `2030-03-${dia}T${hora}:00-03:00`;

let profissional;
let individual;
let grupo;

before(async () => {
  await prepare();
  const colaborador = await post("gestor", "/api/colaboradores", { nome: "Profissional de teste", vinculo: "funcionario" });
  assert.equal(colaborador.status, 201);
  profissional = colaborador.body.id;
  const tipoA = await post("admin", "/api/tipos-atendimento", {
    nome: "Teste individual", categoria: "avaliacao", duracaoPadraoMin: 30,
  });
  const tipoB = await post("admin", "/api/tipos-atendimento", {
    nome: "Teste em grupo", categoria: "fisioterapia", duracaoPadraoMin: 60, permiteSobreposicao: true,
    exigeMotivoCancelamento: false, exigeMotivoReagendamento: false,
  });
  assert.equal(tipoA.status, 201);
  assert.equal(tipoB.status, 201);
  individual = tipoA.body.id;
  grupo = tipoB.body.id;
});

after(async () => {
  await shutdown();
});

function agendar(perfil, extra) {
  return post(perfil, "/api/agendamentos", { idosoId: "p01", tipoId: individual, profissionalId: profissional, ...extra });
}

describe("grupo3 · documentação", () => {
  it("publica as rotas do G3 e marca a agenda legada como obsoleta", async () => {
    const spec = (await request(app).get("/api/openapi.json")).body;
    assert.equal(spec.paths["/api/agendamentos"].post.summary, "Agendar atendimento");
    assert.ok(spec.paths["/api/agendamentos"].post.responses["409"].content["application/json"].example.error.details.conflitos);
    assert.ok(spec.paths["/api/idosos/{idosoId}/atendimentos"].get);
    assert.equal(spec.paths["/api/agenda"].get.deprecated, true);
    assert.equal(spec.paths["/api/agenda"].post.deprecated, true);
    assert.equal(spec.paths["/api/atendimentos"].post.deprecated, true);
    assert.equal(spec.paths["/api/funcionarios"].get.deprecated, true);
    for (const rota of [
      "/api/agendas/farmacia", "/api/agendas/cuidados-pessoais", "/api/idosos/{idosoId}/cuidados-pessoais",
      "/api/agendamentos/{id}/lembretes", "/api/escalas", "/api/escalas/lacunas", "/api/escalas/cobertura-necessaria",
      "/api/presencas", "/api/colaboradores/{id}/disponibilidades", "/api/especialidades",
      "/api/agendamentos/{id}/registro-clinico", "/api/registros-clinicos/{id}", "/api/odontologia/acompanhamentos",
      "/api/tratamentos-externos", "/api/odontologia/pendencias",
      "/api/fisioterapia/planos", "/api/fisioterapia/rotina-semanal", "/api/fisioterapia/indicadores", "/api/fisioterapia/planos/{id}/evolucoes",
      "/api/tarefas", "/api/me/tarefas", "/api/indicadores/atendimentos", "/api/indicadores/tarefas", "/api/indicadores/equipe",
      "/api/fisioterapia/relatorios/evolucao", "/api/relatorios/consultas-tratamentos",
    ]) {
      assert.ok(spec.paths[rota]?.get, rota);
    }
  });
});

describe("grupo3 · tipos de atendimento (US-065)", () => {
  it("cria com regras configuráveis e recusa nome repetido", async () => {
    const tipo = await get("recepcao", `/api/tipos-atendimento/${grupo}`);
    assert.equal(tipo.status, 200);
    assert.equal(tipo.body.permiteSobreposicao, true);
    assert.equal(tipo.body.exigeMotivoCancelamento, false);
    const repetido = await post("admin", "/api/tipos-atendimento", { nome: "teste INDIVIDUAL", categoria: "outro", duracaoPadraoMin: 10 });
    assert.equal(repetido.status, 409);
  });

  it("só quem administra a agenda cria tipos", async () => {
    const response = await post("recepcao", "/api/tipos-atendimento", { nome: "Podologia", categoria: "cuidado_pessoal", duracaoPadraoMin: 30 });
    assert.equal(response.status, 403);
    const lista = await get("recepcao", "/api/tipos-atendimento?categoria=cuidado_pessoal");
    assert.equal(lista.status, 200);
    assert.ok(lista.body.data.length >= 3);
    assert.ok(lista.body.data.every((item) => item.categoria === "cuidado_pessoal"));
  });

  it("tipo inativo não aceita novo agendamento", async () => {
    const criado = await post("admin", "/api/tipos-atendimento", { nome: "Tipo a inativar", categoria: "outro", duracaoPadraoMin: 15 });
    const inativo = await request(app).patch(`/api/tipos-atendimento/${criado.body.id}/status`).set(await como("admin")).send({ ativo: false });
    assert.equal(inativo.body.ativo, false);
    const response = await agendar("recepcao", { tipoId: criado.body.id, inicio: em("20", "08:00") });
    assert.equal(response.status, 422);
  });
});

describe("grupo3 · agendar e conflitos (US-067, US-073)", () => {
  it("agenda com duração padrão do tipo e grava histórico", async () => {
    const response = await agendar("recepcao", { inicio: em("12", "10:00"), local: "Sala 2", observacoes: "Primeira avaliação" });
    assert.equal(response.status, 201);
    assert.equal(response.body.status, "agendado");
    assert.equal(response.body.duracaoMin, 30);
    assert.equal(new Date(response.body.fim).toISOString(), "2030-03-12T13:30:00.000Z");
    assert.equal(response.body.idoso.id, "p01");
    const historico = await get("gestor", `/api/agendamentos/${response.body.id}/historico`);
    assert.equal(historico.body.data[0].acao, "criado");
  });

  it("recusa sobreposição com 409 e lista os conflitos", async () => {
    const response = await agendar("recepcao", { inicio: em("12", "10:15") });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.details.conflitos.length, 1);
    const verificacao = await post("recepcao", "/api/agendamentos/verificar-conflitos", {
      profissionalId: profissional, tipoId: individual, inicio: em("12", "10:29"),
    });
    assert.equal(verificacao.status, 200);
    assert.equal(verificacao.body.temConflito, true);
    const recusa = await prisma.audit_log.findFirst({ where: { action: "agendamento.criar", payload: { path: ["resultado"], equals: "recusado_conflito" } } });
    assert.ok(recusa);
  });

  it("aceita horário encostado no fim do anterior", async () => {
    const response = await agendar("recepcao", { inicio: em("12", "10:30") });
    assert.equal(response.status, 201);
  });

  it("mesmo tipo com sobreposição permitida aceita; tipo diferente não", async () => {
    const a = await agendar("recepcao", { tipoId: grupo, inicio: em("13", "09:00") });
    const b = await agendar("recepcao", { tipoId: grupo, idosoId: "p02", inicio: em("13", "09:00") });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const individualNoGrupo = await agendar("recepcao", { inicio: em("13", "09:30") });
    assert.equal(individualNoGrupo.status, 409);
    const individualAntes = await agendar("recepcao", { inicio: em("13", "14:00") });
    const grupoSobreIndividual = await agendar("recepcao", { tipoId: grupo, inicio: em("13", "13:30") });
    assert.equal(individualAntes.status, 201);
    assert.equal(grupoSobreIndividual.status, 409);
  });

  it("duas gravações simultâneas no mesmo horário: só uma passa", async () => {
    const respostas = await Promise.all([
      agendar("recepcao", { inicio: em("19", "10:00") }),
      agendar("gestor", { idosoId: "p03", inicio: em("19", "10:00") }),
    ]);
    assert.deepEqual(respostas.map((item) => item.status).sort(), [201, 409]);
  });

  it("valida idoso, profissional e formato de data", async () => {
    assert.equal((await agendar("recepcao", { idosoId: "nao-existe", inicio: em("14", "10:00") })).status, 422);
    assert.equal((await agendar("recepcao", { inicio: "2030-03-14 10:00" })).status, 422);
    assert.equal((await agendar("recepcao", { inicio: em("14", "10:00"), duracaoMin: 2 })).status, 422);
  });
});

describe("grupo3 · reagendar, cancelar e realizar (US-068, US-069)", () => {
  it("reagenda sem conflitar consigo mesmo e recusa horário ocupado", async () => {
    const alvo = await agendar("recepcao", { inicio: em("15", "10:00") });
    await agendar("recepcao", { inicio: em("15", "11:00") });
    const semMotivo = await post("recepcao", `/api/agendamentos/${alvo.body.id}/reagendar`, { inicio: em("15", "10:10") });
    assert.equal(semMotivo.status, 422);
    const ok = await post("recepcao", `/api/agendamentos/${alvo.body.id}/reagendar`, { inicio: em("15", "10:10"), motivo: "Atraso do transporte" });
    assert.equal(ok.status, 200);
    assert.equal(new Date(ok.body.inicio).toISOString(), "2030-03-15T13:10:00.000Z");
    const ocupado = await post("recepcao", `/api/agendamentos/${alvo.body.id}/reagendar`, { inicio: em("15", "10:50"), motivo: "Pedido da família" });
    assert.equal(ocupado.status, 409);
    const historico = await get("gestor", `/api/agendamentos/${alvo.body.id}/historico`);
    const reagendado = historico.body.data.find((item) => item.acao === "reagendado");
    assert.equal(reagendado.motivo, "Atraso do transporte");
    assert.equal(new Date(reagendado.anterior.inicio).toISOString(), "2030-03-15T13:00:00.000Z");
    assert.equal(reagendado.autor.id, "s09");
  });

  it("cancelado libera o horário e não volta a ser alterado", async () => {
    const alvo = await agendar("recepcao", { inicio: em("16", "10:00") });
    assert.equal((await post("recepcao", `/api/agendamentos/${alvo.body.id}/cancelar`, {})).status, 422);
    const cancelado = await post("recepcao", `/api/agendamentos/${alvo.body.id}/cancelar`, { motivo: "Idoso hospitalizado" });
    assert.equal(cancelado.status, 200);
    assert.equal(cancelado.body.status, "cancelado");
    assert.equal((await agendar("recepcao", { inicio: em("16", "10:00") })).status, 201);
    assert.equal((await post("recepcao", `/api/agendamentos/${alvo.body.id}/reagendar`, { inicio: em("16", "15:00"), motivo: "Retorno" })).status, 409);
    await assert.rejects(prisma.$executeRaw`DELETE FROM grupo3.agendamento WHERE id = ${alvo.body.id}::uuid`);
  });

  it("realização só depois do início e uma única vez", async () => {
    const futuro = await agendar("recepcao", { inicio: em("17", "10:00") });
    assert.equal((await post("recepcao", `/api/agendamentos/${futuro.body.id}/realizacao`, { status: "realizado" })).status, 422);
    const passado = await agendar("recepcao", { inicio: "2025-01-10T10:00:00-03:00" });
    const feito = await post("fisio", `/api/agendamentos/${passado.body.id}/realizacao`, { status: "nao_realizado", observacao: "Idoso recusou" });
    assert.equal(feito.status, 200);
    assert.equal(feito.body.status, "nao_realizado");
    assert.equal(feito.body.responsavelRealizacao.id, profissional);
    assert.equal(feito.body.registradoPor.id, "s06");
    assert.ok(feito.body.concluidoEm);
    assert.equal((await post("recepcao", `/api/agendamentos/${passado.body.id}/realizacao`, { status: "realizado" })).status, 409);
    assert.equal((await post("recepcao", `/api/agendamentos/${passado.body.id}/cancelar`, { motivo: "Engano" })).status, 409);
  });
});

describe("grupo3 · tolerância e correção da realização", () => {
  const daquiA = (minutos) => new Date(Date.now() + minutos * 60_000).toISOString();

  it("aceita realização dentro da tolerância do tipo e recusa fora dela", async () => {
    const dentro = await agendar("recepcao", { inicio: daquiA(30) });
    const fora = await agendar("recepcao", { inicio: daquiA(180) });
    assert.equal((await post("recepcao", `/api/agendamentos/${dentro.body.id}/realizacao`, { status: "realizado" })).status, 200);
    const recusa = await post("recepcao", `/api/agendamentos/${fora.body.id}/realizacao`, { status: "realizado" });
    assert.equal(recusa.status, 422);
    assert.match(recusa.body.error.details[0].message, /60 min/);
    const semTolerancia = await post("admin", "/api/tipos-atendimento", {
      nome: "Teste sem tolerância", categoria: "outro", duracaoPadraoMin: 20, toleranciaRealizacaoMin: 0,
    });
    assert.equal(semTolerancia.body.toleranciaRealizacaoMin, 0);
    const cedo = await agendar("recepcao", { tipoId: semTolerancia.body.id, inicio: daquiA(300) });
    assert.equal((await post("recepcao", `/api/agendamentos/${cedo.body.id}/realizacao`, { status: "realizado" })).status, 422);
  });

  it("corrige realização só com agenda.administrar e motivo, e registra no histórico", async () => {
    const alvo = await agendar("recepcao", { inicio: "2025-02-10T10:00:00-03:00" });
    await post("recepcao", `/api/agendamentos/${alvo.body.id}/realizacao`, { status: "realizado", observacao: "Feito" });
    const url = `/api/agendamentos/${alvo.body.id}/corrigir-realizacao`;
    assert.equal((await post("recepcao", url, { status: "nao_realizado", motivo: "Registro no idoso errado" })).status, 403);
    assert.equal((await post("gestor", url, { status: "nao_realizado" })).status, 422);
    assert.equal((await post("gestor", url, { status: "realizado", motivo: "Sem mudança real" })).status, 422);
    const corrigido = await post("gestor", url, { status: "nao_realizado", observacao: "Idoso dormia", motivo: "Lançado como realizado por engano" });
    assert.equal(corrigido.status, 200);
    assert.equal(corrigido.body.status, "nao_realizado");
    assert.equal(corrigido.body.observacaoRealizacao, "Idoso dormia");
    assert.equal(corrigido.body.registradoPor.id, "s09");
    const historico = await get("gestor", `/api/agendamentos/${alvo.body.id}/historico`);
    const item = historico.body.data.find((linha) => linha.acao === "corrigido");
    assert.equal(item.anterior.status, "realizado");
    assert.equal(item.novo.status, "nao_realizado");
    assert.equal(item.motivo, "Lançado como realizado por engano");
    assert.equal(item.autor.id, "s02");
    const cancelado = await agendar("recepcao", { inicio: em("21", "10:00") });
    await post("recepcao", `/api/agendamentos/${cancelado.body.id}/cancelar`, { motivo: "Sem vaga" });
    assert.equal((await post("gestor", `/api/agendamentos/${cancelado.body.id}/corrigir-realizacao`, { status: "realizado", motivo: "Teste" })).status, 409);
  });

  it("a liberação da correção vale só para a própria transação", async () => {
    const alvo = await agendar("recepcao", { inicio: "2025-04-10T10:00:00-03:00" });
    await post("recepcao", `/api/agendamentos/${alvo.body.id}/realizacao`, { status: "realizado" });
    const corrigido = await post("gestor", `/api/agendamentos/${alvo.body.id}/corrigir-realizacao`, { status: "nao_realizado", motivo: "Ajuste de lançamento" });
    assert.equal(corrigido.status, 200);
    // Várias tentativas para passar por conexões diferentes do pool, inclusive a usada na correção.
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(prisma.$executeRaw`UPDATE grupo3.agendamento SET status = 'realizado' WHERE id = ${alvo.body.id}::uuid`);
    }
    const flag = await prisma.$queryRaw`SELECT coalesce(current_setting('grupo3.correcao_realizacao', true), '') AS valor`;
    assert.notEqual(flag[0].valor, "on");
  });

  it("o banco continua bloqueando alteração direta de agendamento encerrado", async () => {
    const alvo = await agendar("recepcao", { inicio: "2025-03-10T10:00:00-03:00" });
    await post("recepcao", `/api/agendamentos/${alvo.body.id}/realizacao`, { status: "realizado" });
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.agendamento SET status = 'nao_realizado' WHERE id = ${alvo.body.id}::uuid`);
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('grupo3.correcao_realizacao', 'on', true)`;
      await tx.$executeRaw`UPDATE grupo3.agendamento SET inicio = inicio + interval '1 hour' WHERE id = ${alvo.body.id}::uuid`;
    }));
  });
});

describe("grupo3 · agenda e histórico do idoso (US-066, US-072)", () => {
  it("mostra a agenda do dia com status e conflito", async () => {
    const response = await get("gestor", `/api/colaboradores/${profissional}/agenda?visao=dia&data=2030-03-12`);
    assert.equal(response.status, 200);
    assert.equal(response.body.periodo.fuso, "America/Sao_Paulo");
    assert.equal(new Date(response.body.periodo.inicio).toISOString(), "2030-03-12T03:00:00.000Z");
    assert.equal(response.body.resumo.agendado, 2);
    assert.equal(response.body.resumo.emConflito, 0);
    const semana = await get("gestor", `/api/colaboradores/${profissional}/agenda?visao=semana&data=2030-03-13`);
    assert.ok(semana.body.data.length >= 6);
  });

  it("profissional vê a própria agenda; usuário sem vínculo recebe 404", async () => {
    const fisio = await get("fisio", "/api/me/agenda?visao=mes");
    assert.equal(fisio.status, 200);
    assert.equal(fisio.body.colaborador.nome, "Renata Gouveia");
    assert.equal((await get("recepcao", "/api/me/agenda")).status, 404);
  });

  it("histórico do idoso traz realizados e futuros, do mais recente ao mais antigo", async () => {
    const response = await get("gestor", "/api/idosos/p02/atendimentos");
    assert.equal(response.status, 200);
    const status = response.body.data.map((item) => item.status);
    assert.ok(status.includes("realizado"));
    assert.ok(status.includes("agendado"));
    const datas = response.body.data.map((item) => new Date(item.inicio).getTime());
    assert.deepEqual(datas, [...datas].sort((a, b) => b - a));
    const realizados = await get("gestor", "/api/idosos/p02/atendimentos?status=realizado");
    assert.ok(realizados.body.data.every((item) => item.status === "realizado"));
    assert.equal((await get("gestor", "/api/idosos/nao-existe/atendimentos")).status, 404);
  });
});

describe("grupo3 · permissões e LGPD (NFR-014)", () => {
  it("voluntária não vê a agenda geral, só a própria", async () => {
    assert.equal((await get("voluntaria", "/api/agendamentos")).status, 403);
    assert.equal((await get("voluntaria", "/api/idosos/p02/atendimentos")).status, 403);
    assert.equal((await get("voluntaria", `/api/colaboradores/${profissional}/agenda`)).status, 403);
    const propria = await get("voluntaria", "/api/me/agenda?visao=mes");
    assert.equal(propria.status, 200);
    assert.ok(propria.body.data.every((item) => item.profissional.nome === "Helena Duarte"));
  });

  it("técnico consulta mas não agenda; sem token é 401", async () => {
    assert.equal((await get("tecnico", "/api/agendamentos")).status, 200);
    assert.equal((await agendar("tecnico", { inicio: em("18", "10:00") })).status, 403);
    assert.equal((await request(app).get("/api/agendamentos")).status, 401);
  });

  it("recepção não lê o texto de consulta; médico lê", async () => {
    const recepcao = await get("recepcao", "/api/agendamentos?categoria=consulta_medica");
    assert.equal(recepcao.status, 200);
    assert.ok(recepcao.body.data.length > 0);
    assert.ok(recepcao.body.data.every((item) => item.observacoes === null && item.conteudoRestrito === true));
    const medico = await get("medico", "/api/agendamentos?categoria=consulta_medica");
    assert.ok(medico.body.data.some((item) => item.observacoes === "Revisão de pressão arterial."));
  });

  it("só a gestão cadastra colaborador", async () => {
    assert.equal((await post("recepcao", "/api/colaboradores", { nome: "Fulano", vinculo: "voluntario" })).status, 403);
    const duplicado = await post("gestor", "/api/colaboradores", { nome: "Outra Renata", vinculo: "funcionario", usuarioId: "s06" });
    assert.equal(duplicado.status, 409);
  });
});

// ---------------- Fatia 2 ----------------

async function tipoPorNome(nome) {
  const lista = await get("admin", "/api/tipos-atendimento?limit=100");
  return lista.body.data.find((tipo) => tipo.nome === nome).id;
}

async function colaboradorPorNome(nome) {
  const lista = await get("admin", `/api/colaboradores?q=${encodeURIComponent(nome)}`);
  return lista.body.data.find((item) => item.nome === nome).id;
}

const lembretes = async (perfil, id) => (await get(perfil, `/api/agendamentos/${id}/lembretes`)).body.data;

describe("grupo3 · agenda da farmácia (US-070)", () => {
  let farmaceutico;
  let farmacia;

  before(async () => {
    farmaceutico = (await post("gestor", "/api/colaboradores", { nome: "Farmacêutica de teste", vinculo: "funcionario" })).body.id;
    farmacia = await tipoPorNome("Atendimento da farmácia");
    const corte = await tipoPorNome("Corte de cabelo");
    for (const [hora, tipoId, idosoId] of [["08:30", farmacia, "p01"], ["14:00", farmacia, "p02"], ["09:00", corte, "p03"]]) {
      const criado = await post("recepcao", "/api/agendamentos", { idosoId, tipoId, profissionalId: farmaceutico, inicio: `2030-04-02T${hora}:00-03:00` });
      assert.equal(criado.status, 201);
    }
  });

  it("filtra por janela de atendimento no fuso da instituição", async () => {
    const dia = await get("tecnico", `/api/agendas/farmacia?visao=dia&data=2030-04-02&profissionalId=${farmaceutico}`);
    assert.equal(dia.status, 200);
    assert.equal(dia.body.data.length, 2);
    assert.ok(dia.body.data.every((item) => item.tipo.categoria === "farmacia"));
    assert.equal(dia.body.porProfissional[0].total, 2);
    const manha = await get("tecnico", `/api/agendas/farmacia?visao=dia&data=2030-04-02&profissionalId=${farmaceutico}&janelaInicio=08:00&janelaFim=10:00`);
    assert.equal(manha.body.data.length, 1);
    assert.deepEqual(manha.body.janela, { inicio: "08:00", fim: "10:00" });
    const lista = await get("tecnico", `/api/agendamentos?categoria=farmacia&profissionalId=${farmaceutico}&janelaInicio=13:00`);
    assert.equal(lista.body.data.length, 1);
  });

  it("filtra por responsável e recusa janela invertida", async () => {
    const outro = await get("tecnico", `/api/agendas/farmacia?visao=dia&data=2030-04-02&profissionalId=${profissional}`);
    assert.equal(outro.body.data.length, 0);
    assert.equal((await get("tecnico", "/api/agendas/farmacia?janelaInicio=10:00&janelaFim=09:00")).status, 422);
    assert.equal((await get("tecnico", "/api/agendas/farmacia?janelaInicio=25:00")).status, 422);
    assert.equal((await get("voluntaria", "/api/agendas/farmacia")).status, 403);
  });
});

describe("grupo3 · cuidados pessoais (US-071)", () => {
  it("mostra agenda própria e histórico de realização por serviço", async () => {
    const corte = await tipoPorNome("Corte de cabelo");
    const barba = await tipoPorNome("Barba");
    const cabeleireiro = await colaboradorPorNome("Jorge Matias (cabeleireiro)");
    const feito = await post("recepcao", "/api/agendamentos", { idosoId: "p04", tipoId: corte, profissionalId: cabeleireiro, inicio: "2025-05-05T10:00:00-03:00" });
    await post("recepcao", `/api/agendamentos/${feito.body.id}/realizacao`, { status: "realizado" });
    const barbaFeita = await post("recepcao", "/api/agendamentos", { idosoId: "p04", tipoId: barba, profissionalId: cabeleireiro, inicio: "2025-05-05T11:00:00-03:00" });
    await post("recepcao", `/api/agendamentos/${barbaFeita.body.id}/realizacao`, { status: "realizado" });

    const historico = await get("recepcao", "/api/idosos/p04/cuidados-pessoais");
    assert.equal(historico.status, 200);
    const porTipo = Object.fromEntries(historico.body.data.map((item) => [item.tipo.nome, item]));
    assert.equal(porTipo["Corte de cabelo"].totalRealizados, 1);
    assert.equal(porTipo["Corte de cabelo"].ultimaRealizacao.responsavel.nome, "Jorge Matias (cabeleireiro)");
    assert.ok(porTipo["Corte de cabelo"].proximoAgendamento);
    assert.equal(porTipo.Barba.proximoAgendamento, null);

    const agenda = await get("recepcao", "/api/agendas/cuidados-pessoais?visao=mes&data=2025-05-05");
    assert.equal(agenda.status, 200);
    assert.ok(agenda.body.data.length >= 2);
    assert.ok(agenda.body.data.every((item) => item.tipo.categoria === "cuidado_pessoal"));
    assert.equal((await get("recepcao", "/api/idosos/nao-existe/cuidados-pessoais")).status, 404);
  });
});

describe("grupo3 · lembretes (US-074)", () => {
  let renata;

  before(async () => {
    renata = await colaboradorPorNome("Renata Gouveia");
  });

  it("agenda lembrete 24 h antes para colaborador com usuário", async () => {
    const criado = await agendar("recepcao", { profissionalId: renata, inicio: "2030-04-05T10:00:00-03:00" });
    const lista = await lembretes("recepcao", criado.body.id);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].status, "pendente");
    assert.equal(lista[0].antecedenciaMin, 1440);
    assert.equal(new Date(lista[0].enviarEm).toISOString(), "2030-04-04T13:00:00.000Z");
    assert.equal(lista[0].destinatario.usuarioId, "s06");
  });

  it("colaborador sem usuário gera lembrete sem_destinatario, visível na API", async () => {
    const criado = await agendar("recepcao", { inicio: "2030-04-06T10:00:00-03:00" });
    const lista = await lembretes("recepcao", criado.body.id);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].status, "sem_destinatario");
    assert.match(lista[0].ultimoErro, /sem usuário/);
  });

  it("vincular usuário depois devolve o lembrete para a fila", async () => {
    const semUsuario = (await post("gestor", "/api/colaboradores", { nome: "Psicóloga de teste", vinculo: "externo" })).body.id;
    const criado = await agendar("recepcao", { profissionalId: semUsuario, inicio: "2030-04-07T10:00:00-03:00" });
    assert.equal((await lembretes("recepcao", criado.body.id))[0].status, "sem_destinatario");
    const vinculo = await request(app).put(`/api/colaboradores/${semUsuario}`).set(await como("gestor"))
      .send({ nome: "Psicóloga de teste", vinculo: "externo", usuarioId: "s16" });
    assert.equal(vinculo.status, 200);
    const lista = await lembretes("recepcao", criado.body.id);
    assert.equal(lista[0].status, "pendente");
    assert.equal(lista[0].destinatario.usuarioId, "s16");
  });

  it("antecedências configuradas por tipo; lista vazia desliga", async () => {
    const dois = await post("admin", "/api/tipos-atendimento", {
      nome: "Teste dois lembretes", categoria: "outro", duracaoPadraoMin: 30, antecedenciasLembreteMin: [60, 1440, 60],
    });
    assert.deepEqual(dois.body.antecedenciasLembreteMin, [1440, 60]);
    const nenhum = await post("admin", "/api/tipos-atendimento", {
      nome: "Teste sem lembrete", categoria: "outro", duracaoPadraoMin: 30, antecedenciasLembreteMin: [],
    });
    const a = await agendar("recepcao", { tipoId: dois.body.id, profissionalId: renata, inicio: "2030-04-08T10:00:00-03:00" });
    const b = await agendar("recepcao", { tipoId: nenhum.body.id, profissionalId: renata, inicio: "2030-04-08T14:00:00-03:00" });
    assert.equal((await lembretes("recepcao", a.body.id)).length, 2);
    assert.equal((await lembretes("recepcao", b.body.id)).length, 0);
    assert.equal((await post("admin", "/api/tipos-atendimento", { nome: "Teste inválido", categoria: "outro", duracaoPadraoMin: 30, antecedenciasLembreteMin: [1] })).status, 422);
  });

  it("reagendar cancela o lembrete antigo e cria outro; cancelar encerra a fila", async () => {
    const criado = await agendar("recepcao", { profissionalId: renata, inicio: "2030-04-09T10:00:00-03:00" });
    await post("recepcao", `/api/agendamentos/${criado.body.id}/reagendar`, { inicio: "2030-04-10T10:00:00-03:00", motivo: "Troca de dia" });
    const depois = await lembretes("recepcao", criado.body.id);
    assert.deepEqual(depois.map((item) => item.status).sort(), ["cancelado", "pendente"]);
    assert.equal(new Date(depois.find((item) => item.status === "pendente").enviarEm).toISOString(), "2030-04-09T13:00:00.000Z");
    await post("recepcao", `/api/agendamentos/${criado.body.id}/cancelar`, { motivo: "Família levou ao médico" });
    assert.ok((await lembretes("recepcao", criado.body.id)).every((item) => item.status === "cancelado"));
  });

  it("job entrega na caixa de notificações e não reenvia", async () => {
    const proximo = await agendar("recepcao", { profissionalId: renata, inicio: new Date(Date.now() + 45 * 60_000).toISOString(), local: "Sala 3" });
    const [pendente] = await lembretes("recepcao", proximo.body.id);
    assert.equal(pendente.status, "pendente");
    const resumo = await processarLembretes();
    assert.ok(resumo.entregues >= 1);
    const [entregue] = await lembretes("recepcao", proximo.body.id);
    assert.equal(entregue.status, "entregue");
    assert.equal(entregue.canal, "interno");
    assert.ok(entregue.entregueEm);
    const caixa = await get("fisio", "/api/notificacoes");
    const aviso = caixa.body.data.find((item) => item.kind === "agenda" && item.link === `/agenda/agendamentos/${proximo.body.id}`);
    assert.ok(aviso);
    assert.match(aviso.body, /Sala 3/);
    const segunda = await processarLembretes();
    assert.equal(segunda.processados, 0);
  });

  it("falha no envio tenta de novo e marca falha ao esgotar as tentativas", async () => {
    const proximo = await agendar("recepcao", { profissionalId: renata, inicio: new Date(Date.now() + 100 * 60_000).toISOString() });
    assert.equal(proximo.status, 201);
    const quebrado = async () => { throw new Error("canal indisponível"); };
    await processarLembretes({ enviar: quebrado });
    let [item] = await lembretes("recepcao", proximo.body.id);
    assert.equal(item.status, "pendente");
    assert.equal(item.tentativas, 1);
    await processarLembretes({ enviar: quebrado });
    await processarLembretes({ enviar: quebrado });
    [item] = await lembretes("recepcao", proximo.body.id);
    assert.equal(item.status, "falha");
    assert.equal(item.tentativas, 3);
    assert.equal(item.ultimoErro, "canal indisponível");
  });

  it("lembretes seguem a mesma permissão do agendamento", async () => {
    const criado = await agendar("recepcao", { profissionalId: renata, inicio: "2030-04-11T10:00:00-03:00" });
    assert.equal((await get("voluntaria", `/api/agendamentos/${criado.body.id}/lembretes`)).status, 403);
    assert.equal((await get("fisio", `/api/agendamentos/${criado.body.id}/lembretes`)).status, 200);
  });
});

describe("grupo3 · lembretes — regras de início e destinatário", () => {
  let renata;
  let paulo;

  before(async () => {
    renata = await colaboradorPorNome("Renata Gouveia");
    paulo = await colaboradorPorNome("Dr. Paulo Ferraz Neto");
  });

  it("agendamento com início no passado não gera lembrete", async () => {
    const passado = await agendar("recepcao", { profissionalId: renata, inicio: "2025-06-01T10:00:00-03:00" });
    assert.equal(passado.status, 201);
    assert.deepEqual(await lembretes("recepcao", passado.body.id), []);
  });

  it("troca de profissional no reagendamento cancela os lembretes e gera para o novo", async () => {
    const criado = await agendar("recepcao", { profissionalId: renata, inicio: "2030-05-02T10:00:00-03:00" });
    const reagendado = await post("recepcao", `/api/agendamentos/${criado.body.id}/reagendar`, {
      inicio: "2030-05-02T10:00:00-03:00", profissionalId: paulo, motivo: "Fisioterapeuta de férias",
    });
    assert.equal(reagendado.status, 200);
    const lista = await lembretes("recepcao", criado.body.id);
    const antigo = lista.find((item) => item.destinatario.colaboradorId === renata);
    const novo = lista.find((item) => item.destinatario.colaboradorId === paulo);
    assert.equal(antigo.status, "cancelado");
    assert.equal(novo.status, "pendente");
    assert.equal(novo.destinatario.usuarioId, "s05");
  });

  it("vincular usuário só reenfileira lembretes de agendamentos futuros ainda agendados", async () => {
    const colaborador = (await post("gestor", "/api/colaboradores", { nome: "Nutricionista de teste", vinculo: "externo" })).body.id;
    const futuro = await agendar("recepcao", { profissionalId: colaborador, inicio: "2030-05-03T10:00:00-03:00" });
    const passado = await agendar("recepcao", { profissionalId: colaborador, inicio: "2025-06-02T10:00:00-03:00" });
    // Lembrete órfão de um atendimento que já passou (ex.: gerado antes de o horário vencer).
    await prisma.$executeRaw`
      INSERT INTO grupo3.lembrete_agendamento (agendamento_id, colaborador_id, antecedencia_min, enviar_em, status)
      VALUES (${passado.body.id}::uuid, ${colaborador}::uuid, 1440, '2025-06-01T13:00:00Z', 'sem_destinatario')
    `;
    const vinculo = await request(app).put(`/api/colaboradores/${colaborador}`).set(await como("gestor"))
      .send({ nome: "Nutricionista de teste", vinculo: "externo", usuarioId: "s17" });
    assert.equal(vinculo.status, 200);
    assert.equal((await lembretes("recepcao", futuro.body.id))[0].status, "pendente");
    assert.equal((await lembretes("recepcao", passado.body.id))[0].status, "sem_destinatario");
  });

  it("job não envia lembrete de atendimento que já começou", async () => {
    const proximo = await agendar("recepcao", { profissionalId: renata, inicio: new Date(Date.now() + 200 * 60_000).toISOString() });
    assert.equal(proximo.status, 201);
    assert.equal((await lembretes("recepcao", proximo.body.id))[0].status, "pendente");
    await processarLembretes({ agora: new Date(Date.now() + 240 * 60_000), enviar: async () => assert.fail("não devia enviar") });
    const [item] = await lembretes("recepcao", proximo.body.id);
    assert.equal(item.status, "cancelado");
    assert.match(item.ultimoErro, /já iniciado/);
  });
});

// ---------------- Fatia 3 ----------------

const EMAILS_EXTRAS = { enfermagem: "carla.nunes@lardoirmaovelho.example" };
Object.assign(EMAILS, EMAILS_EXTRAS);

const put = async (perfil, url, body) => request(app).put(url).set(await como(perfil)).send(body);
const patch = async (perfil, url, body) => request(app).patch(url).set(await como(perfil)).send(body);
const hojeInstituicao = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

async function especialidadePorNome(nome) {
  const lista = await get("admin", "/api/especialidades?limit=100");
  const achada = lista.body.data.find((item) => item.nome === nome);
  if (achada) return achada.id;
  const criada = await post("admin", "/api/especialidades", { nome });
  assert.equal(criada.status, 201);
  return criada.body.id;
}

describe("grupo3 · especialidades", () => {
  it("só equipe.administrar cadastra; nome único sem diferenciar maiúsculas; sem exclusão física", async () => {
    assert.equal((await post("recepcao", "/api/especialidades", { nome: "Geriatria" })).status, 403);
    const criada = await post("gestor", "/api/especialidades", { nome: "Geriatria" });
    assert.equal(criada.status, 201);
    assert.equal(criada.body.ativo, true);
    assert.equal((await post("gestor", "/api/especialidades", { nome: "  geriatria " })).status, 409);
    const renomeada = await put("gestor", `/api/especialidades/${criada.body.id}`, { nome: "Geriatria clínica" });
    assert.equal(renomeada.body.nome, "Geriatria clínica");
    const lista = await get("recepcao", "/api/especialidades");
    assert.equal(lista.status, 200);
    assert.ok(["Clínica médica", "Odontologia", "Fisioterapia"].every((nome) => lista.body.data.some((e) => e.nome === nome)));
    await assert.rejects(prisma.$executeRaw`DELETE FROM grupo3.especialidade WHERE id = ${criada.body.id}::uuid`);
  });

  it("especialidade inativa não pode ser atribuída a colaborador", async () => {
    const criada = await post("gestor", "/api/especialidades", { nome: "Área desativada" });
    await patch("gestor", `/api/especialidades/${criada.body.id}/status`, { ativo: false });
    const resposta = await post("gestor", "/api/colaboradores", { nome: "Fulano da área", vinculo: "externo", especialidadeId: criada.body.id });
    assert.equal(resposta.status, 422);
    assert.match(resposta.body.error.details[0].message, /inativa/);
  });
});

describe("grupo3 · cadastro da equipe (US-091, US-092, US-082)", () => {
  it("cadastra funcionário com cargo, setor, contatos e especialidade, sem pedir documento", async () => {
    const enfermagem = await especialidadePorNome("Enfermagem");
    const criado = await post("gestor", "/api/colaboradores", {
      nome: "Marina Lopes", vinculo: "funcionario", cargo: "Cuidadora de idosos", setor: "Cuidados diários", especialidadeId: enfermagem,
      email: "Marina.Lopes@lardoirmaovelho.example", telefone: "(11) 91234-5678", cpf: "000.000.000-00",
    });
    assert.equal(criado.status, 201);
    assert.equal(criado.body.cargo, "Cuidadora de idosos");
    assert.deepEqual(criado.body.especialidade, { id: enfermagem, nome: "Enfermagem" });
    assert.equal(criado.body.email, "marina.lopes@lardoirmaovelho.example");
    assert.equal("cpf" in criado.body, false);
    const coluna = await prisma.$queryRaw`
      SELECT count(*)::int AS total FROM information_schema.columns
      WHERE table_schema = 'grupo3' AND table_name = 'colaborador' AND column_name IN ('cpf', 'documento', 'rg')
    `;
    assert.equal(coluna[0].total, 0);
  });

  it("cadastra médico voluntário e filtra por vínculo e especialidade", async () => {
    const clinica = await especialidadePorNome("Clínica médica");
    const criado = await post("gestor", "/api/colaboradores", {
      nome: "Dr. Caio Ribeiro", vinculo: "voluntario", especialidadeId: clinica, registroProfissional: "CRM-SP 000.222 (fictício)",
    });
    assert.equal(criado.status, 201);
    const clinicos = await get("gestor", `/api/colaboradores?especialidadeId=${clinica}&vinculo=voluntario&limit=100`);
    const nomes = clinicos.body.data.map((item) => item.nome);
    assert.ok(nomes.includes("Dr. Caio Ribeiro"));
    assert.ok(nomes.includes("Dra. Sônia Campos"));
    assert.ok(clinicos.body.data.every((item) => item.vinculo === "voluntario" && item.especialidade.id === clinica));
  });

  it("valida especialidade inexistente, e-mail e telefone", async () => {
    assert.equal((await post("gestor", "/api/colaboradores", { nome: "Fulano", vinculo: "externo", especialidadeId: "00000000-0000-4000-8000-000000000000" })).status, 422);
    assert.equal((await post("gestor", "/api/colaboradores", { nome: "Fulano", vinculo: "externo", especialidadeId: "clinica_medica" })).status, 422);
    assert.equal((await post("gestor", "/api/colaboradores", { nome: "Fulano", vinculo: "externo", email: "sem-arroba" })).status, 422);
    assert.equal((await post("gestor", "/api/colaboradores", { nome: "Fulano", vinculo: "externo", telefone: "abc" })).status, 422);
  });

  it("contatos só aparecem com equipe.visualizar", async () => {
    const recepcao = await get("recepcao", "/api/colaboradores?q=Paulo");
    assert.equal(recepcao.status, 200);
    const paulo = recepcao.body.data.find((item) => item.nome === "Dr. Paulo Ferraz Neto");
    assert.equal(paulo.telefone, null);
    assert.equal(paulo.email, null);
    assert.equal(paulo.contatosRestritos, true);
    assert.equal(paulo.cargo, "Médico geriatra");
    const enfermagem = await get("enfermagem", "/api/colaboradores?q=Paulo");
    assert.equal(enfermagem.body.data.find((item) => item.nome === "Dr. Paulo Ferraz Neto").telefone, "(11) 90000-0005");
    assert.equal((await get("recepcao", `/api/colaboradores/${paulo.id}`)).body.telefone, null);
  });

  it("disponibilidade substitui a lista, aceita 24:00 e recusa sobreposição", async () => {
    const id = (await post("gestor", "/api/colaboradores", { nome: "Voluntário de disponibilidade", vinculo: "voluntario" })).body.id;
    const url = `/api/colaboradores/${id}/disponibilidades`;
    const sobreposta = await put("gestor", url, { disponibilidades: [
      { diaSemana: 2, horaInicio: "08:00", horaFim: "12:00" }, { diaSemana: 2, horaInicio: "11:00", horaFim: "13:00" },
    ] });
    assert.equal(sobreposta.status, 422);
    const ok = await put("gestor", url, { disponibilidades: [
      { diaSemana: 4, horaInicio: "19:00", horaFim: "24:00" }, { diaSemana: 2, horaInicio: "08:00", horaFim: "12:00", observacao: "Só manhã" },
    ] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.data.map((d) => [d.diaSemana, d.horaInicio, d.horaFim]), [[2, "08:00", "12:00"], [4, "19:00", "24:00"]]);
    assert.equal((await get("recepcao", url)).status, 200);
    assert.equal((await put("recepcao", url, { disponibilidades: [] })).status, 403);
    assert.equal((await put("gestor", url, { disponibilidades: [{ diaSemana: 8, horaInicio: "09:00", horaFim: "10:00" }] })).status, 422);
  });
});

describe("grupo3 · escalas (US-083)", () => {
  let medica;
  let geriatria;

  before(async () => {
    geriatria = await especialidadePorNome("Geriatria de escala");
    medica = (await post("gestor", "/api/colaboradores", {
      nome: "Dra. Escala de Teste", vinculo: "voluntario", especialidadeId: geriatria,
    })).body.id;
    await put("gestor", `/api/colaboradores/${medica}/disponibilidades`, {
      disponibilidades: [{ diaSemana: 2, horaInicio: "08:00", horaFim: "12:00" }],
    });
  });

  const escalar = (perfil, extra) => post(perfil, "/api/escalas", {
    colaboradorId: medica, local: "Consultório 2", data: "2030-06-04", horaInicio: "08:00", horaFim: "12:00", ...extra,
  });

  it("cria escala com profissional, local, data, horário e situação; herda a especialidade", async () => {
    const criada = await escalar("gestor");
    assert.equal(criada.status, 201);
    assert.equal(criada.body.especialidade.id, geriatria);
    assert.equal(criada.body.situacao, "prevista");
    assert.equal(criada.body.horaInicio, "08:00");
    assert.equal(new Date(criada.body.inicio).toISOString(), "2030-06-04T11:00:00.000Z");
    assert.equal(criada.body.cruzaMeiaNoite, false);
    assert.deepEqual(criada.body.avisos, []);
  });

  it("recusa sobreposição do mesmo profissional e avisa fora da disponibilidade", async () => {
    const sobreposta = await escalar("gestor", { horaInicio: "11:00", horaFim: "13:00" });
    assert.equal(sobreposta.status, 409);
    assert.equal(sobreposta.body.error.details.conflitos.length, 1);
    const tarde = await escalar("gestor", { horaInicio: "12:00", horaFim: "14:00" });
    assert.equal(tarde.status, 201);
    assert.equal(tarde.body.avisos[0].codigo, "fora_da_disponibilidade");
    assert.equal((await escalar("gestor", { data: "2030-06-26", horaInicio: "10:00", horaFim: "10:00" })).status, 422);
  });

  it("plantão 19h–07h é um registro só e bloqueia sobreposição dos dois lados da meia-noite", async () => {
    const plantao = await escalar("gestor", { data: "2030-06-05", horaInicio: "19:00", horaFim: "07:00", local: "Plantão" });
    assert.equal(plantao.status, 201);
    assert.equal(plantao.body.cruzaMeiaNoite, true);
    assert.equal(plantao.body.data, "2030-06-05");
    assert.equal(plantao.body.horaFim, "07:00");
    assert.equal(new Date(plantao.body.inicio).toISOString(), "2030-06-05T22:00:00.000Z");
    assert.equal(new Date(plantao.body.fim).toISOString(), "2030-06-06T10:00:00.000Z");
    const total = await prisma.$queryRaw`SELECT count(*)::int AS n FROM grupo3.escala WHERE id = ${plantao.body.id}::uuid`;
    assert.equal(total[0].n, 1);
    assert.equal((await escalar("gestor", { data: "2030-06-06", horaInicio: "06:00", horaFim: "08:00" })).status, 409);
    assert.equal((await escalar("gestor", { data: "2030-06-05", horaInicio: "18:00", horaFim: "20:00" })).status, 409);
    assert.equal((await escalar("gestor", { data: "2030-06-06", horaInicio: "07:00", horaFim: "09:00" })).status, 201);
    const daQuinta = await get("gestor", `/api/escalas?inicio=2030-06-06&fim=2030-06-06&colaboradorId=${medica}`);
    assert.ok(daQuinta.body.data.some((e) => e.id === plantao.body.id));
  });

  it("duas gravações simultâneas no mesmo turno: só uma passa", async () => {
    const respostas = await Promise.all([
      escalar("gestor", { data: "2030-06-11" }),
      escalar("gestor", { data: "2030-06-11", local: "Consultório 3" }),
    ]);
    assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409]);
  });

  it("cancelada libera o horário e não volta a ser alterada", async () => {
    const criada = await escalar("gestor", { data: "2030-06-18" });
    const cancelada = await patch("gestor", `/api/escalas/${criada.body.id}/situacao`, { situacao: "cancelada", motivo: "Viagem" });
    assert.equal(cancelada.status, 200);
    assert.equal(cancelada.body.motivoCancelamento, "Viagem");
    assert.equal((await escalar("gestor", { data: "2030-06-18" })).status, 201);
    assert.equal((await patch("gestor", `/api/escalas/${criada.body.id}/situacao`, { situacao: "confirmada" })).status, 409);
    assert.equal((await put("gestor", `/api/escalas/${criada.body.id}`, {
      colaboradorId: medica, local: "X1", data: "2030-06-18", horaInicio: "14:00", horaFim: "15:00",
    })).status, 409);
    await assert.rejects(prisma.$executeRaw`DELETE FROM grupo3.escala WHERE id = ${criada.body.id}::uuid`);
  });

  it("lista por período e filtros; permissões de leitura e escrita", async () => {
    const lista = await get("recepcao", `/api/escalas?inicio=2030-06-04&fim=2030-06-04&colaboradorId=${medica}`);
    assert.equal(lista.status, 200);
    assert.equal(lista.body.data.length, 2);
    assert.equal((await get("recepcao", "/api/escalas?inicio=2030-06-10&fim=2030-06-01")).status, 422);
    assert.equal((await get("recepcao", "/api/escalas?inicio=2030-01-01&fim=2030-06-01")).status, 422);
    assert.equal((await escalar("recepcao", { data: "2030-06-25" })).status, 403);
    assert.equal((await get("voluntaria", "/api/escalas")).status, 403);
    const inativo = (await post("gestor", "/api/colaboradores", { nome: "Inativo da escala", vinculo: "externo" })).body.id;
    await patch("gestor", `/api/colaboradores/${inativo}/status`, { status: "inativo" });
    assert.equal((await escalar("gestor", { colaboradorId: inativo, data: "2030-06-25" })).status, 422);
  });
});

describe("grupo3 · cobertura e lacunas (US-084)", () => {
  let original;
  let area;
  let noturna;

  before(async () => {
    area = await especialidadePorNome("Área de teste");
    noturna = await especialidadePorNome("Enfermagem noturna de teste");
    original = (await get("gestor", "/api/escalas/cobertura-necessaria")).body.data
      .map(({ id, especialidade, ...resto }) => ({ especialidadeId: especialidade.id, ...resto }));
  });

  it("só a administração da equipe configura; recusa faixa sobreposta e especialidade inexistente", async () => {
    assert.equal((await put("enfermagem", "/api/escalas/cobertura-necessaria", { coberturas: [] })).status, 403);
    const sobreposta = await put("gestor", "/api/escalas/cobertura-necessaria", { coberturas: [
      { especialidadeId: area, diaSemana: 3, horaInicio: "08:00", horaFim: "12:00", quantidadeMinima: 1 },
      { especialidadeId: area, diaSemana: 3, horaInicio: "11:00", horaFim: "13:00", quantidadeMinima: 1 },
    ] });
    assert.equal(sobreposta.status, 422);
    const inexistente = await put("gestor", "/api/escalas/cobertura-necessaria", { coberturas: [
      ...original,
      { especialidadeId: "00000000-0000-4000-8000-000000000000", diaSemana: 1, horaInicio: "08:00", horaFim: "12:00", quantidadeMinima: 1 },
    ] });
    assert.equal(inexistente.status, 422);
    assert.match(inexistente.body.error.details[0].message, /não encontrada/);
    const intacta = await get("gestor", "/api/escalas/cobertura-necessaria");
    assert.equal(intacta.body.data.length, original.length);
  });

  it("aponta os períodos abaixo do mínimo na especialidade", async () => {
    const config = await put("gestor", "/api/escalas/cobertura-necessaria", { coberturas: [
      ...original,
      { especialidadeId: area, diaSemana: 3, horaInicio: "08:00", horaFim: "12:00", quantidadeMinima: 2 },
      { especialidadeId: noturna, diaSemana: 3, horaInicio: "19:00", horaFim: "24:00", quantidadeMinima: 1 },
      { especialidadeId: noturna, diaSemana: 4, horaInicio: "00:00", horaFim: "07:00", quantidadeMinima: 1 },
    ] });
    assert.equal(config.status, 200);
    const a = (await post("gestor", "/api/colaboradores", { nome: "Área teste A", vinculo: "funcionario", especialidadeId: area })).body.id;
    const b = (await post("gestor", "/api/colaboradores", { nome: "Área teste B", vinculo: "funcionario", especialidadeId: area })).body.id;
    await post("gestor", "/api/escalas", { colaboradorId: a, local: "Sala", data: "2030-06-05", horaInicio: "08:00", horaFim: "10:00" });
    await post("gestor", "/api/escalas", { colaboradorId: b, local: "Sala", data: "2030-06-05", horaInicio: "09:00", horaFim: "12:00" });

    const lacunas = await get("recepcao", `/api/escalas/lacunas?inicio=2030-06-05&fim=2030-06-05&especialidadeId=${area}`);
    assert.equal(lacunas.status, 200);
    assert.deepEqual(lacunas.body.data.map((l) => [l.data, l.inicio, l.fim, l.escalados, l.faltam]), [
      ["2030-06-05", "08:00", "09:00", 1, 1],
      ["2030-06-05", "10:00", "12:00", 1, 1],
    ]);
    assert.equal(lacunas.body.data[0].especialidade.nome, "Área de teste");
    assert.equal((await get("voluntaria", "/api/escalas/lacunas")).status, 403);
  });

  it("lacuna na virada do dia: plantão 19h–05h cobre a noite e deixa 05h–07h descoberto", async () => {
    const enfermeiro = (await post("gestor", "/api/colaboradores", { nome: "Enfermeiro noturno", vinculo: "funcionario", especialidadeId: noturna })).body.id;
    const plantao = await post("gestor", "/api/escalas", { colaboradorId: enfermeiro, local: "Posto", data: "2030-06-05", horaInicio: "19:00", horaFim: "05:00" });
    assert.equal(plantao.status, 201);
    const lacunas = await get("gestor", `/api/escalas/lacunas?inicio=2030-06-05&fim=2030-06-06&especialidadeId=${noturna}`);
    assert.deepEqual(lacunas.body.data.map((l) => [l.data, l.inicio, l.fim, l.escalados]), [["2030-06-06", "05:00", "07:00", 0]]);
    const soQuinta = await get("gestor", `/api/escalas/lacunas?inicio=2030-06-06&fim=2030-06-06&especialidadeId=${noturna}`);
    assert.deepEqual(soQuinta.body.data.map((l) => [l.inicio, l.fim]), [["05:00", "07:00"]]);
  });

  it("escala cancelada e colaborador inativo não cobrem a necessidade", async () => {
    const c = (await post("gestor", "/api/colaboradores", { nome: "Área teste C", vinculo: "funcionario", especialidadeId: area })).body.id;
    const e = await post("gestor", "/api/escalas", { colaboradorId: c, local: "Sala", data: "2030-06-12", horaInicio: "08:00", horaFim: "12:00" });
    const d = (await post("gestor", "/api/colaboradores", { nome: "Área teste D", vinculo: "funcionario", especialidadeId: area })).body.id;
    await post("gestor", "/api/escalas", { colaboradorId: d, local: "Sala", data: "2030-06-12", horaInicio: "08:00", horaFim: "12:00" });
    let lacunas = await get("gestor", `/api/escalas/lacunas?inicio=2030-06-12&fim=2030-06-12&especialidadeId=${area}`);
    assert.equal(lacunas.body.data.length, 0);
    await patch("gestor", `/api/escalas/${e.body.id}/situacao`, { situacao: "cancelada" });
    await patch("gestor", `/api/colaboradores/${d}/status`, { status: "inativo" });
    lacunas = await get("gestor", `/api/escalas/lacunas?inicio=2030-06-12&fim=2030-06-12&especialidadeId=${area}`);
    assert.deepEqual(lacunas.body.data.map((l) => [l.inicio, l.fim, l.escalados]), [["08:00", "12:00", 0]]);
  });
});

describe("grupo3 · presença (US-093) separada da escala", () => {
  let colaborador;
  let escalaHoje;
  const hoje = hojeInstituicao();

  before(async () => {
    colaborador = (await post("gestor", "/api/colaboradores", { nome: "Plantonista de teste", vinculo: "funcionario" })).body.id;
    escalaHoje = (await post("gestor", "/api/escalas", {
      colaboradorId: colaborador, local: "Ala A", data: hoje, horaInicio: "00:10", horaFim: "00:50",
    })).body.id;
  });

  it("registra presença ligada ao turno previsto, uma vez por escala", async () => {
    const presenca = await post("gestor", "/api/presencas", {
      colaboradorId: colaborador, data: hoje, horaEntrada: "00:15", escalaId: escalaHoje, atividade: "Plantão",
    });
    assert.equal(presenca.status, 201);
    assert.equal(presenca.body.emAndamento, true);
    assert.equal(presenca.body.escalaId, escalaHoje);
    assert.equal(presenca.body.registradoPor.id, "s02");
    assert.equal((await post("gestor", "/api/presencas", {
      colaboradorId: colaborador, data: hoje, horaEntrada: "00:20", escalaId: escalaHoje,
    })).status, 409);
    assert.equal((await post("gestor", "/api/presencas", { colaboradorId: colaborador, data: hoje, horaEntrada: "02:00" })).status, 409);
    const saida = await patch("gestor", `/api/presencas/${presenca.body.id}/saida`, { horaSaida: "00:55" });
    assert.equal(saida.status, 200);
    assert.equal(saida.body.horaSaida, "00:55");
    assert.equal(saida.body.emAndamento, false);
    assert.equal((await patch("gestor", `/api/presencas/${presenca.body.id}/saida`, { horaSaida: "01:00" })).status, 409);
  });

  it("plantão noturno: saída antes da entrada fica no dia seguinte", async () => {
    const noturno = (await post("gestor", "/api/colaboradores", { nome: "Plantonista noturno", vinculo: "funcionario" })).body.id;
    const presenca = await post("gestor", "/api/presencas", { colaboradorId: noturno, data: "2025-03-03", horaEntrada: "19:00", horaSaida: "07:00" });
    assert.equal(presenca.status, 201);
    assert.equal(presenca.body.saidaNoDiaSeguinte, true);
    assert.equal(new Date(presenca.body.saidaEm).toISOString(), "2025-03-04T10:00:00.000Z");
  });

  it("cancelar a escala não apaga a presença registrada", async () => {
    await patch("gestor", `/api/escalas/${escalaHoje}/situacao`, { situacao: "cancelada", motivo: "Erro de lançamento" });
    const lista = await get("gestor", `/api/presencas?data=${hoje}&colaboradorId=${colaborador}`);
    assert.equal(lista.body.data.length, 1);
    assert.equal(lista.body.data[0].escalaId, escalaHoje);
  });

  it("valida data futura, ausência e escala de outra pessoa", async () => {
    assert.equal((await post("gestor", "/api/presencas", { colaboradorId: colaborador, data: "2030-01-01", horaEntrada: "08:00" })).status, 422);
    assert.equal((await post("gestor", "/api/presencas", { colaboradorId: colaborador, data: hoje })).status, 422);
    assert.equal((await post("gestor", "/api/presencas", { colaboradorId: colaborador, data: hoje, situacao: "ausente", horaEntrada: "08:00" })).status, 422);
    const ausente = await post("gestor", "/api/presencas", { colaboradorId: colaborador, data: "2025-01-02", situacao: "ausente", justificativa: "Atestado" });
    assert.equal(ausente.status, 201);
    assert.equal(ausente.body.emAndamento, false);
    const outraPessoa = (await post("gestor", "/api/colaboradores", { nome: "Outro plantonista", vinculo: "funcionario" })).body.id;
    const escalaAlheia = await post("gestor", "/api/escalas", {
      colaboradorId: outraPessoa, local: "Ala B", data: hoje, horaInicio: "00:10", horaFim: "00:40",
    });
    assert.equal(escalaAlheia.status, 201);
    const recusa = await post("gestor", "/api/presencas", {
      colaboradorId: colaborador, data: hoje, situacao: "ausente", justificativa: "Teste", escalaId: escalaAlheia.body.id,
    });
    assert.equal(recusa.status, 422);
    assert.match(recusa.body.error.details[0].message, /mesmo colaborador/);
  });

  it("filtra quem está trabalhando por data, vínculo e em andamento", async () => {
    const agora = await get("gestor", `/api/presencas?data=${hoje}&emAndamento=true`);
    assert.equal(agora.status, 200);
    assert.ok(agora.body.data.every((item) => item.emAndamento));
    assert.ok(agora.body.data.some((item) => item.colaborador.nome === "Carla Beatriz Nunes"));
    const voluntarios = await get("gestor", `/api/presencas?data=${hoje}&vinculo=voluntario`);
    assert.ok(voluntarios.body.data.every((item) => item.colaborador.vinculo === "voluntario"));
    assert.ok(voluntarios.body.data.some((item) => item.colaborador.nome === "Helena Duarte"));
  });

  it("permissões: equipe.visualizar lê, só a gestão registra", async () => {
    assert.equal((await get("enfermagem", `/api/presencas?data=${hoje}`)).status, 200);
    assert.equal((await get("recepcao", `/api/presencas?data=${hoje}`)).status, 403);
    assert.equal((await post("enfermagem", "/api/presencas", { colaboradorId: colaborador, data: hoje, horaEntrada: "03:00" })).status, 403);
  });

  it("escala e presença ficam em tabelas separadas", async () => {
    const tabelas = await prisma.$queryRaw`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'grupo3' AND table_name IN ('escala', 'presenca') ORDER BY table_name
    `;
    assert.deepEqual(tabelas.map((t) => t.table_name), ["escala", "presenca"]);
  });
});

// ---------------- Fatia 4 ----------------

Object.assign(EMAILS, { odonto: "luciana.prado@lardoirmaovelho.example" });

async function leituraAuditada(acao, usuarioId, idosoId) {
  const rows = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM public.audit_log
    WHERE action = ${acao} AND user_id = ${usuarioId} AND payload->'idosos' ? ${idosoId}
  `;
  return rows[0].n;
}

describe("grupo3 · consultas (US-085)", () => {
  let paulo;
  let consultaMedica;
  let avaliacao;

  before(async () => {
    paulo = await colaboradorPorNome("Dr. Paulo Ferraz Neto");
    consultaMedica = await tipoPorNome("Consulta médica");
    avaliacao = await tipoPorNome("Avaliação multiprofissional");
    const escala = await post("gestor", "/api/escalas", {
      colaboradorId: paulo, local: "Consultório 1", data: "2030-07-01", horaInicio: "08:00", horaFim: "12:00",
    });
    assert.equal(escala.status, 201);
  });

  const consultar = (extra) => post("recepcao", "/api/agendamentos", {
    idosoId: "p09", tipoId: consultaMedica, profissionalId: paulo, local: "Consultório 1", ...extra,
  });

  it("consulta exige local", async () => {
    const resposta = await consultar({ local: undefined, inicio: "2030-07-01T09:00:00-03:00" });
    assert.equal(resposta.status, 422);
    assert.equal(resposta.body.error.details[0].path, "local");
  });

  it("dentro da escala não avisa; fora da escala é aceita com aviso", async () => {
    const dentro = await consultar({ inicio: "2030-07-01T09:00:00-03:00" });
    assert.equal(dentro.status, 201);
    assert.deepEqual(dentro.body.avisos, []);
    assert.equal(dentro.body.local, "Consultório 1");
    const fora = await consultar({ inicio: "2030-07-01T14:00:00-03:00" });
    assert.equal(fora.status, 201);
    assert.equal(fora.body.avisos[0].codigo, "fora_da_escala");
    const reagendada = await post("recepcao", `/api/agendamentos/${dentro.body.id}/reagendar`, {
      inicio: "2030-07-02T09:00:00-03:00", motivo: "Pedido da família",
    });
    assert.equal(reagendada.status, 200);
    assert.equal(reagendada.body.avisos[0].codigo, "fora_da_escala");
    const verificacao = await post("recepcao", "/api/agendamentos/verificar-conflitos", {
      profissionalId: paulo, tipoId: consultaMedica, inicio: "2030-07-01T10:30:00-03:00",
    });
    assert.deepEqual(verificacao.body.avisos, []);
  });

  it("outros tipos não recebem aviso de escala", async () => {
    const resposta = await post("recepcao", "/api/agendamentos", {
      idosoId: "p09", tipoId: avaliacao, profissionalId: paulo, inicio: "2030-07-03T15:00:00-03:00",
    });
    assert.equal(resposta.status, 201);
    assert.deepEqual(resposta.body.avisos, []);
  });
});

describe("grupo3 · registro clínico (US-086)", () => {
  let paulo;
  let consultaMedica;
  let realizada;
  let registroId;

  before(async () => {
    paulo = await colaboradorPorNome("Dr. Paulo Ferraz Neto");
    consultaMedica = await tipoPorNome("Consulta médica");
    realizada = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p09", tipoId: consultaMedica, profissionalId: paulo, local: "Consultório 1", inicio: "2025-04-07T09:00:00-03:00",
    })).body.id;
    assert.equal((await post("recepcao", `/api/agendamentos/${realizada}/realizacao`, { status: "realizado" })).status, 200);
  });

  it("cria rascunho com campos mínimos e conteúdo flexível validado", async () => {
    const invalido = await post("medico", `/api/agendamentos/${realizada}/registro-clinico`, {
      resumo: "Paciente estável, sem queixas.", conteudo: { exame: { pa: "13x8" } },
    });
    assert.equal(invalido.status, 422);
    const criado = await post("medico", `/api/agendamentos/${realizada}/registro-clinico`, {
      resumo: "Paciente estável, sem queixas.", conteudo: { pressaoArterial: "13x8", conduta: "Manter medicação", retornoDias: 90 },
    });
    assert.equal(criado.status, 201);
    registroId = criado.body.id;
    assert.equal(criado.body.status, "rascunho");
    assert.equal(criado.body.area, "medica");
    assert.equal(criado.body.tipo, "Consulta médica");
    assert.equal(criado.body.profissional.nome, "Dr. Paulo Ferraz Neto");
    assert.equal(criado.body.autor.id, "s05");
    assert.equal(new Date(criado.body.realizadoEm).toISOString(), "2025-04-07T12:00:00.000Z");
    assert.equal(criado.body.conteudo.retornoDias, 90);
    assert.equal(criado.body.publicacao, null);
    assert.equal((await post("medico", `/api/agendamentos/${realizada}/registro-clinico`, { resumo: "Segundo registro da consulta." })).status, 409);
  });

  it("só o autor edita o rascunho; consulta agendada não finaliza", async () => {
    assert.equal((await put("odonto", `/api/registros-clinicos/${registroId}`, { resumo: "Tentativa de outra profissional." })).status, 403);
    const editado = await put("medico", `/api/registros-clinicos/${registroId}`, {
      resumo: "Paciente estável, sem queixas. PA controlada.", conteudo: { pressaoArterial: "12x8" },
    });
    assert.equal(editado.status, 200);
    assert.equal(editado.body.conteudo.pressaoArterial, "12x8");
    const futura = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p09", tipoId: consultaMedica, profissionalId: paulo, local: "Consultório 1", inicio: "2030-07-08T09:00:00-03:00",
    })).body.id;
    const rascunhoFuturo = await post("medico", `/api/agendamentos/${futura}/registro-clinico`, { resumo: "Pré-consulta: trazer exames." });
    assert.equal(rascunhoFuturo.status, 201);
    assert.equal((await post("medico", `/api/registros-clinicos/${rascunhoFuturo.body.id}/finalizar`, {})).status, 409);
    assert.equal((await post("medico", `/api/agendamentos/${futura}/registro-clinico`, { resumo: "Tentativa de finalizar antes da consulta.", finalizar: true })).status, 409);
  });

  it("finalizado é publicado no prontuário e não aceita edição", async () => {
    const finalizado = await post("medico", `/api/registros-clinicos/${registroId}/finalizar`, {});
    assert.equal(finalizado.status, 200);
    assert.equal(finalizado.body.status, "finalizado");
    assert.equal(finalizado.body.finalizadoPor.id, "s05");
    assert.equal(finalizado.body.publicacao.status, "publicado");
    const evolucoes = await get("medico", "/api/prontuarios/p09/evolucoes");
    const evolucao = evolucoes.body.data.find((e) => e.id === finalizado.body.publicacao.prontuarioRef);
    assert.ok(evolucao);
    assert.equal(evolucao.status, "finalizado");
    assert.match(evolucao.title, /^Consulta médica/);
    assert.equal((await put("medico", `/api/registros-clinicos/${registroId}`, { resumo: "Mudança depois de finalizar." })).status, 409);
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.registro_clinico SET resumo = 'alterado direto' WHERE id = ${registroId}::uuid`);
    await assert.rejects(prisma.$executeRaw`DELETE FROM grupo3.registro_clinico WHERE id = ${registroId}::uuid`);
  });

  it("correção por adendo: registro novo vinculado, com autor e data", async () => {
    const adendo = await post("medico", `/api/registros-clinicos/${registroId}/adendos`, {
      resumo: "Adendo: paciente relatou tontura leve ao levantar.", conteudo: { orientacao: "Levantar devagar" },
    });
    assert.equal(adendo.status, 201);
    assert.equal(adendo.body.id, registroId);
    assert.equal(adendo.body.resumo, "Paciente estável, sem queixas. PA controlada.");
    assert.equal(adendo.body.adendos.length, 1);
    const item = adendo.body.adendos[0];
    assert.equal(item.adendoDe, registroId);
    assert.equal(item.status, "finalizado");
    assert.equal(item.autor.id, "s05");
    assert.ok(Date.now() - new Date(item.realizadoEm).getTime() < 60_000);
    assert.equal(item.publicacao.status, "publicado");
    const evolucoes = await get("medico", "/api/prontuarios/p09/evolucoes");
    assert.ok(evolucoes.body.data.some((e) => e.id === item.publicacao.prontuarioRef && /^Adendo/.test(e.title)));
    const viaAdendo = await post("medico", `/api/registros-clinicos/${item.id}/adendos`, { resumo: "Segundo adendo, via o primeiro." });
    assert.equal(viaAdendo.body.adendos.length, 2);
  });

  it("rascunho não recebe adendo; tipo que não é consulta não recebe registro", async () => {
    const futura = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p09", tipoId: consultaMedica, profissionalId: paulo, local: "Consultório 1", inicio: "2030-07-15T09:00:00-03:00",
    })).body.id;
    const rascunho = await post("medico", `/api/agendamentos/${futura}/registro-clinico`, { resumo: "Rascunho para teste de adendo." });
    assert.equal((await post("medico", `/api/registros-clinicos/${rascunho.body.id}/adendos`, { resumo: "Não deveria aceitar." })).status, 409);
    const avaliacao = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p09", tipoId: await tipoPorNome("Avaliação multiprofissional"), profissionalId: paulo, inicio: "2030-07-16T09:00:00-03:00",
    })).body.id;
    assert.equal((await post("medico", `/api/agendamentos/${avaliacao}/registro-clinico`, { resumo: "Não é consulta, não aceita." })).status, 422);
  });

  it("leitura é auditada e restrita ao atendimento clínico", async () => {
    const antes = await leituraAuditada("registro_clinico.ler", "s02", "p09");
    const lido = await get("gestor", `/api/agendamentos/${realizada}/registro-clinico`);
    assert.equal(lido.status, 200);
    assert.equal(lido.body.adendos.length, 2);
    assert.equal(await leituraAuditada("registro_clinico.ler", "s02", "p09"), antes + 1);
    const lista = await get("gestor", "/api/idosos/p09/registros-clinicos?area=medica");
    assert.ok(lista.body.data.some((r) => r.id === registroId));
    assert.equal(await leituraAuditada("registro_clinico.ler", "s02", "p09"), antes + 2);
    assert.equal((await get("recepcao", `/api/registros-clinicos/${registroId}`)).status, 403);
    assert.equal((await get("fisio", `/api/registros-clinicos/${registroId}`)).status, 403);
    assert.equal((await post("recepcao", `/api/registros-clinicos/${registroId}/adendos`, { resumo: "Sem permissão para isto." })).status, 403);
  });
});

describe("grupo3 · acompanhamento odontológico (US-087)", () => {
  let acompanhamentoId;

  it("um acompanhamento ativo por idoso, com plano, periodicidade e situação", async () => {
    const luciana = await colaboradorPorNome("Dra. Luciana Prado");
    const criado = await post("odonto", "/api/odontologia/acompanhamentos", {
      idosoId: "p12", responsavelId: luciana, plano: "Tratamento periodontal e revisão semestral.", situacao: "em_tratamento",
      proximaAvaliacao: "2026-12-01",
    });
    assert.equal(criado.status, 201);
    acompanhamentoId = criado.body.id;
    assert.equal(criado.body.periodicidadeDias, 180);
    assert.equal(criado.body.responsavel.nome, "Dra. Luciana Prado");
    assert.equal((await post("odonto", "/api/odontologia/acompanhamentos", { idosoId: "p12", plano: "Outro plano ativo." })).status, 409);
    const concluido = await put("odonto", `/api/odontologia/acompanhamentos/${acompanhamentoId}`, {
      responsavelId: luciana, plano: "Tratamento periodontal concluído.", situacao: "concluido",
    });
    assert.equal(concluido.status, 200);
    assert.equal(concluido.body.situacao, "concluido");
    assert.equal((await post("odonto", "/api/odontologia/acompanhamentos", { idosoId: "p12", plano: "Nova fase de acompanhamento." })).status, 201);
  });

  it("registro odontológico liga ao acompanhamento do mesmo idoso; leitura auditada", async () => {
    const luciana = await colaboradorPorNome("Dra. Luciana Prado");
    const consulta = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p11", tipoId: await tipoPorNome("Consulta odontológica"), profissionalId: luciana, local: "Consultório odontológico",
      inicio: "2025-05-06T14:00:00-03:00",
    })).body.id;
    await post("recepcao", `/api/agendamentos/${consulta}/realizacao`, { status: "realizado" });
    const deOutro = await post("odonto", `/api/agendamentos/${consulta}/registro-clinico`, {
      resumo: "Avaliação de rotina sem alterações.", acompanhamentoId,
    });
    assert.equal(deOutro.status, 422);
    const antes = await leituraAuditada("acompanhamento_odontologico.ler", "s07", "p12");
    const lista = await get("odonto", "/api/odontologia/acompanhamentos?idosoId=p12");
    assert.equal(lista.body.data.length, 2);
    assert.equal(await leituraAuditada("acompanhamento_odontologico.ler", "s07", "p12"), antes + 1);
    assert.equal((await get("recepcao", "/api/odontologia/acompanhamentos")).status, 403);
  });
});

describe("grupo3 · tratamento externo (US-088)", () => {
  it("registra tratamento fora da instituição ligado ao idoso, com agendamento opcional", async () => {
    const semAgendamento = await post("medico", "/api/tratamentos-externos", {
      idosoId: "p12", area: "medica", tipo: "Cateterismo", localExterno: "Hospital Regional", data: "2025-06-10",
      instituicao: "Hospital Regional (fictício)", profissionalNome: "Dr. Externo", observacoes: "Alta no mesmo dia.",
    });
    assert.equal(semAgendamento.status, 201);
    assert.equal(semAgendamento.body.idoso.id, "p12");
    assert.equal(semAgendamento.body.agendamentoId, null);
    assert.equal(semAgendamento.body.registradoPor.id, "s05");
    const deOutroIdoso = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p09", tipoId: await tipoPorNome("Avaliação multiprofissional"),
      profissionalId: await colaboradorPorNome("Dr. Paulo Ferraz Neto"), inicio: "2030-08-01T09:00:00-03:00",
    })).body.id;
    assert.equal((await post("medico", "/api/tratamentos-externos", {
      idosoId: "p12", agendamentoId: deOutroIdoso, area: "medica", tipo: "Exame", localExterno: "Clínica X", data: "2025-06-11",
    })).status, 422);
    assert.equal((await post("medico", "/api/tratamentos-externos", {
      idosoId: "p12", area: "medica", tipo: "Exame", localExterno: "Clínica X", data: "2030-01-01",
    })).status, 422);
    assert.equal((await put("medico", `/api/tratamentos-externos/${semAgendamento.body.id}`, {
      idosoId: "p13", area: "medica", tipo: "Cateterismo", localExterno: "Hospital Regional", data: "2025-06-10",
    })).status, 422);
  });

  it("leitura auditada e restrita", async () => {
    const antes = await leituraAuditada("tratamento_externo.ler", "s05", "p12");
    const lista = await get("medico", "/api/tratamentos-externos?idosoId=p12&area=medica");
    assert.equal(lista.status, 200);
    assert.ok(lista.body.data.every((t) => t.idoso.id === "p12" && t.area === "medica"));
    assert.equal(await leituraAuditada("tratamento_externo.ler", "s05", "p12"), antes + 1);
    assert.equal((await get("recepcao", "/api/tratamentos-externos")).status, 403);
  });
});

describe("grupo3 · pendências odontológicas do ciclo (US-089)", () => {
  before(async () => {
    const luciana = await colaboradorPorNome("Dra. Luciana Prado");
    await post("medico", "/api/tratamentos-externos", {
      idosoId: "p10", area: "odontologica", tipo: "Limpeza", localExterno: "CEO", data: "2025-08-10",
    });
    const consulta = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p14", tipoId: await tipoPorNome("Consulta odontológica"), profissionalId: luciana, local: "Consultório odontológico",
      inicio: "2025-09-15T14:00:00-03:00",
    })).body.id;
    await post("recepcao", `/api/agendamentos/${consulta}/realizacao`, { status: "realizado" });
    const registro = await post("odonto", `/api/agendamentos/${consulta}/registro-clinico`, { resumo: "Revisão semestral sem alterações.", finalizar: true });
    assert.equal(registro.body.status, "finalizado");
  });

  it("semestre civil: aponta quem não tem registro no ciclo informado", async () => {
    const segundo = await get("gestor", "/api/odontologia/pendencias?ciclo=2025-2&limit=100");
    assert.equal(segundo.status, 200);
    assert.deepEqual(segundo.body.ciclo, { modo: "semestre_civil", rotulo: "2025-2", inicio: "2025-07-01", fim: "2025-12-31" });
    const pendentes = segundo.body.data.map((d) => d.idoso.id);
    assert.ok(!pendentes.includes("p10"));
    assert.ok(!pendentes.includes("p14"));
    assert.ok(pendentes.includes("p12"));
    assert.equal(segundo.body.resumo.comRegistroNoCiclo, 2);
    assert.equal(segundo.body.resumo.pendentes, segundo.body.resumo.totalIdosos - 2);
    const primeiro = await get("gestor", "/api/odontologia/pendencias?ciclo=2025-1&limit=100");
    assert.ok(primeiro.body.data.some((d) => d.idoso.id === "p10"));
    assert.equal((await get("gestor", "/api/odontologia/pendencias?ciclo=2025-3")).status, 422);
    assert.ok(await leituraAuditada("odontologia_pendencias.ler", "s02", "p12") >= 1);
  });

  it("dias corridos: janela configurável terminando na referência", async () => {
    assert.equal((await put("medico", "/api/odontologia/configuracao-ciclo", { modo: "dias_corridos", dias: 60 })).status, 403);
    const config = await put("gestor", "/api/odontologia/configuracao-ciclo", { modo: "dias_corridos", dias: 60 });
    assert.equal(config.status, 200);
    try {
      const janela = await get("gestor", "/api/odontologia/pendencias?referencia=2025-09-30&limit=100");
      assert.equal(janela.body.ciclo.inicio, "2025-08-02");
      assert.equal(janela.body.ciclo.fim, "2025-09-30");
      const ids = janela.body.data.map((d) => d.idoso.id);
      assert.ok(!ids.includes("p10") && !ids.includes("p14"));
      const curta = await get("gestor", "/api/odontologia/pendencias?referencia=2025-10-20&limit=100");
      assert.ok(curta.body.data.some((d) => d.idoso.id === "p10"));
      assert.equal((await get("gestor", "/api/odontologia/pendencias?ciclo=2025-2")).status, 422);
    } finally {
      await put("gestor", "/api/odontologia/configuracao-ciclo", { modo: "semestre_civil", dias: 180 });
    }
    assert.equal((await get("gestor", "/api/odontologia/configuracao-ciclo")).body.modo, "semestre_civil");
  });
});

describe("grupo3 · publicação no prontuário respeita evolucao.create", () => {
  let registroId;

  it("autor sem evolucao.create finaliza no G3 e a publicação fica aguardando permissão", async () => {
    const luciana = await colaboradorPorNome("Dra. Luciana Prado");
    const consulta = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p13", tipoId: await tipoPorNome("Consulta odontológica"), profissionalId: luciana, local: "Consultório odontológico",
      inicio: "2025-05-20T14:00:00-03:00",
    })).body.id;
    await post("recepcao", `/api/agendamentos/${consulta}/realizacao`, { status: "realizado" });
    const antes = (await get("medico", "/api/prontuarios/p13/evolucoes")).body.data.length;
    const registro = await post("odonto", `/api/agendamentos/${consulta}/registro-clinico`, {
      resumo: "Higiene oral adequada, sem cáries novas.", finalizar: true,
    });
    assert.equal(registro.status, 201);
    assert.equal(registro.body.status, "finalizado");
    assert.deepEqual(registro.body.publicacao, { status: "aguardando_permissao", prontuarioRef: null });
    registroId = registro.body.id;
    const adendo = await post("odonto", `/api/registros-clinicos/${registroId}/adendos`, { resumo: "Adendo: orientada troca da escova." });
    assert.equal(adendo.status, 201);
    assert.equal(adendo.body.adendos[0].publicacao.status, "aguardando_permissao");
    assert.equal((await get("medico", "/api/prontuarios/p13/evolucoes")).body.data.length, antes);
  });

  it("republicar exige administração e só publica quando o autor ganha a permissão", async () => {
    assert.equal((await post("medico", "/api/registros-clinicos/republicar-pendentes", {})).status, 403);
    const semPermissao = await post("gestor", "/api/registros-clinicos/republicar-pendentes", {});
    assert.equal(semPermissao.status, 200);
    assert.ok(semPermissao.body.aguardandoPermissao >= 2);
    assert.equal((await get("gestor", `/api/registros-clinicos/${registroId}`)).body.publicacao.status, "aguardando_permissao");

    const concedida = await request(app).patch("/api/usuarios/s07").set(await como("admin")).send({ profiles: ["odontologia", "medico"] });
    assert.equal(concedida.status, 200);
    assert.ok(concedida.body.user.permissions.includes("evolucao.create"));
    try {
      const republicado = await post("gestor", "/api/registros-clinicos/republicar-pendentes", {});
      assert.ok(republicado.body.publicados >= 2);
      const lido = await get("gestor", `/api/registros-clinicos/${registroId}`);
      assert.equal(lido.body.publicacao.status, "publicado");
      assert.equal(lido.body.adendos[0].publicacao.status, "publicado");
      const evolucoes = (await get("medico", "/api/prontuarios/p13/evolucoes")).body.data;
      const evolucao = evolucoes.find((e) => e.id === lido.body.publicacao.prontuarioRef);
      assert.ok(evolucao);
      assert.equal(evolucao.author_id ?? evolucao.authorId, "s07");
      const denovo = await post("gestor", "/api/registros-clinicos/republicar-pendentes", {});
      const total = (await get("medico", "/api/prontuarios/p13/evolucoes")).body.data.length;
      assert.equal(total, evolucoes.length);
      assert.equal(denovo.body.publicados, 0);
    } finally {
      await request(app).patch("/api/usuarios/s07").set(await como("admin")).send({ profiles: ["odontologia"] });
    }
  });
});

// ---------------- Fatia 5 ----------------

describe("grupo3 · fisioterapia (US-075 a US-080)", () => {
  let renata;
  let sessaoTipo;
  let plano;
  let planoPassado;
  let atividade;

  before(async () => {
    renata = await colaboradorPorNome("Renata Gouveia");
    sessaoTipo = await tipoPorNome("Sessão de fisioterapia");
  });

  const sessao = (perfil, extra) => post(perfil, "/api/agendamentos", {
    idosoId: "p15", tipoId: sessaoTipo, profissionalId: renata, ...extra,
  });

  it("US-075: plano com objetivo, período, frequência, observações e responsável; mais de um ativo por idoso", async () => {
    const criado = await post("fisio", "/api/fisioterapia/planos", {
      idosoId: "p15", responsavelId: renata, objetivo: "Fortalecer membros inferiores.", dataInicio: "2030-06-01",
      dataFim: "2030-06-30", frequenciaSemanal: 2, observacoes: "Evitar carga no joelho esquerdo.",
    });
    assert.equal(criado.status, 201);
    plano = criado.body.id;
    assert.equal(criado.body.situacao, "ativo");
    assert.equal(criado.body.vigente, false);
    assert.equal(criado.body.responsavel.nome, "Renata Gouveia");
    const segundo = await post("fisio", "/api/fisioterapia/planos", {
      idosoId: "p15", responsavelId: renata, objetivo: "Treino respiratório.", dataInicio: "2030-06-01", frequenciaSemanal: 1,
    });
    assert.equal(segundo.status, 201);
    const lista = await get("fisio", "/api/idosos/p15/planos-fisioterapia?situacao=ativo");
    assert.equal(lista.body.data.length, 2);
    assert.ok(await leituraAuditada("plano_fisioterapia.ler", "s06", "p15") >= 1);
    assert.equal((await post("fisio", "/api/fisioterapia/planos", {
      idosoId: "p15", responsavelId: renata, objetivo: "Período invertido.", dataInicio: "2030-06-10", dataFim: "2030-06-01", frequenciaSemanal: 1,
    })).status, 422);
    assert.equal((await post("recepcao", "/api/fisioterapia/planos", {
      idosoId: "p15", responsavelId: renata, objetivo: "Sem permissão.", dataInicio: "2030-06-01", frequenciaSemanal: 1,
    })).status, 403);
    assert.equal((await get("recepcao", `/api/fisioterapia/planos/${plano}`)).status, 403);
    assert.equal((await get("medico", `/api/fisioterapia/planos/${plano}`)).status, 200);
  });

  it("US-076: atividades com campos fixos e configuração flexível validada", async () => {
    const criada = await post("fisio", `/api/fisioterapia/planos/${plano}/atividades`, {
      descricao: "Agachamento assistido", frequenciaSemanal: 2, duracaoMin: 10, intensidade: "Moderada",
      configuracao: { series: 3, repeticoes: 10, apoio: "barra" },
    });
    assert.equal(criada.status, 201);
    atividade = criada.body.id;
    assert.equal(criada.body.configuracao.series, 3);
    assert.equal((await post("fisio", `/api/fisioterapia/planos/${plano}/atividades`, {
      descricao: "Configuração aninhada", configuracao: { carga: { kg: 2 } },
    })).status, 422);
    const inativa = await put("fisio", `/api/fisioterapia/atividades/${criada.body.id}`, {
      descricao: "Agachamento assistido", configuracao: { series: 2 }, ativa: true,
    });
    assert.equal(inativa.status, 200);
    assert.equal(inativa.body.configuracao.series, 2);
    const detalhe = await get("fisio", `/api/fisioterapia/planos/${plano}`);
    assert.equal(detalhe.body.atividades.length, 1);
  });

  it("sessão ligada ao plano; fora do período é aceita com aviso; plano de outro idoso ou inativo recusado", async () => {
    const dentro = await sessao("recepcao", { inicio: "2030-06-10T09:00:00-03:00", planoFisioterapiaId: plano });
    assert.equal(dentro.status, 201);
    assert.equal(dentro.body.planoFisioterapiaId, plano);
    assert.deepEqual(dentro.body.avisos, []);
    const fora = await sessao("recepcao", { inicio: "2030-07-10T09:00:00-03:00", planoFisioterapiaId: plano });
    assert.equal(fora.status, 201);
    assert.equal(fora.body.avisos[0].codigo, "fora_do_periodo_do_plano");
    const reagendada = await post("recepcao", `/api/agendamentos/${dentro.body.id}/reagendar`, { inicio: "2030-07-11T09:00:00-03:00" });
    assert.equal(reagendada.body.avisos[0].codigo, "fora_do_periodo_do_plano");
    assert.equal((await post("recepcao", "/api/agendamentos", {
      idosoId: "p16", tipoId: sessaoTipo, profissionalId: renata, inicio: "2030-06-11T09:00:00-03:00", planoFisioterapiaId: plano,
    })).status, 422);
    assert.equal((await sessao("recepcao", {
      tipoId: await tipoPorNome("Avaliação multiprofissional"), inicio: "2030-06-12T09:00:00-03:00", planoFisioterapiaId: plano,
    })).status, 422);
  });

  it("US-077: execução vinculada à sessão, uma por atividade e sessão", async () => {
    planoPassado = (await post("fisio", "/api/fisioterapia/planos", {
      idosoId: "p16", responsavelId: renata, objetivo: "Ganho de amplitude de ombro.", dataInicio: "2025-01-01", frequenciaSemanal: 2,
    })).body.id;
    const ativ = (await post("fisio", `/api/fisioterapia/planos/${planoPassado}/atividades`, { descricao: "Mobilização de ombro" })).body.id;
    const sessaoFeita = await post("recepcao", "/api/agendamentos", {
      idosoId: "p16", tipoId: sessaoTipo, profissionalId: renata, inicio: "2025-03-03T09:00:00-03:00", planoFisioterapiaId: planoPassado,
    });
    assert.equal(sessaoFeita.status, 201);
    const execucao = await post("fisio", `/api/fisioterapia/atividades/${ativ}/execucoes`, {
      agendamentoId: sessaoFeita.body.id, status: "parcial", observacoes: "Dor ao final.",
    });
    assert.equal(execucao.status, 201);
    assert.equal(execucao.body.profissional.nome, "Renata Gouveia");
    assert.equal(execucao.body.sessao.agendamentoId, sessaoFeita.body.id);
    assert.equal((await post("fisio", `/api/fisioterapia/atividades/${ativ}/execucoes`, { agendamentoId: sessaoFeita.body.id, status: "realizada" })).status, 409);
    assert.equal((await post("fisio", `/api/fisioterapia/atividades/${atividade}/execucoes`, { agendamentoId: sessaoFeita.body.id, status: "realizada" })).status, 422);
    const futura = await sessao("recepcao", { inicio: "2030-06-17T09:00:00-03:00", planoFisioterapiaId: plano });
    assert.equal((await post("fisio", `/api/fisioterapia/atividades/${atividade}/execucoes`, { agendamentoId: futura.body.id, status: "realizada" })).status, 422);
    const cancelada = await post("recepcao", "/api/agendamentos", {
      idosoId: "p16", tipoId: sessaoTipo, profissionalId: renata, inicio: "2025-03-05T09:00:00-03:00", planoFisioterapiaId: planoPassado,
    });
    await post("recepcao", `/api/agendamentos/${cancelada.body.id}/cancelar`, { motivo: "Idoso com febre" });
    const naCancelada = await post("fisio", `/api/fisioterapia/atividades/${ativ}/execucoes`, { agendamentoId: cancelada.body.id, status: "realizada" });
    assert.equal(naCancelada.status, 422);
    assert.match(naCancelada.body.error.details[0].message, /cancelada ou não realizada/);
    const naoRealizada = await post("recepcao", "/api/agendamentos", {
      idosoId: "p16", tipoId: sessaoTipo, profissionalId: renata, inicio: "2025-03-07T09:00:00-03:00", planoFisioterapiaId: planoPassado,
    });
    await post("recepcao", `/api/agendamentos/${naoRealizada.body.id}/realizacao`, { status: "nao_realizado", observacao: "Recusou" });
    assert.equal((await post("fisio", `/api/fisioterapia/atividades/${ativ}/execucoes`, { agendamentoId: naoRealizada.body.id, status: "realizada" })).status, 422);
    const realizada = await post("recepcao", "/api/agendamentos", {
      idosoId: "p16", tipoId: sessaoTipo, profissionalId: renata, inicio: "2025-03-10T09:00:00-03:00", planoFisioterapiaId: planoPassado,
    });
    await post("recepcao", `/api/agendamentos/${realizada.body.id}/realizacao`, { status: "realizado" });
    assert.equal((await post("fisio", `/api/fisioterapia/atividades/${ativ}/execucoes`, { agendamentoId: realizada.body.id, status: "realizada" })).status, 201);
    const daquiA = (minutos) => new Date(Date.now() + minutos * 60_000).toISOString();
    const outroFisio = (await post("gestor", "/api/colaboradores", { nome: "Fisioterapeuta de tolerância", vinculo: "funcionario" })).body.id;
    const naTolerancia = await post("recepcao", "/api/agendamentos", {
      idosoId: "p16", tipoId: sessaoTipo, profissionalId: outroFisio, inicio: daquiA(30), planoFisioterapiaId: planoPassado,
    });
    assert.equal(naTolerancia.status, 201);
    assert.equal((await post("fisio", `/api/fisioterapia/atividades/${ativ}/execucoes`, { agendamentoId: naTolerancia.body.id, status: "realizada" })).status, 201);
    const cedoDemais = await post("recepcao", "/api/agendamentos", {
      idosoId: "p16", tipoId: sessaoTipo, profissionalId: outroFisio, inicio: daquiA(300), planoFisioterapiaId: planoPassado,
    });
    assert.equal(cedoDemais.status, 201);
    assert.equal((await post("fisio", `/api/fisioterapia/atividades/${ativ}/execucoes`, { agendamentoId: cedoDemais.body.id, status: "realizada" })).status, 422);
    const lista = await get("fisio", `/api/fisioterapia/planos/${planoPassado}/execucoes?agendamentoId=${sessaoFeita.body.id}`);
    assert.equal(lista.body.data.length, 1);
    assert.equal(lista.body.data[0].status, "parcial");

    // Correção: só fisioterapia.administrar, com motivo, trilha imutável; UPDATE direto segue bloqueado.
    const execId = execucao.body.id;
    assert.equal((await post("fisio", `/api/fisioterapia/execucoes/${execId}/corrigir`, { status: "realizada", motivo: "Lançada errado" })).status, 403);
    assert.equal((await post("gestor", `/api/fisioterapia/execucoes/${execId}/corrigir`, { status: "realizada" })).status, 422);
    assert.equal((await post("gestor", `/api/fisioterapia/execucoes/${execId}/corrigir`, { status: "parcial", motivo: "Sem mudança" })).status, 422);
    const corrigida = await post("gestor", `/api/fisioterapia/execucoes/${execId}/corrigir`, { status: "realizada", observacoes: null, motivo: "Lançada como parcial por engano" });
    assert.equal(corrigida.status, 200);
    assert.equal(corrigida.body.status, "realizada");
    assert.equal(corrigida.body.observacoes, null);
    assert.equal(corrigida.body.correcoes.length, 1);
    assert.deepEqual(corrigida.body.correcoes[0].anterior, { status: "parcial", profissionalId: renata, observacoes: "Dor ao final." });
    assert.equal(corrigida.body.correcoes[0].novo.status, "realizada");
    assert.equal(corrigida.body.correcoes[0].autor.id, "s02");
    const lida = await get("fisio", `/api/fisioterapia/execucoes/${execId}`);
    assert.equal(lida.body.correcoes[0].motivo, "Lançada como parcial por engano");
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.execucao_atividade SET status = 'parcial' WHERE id = ${execId}::uuid`);
    await assert.rejects(prisma.$executeRaw`DELETE FROM grupo3.execucao_atividade WHERE id = ${execId}::uuid`);
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.correcao_execucao_atividade SET motivo = 'x' WHERE execucao_id = ${execId}::uuid`);
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('grupo3.correcao_execucao', 'on', true)`;
      await tx.$executeRaw`UPDATE grupo3.execucao_atividade SET registrado_em = now() WHERE id = ${execId}::uuid`;
    }));
  });

  it("US-078: evolução cronológica, imutável, publicada só com evolucao.create", async () => {
    const semPermissao = await post("fisio", `/api/fisioterapia/planos/${planoPassado}/evolucoes`, { texto: "Amplitude de flexão melhorou para 110 graus." });
    assert.equal(semPermissao.status, 201);
    assert.deepEqual(semPermissao.body.publicacao, { status: "aguardando_permissao", prontuarioRef: null });
    const comPermissao = await post("admin", `/api/fisioterapia/planos/${planoPassado}/evolucoes`, { texto: "Revisão do plano pela coordenação." });
    assert.equal(comPermissao.body.publicacao.status, "publicado");
    const evolucoes = (await get("medico", "/api/prontuarios/p16/evolucoes")).body.data;
    assert.ok(evolucoes.some((e) => e.id === comPermissao.body.publicacao.prontuarioRef && /^Evolução de fisioterapia/.test(e.title)));
    const linha = await get("fisio", `/api/fisioterapia/planos/${planoPassado}/evolucoes`);
    assert.deepEqual(linha.body.data.map((e) => e.id), [semPermissao.body.id, comPermissao.body.id]);
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.evolucao_fisioterapia SET texto = 'alterado' WHERE id = ${semPermissao.body.id}::uuid`);

    assert.equal((await post("fisio", "/api/fisioterapia/evolucoes/republicar-pendentes", {})).status, 403);
    await request(app).patch("/api/usuarios/s06").set(await como("admin")).send({ profiles: ["fisioterapia", "enfermagem"] });
    try {
      const republicado = await post("gestor", "/api/fisioterapia/evolucoes/republicar-pendentes", {});
      assert.ok(republicado.body.publicados >= 1);
      const depois = await get("fisio", `/api/fisioterapia/planos/${planoPassado}/evolucoes`);
      assert.equal(depois.body.data[0].publicacao.status, "publicado");
    } finally {
      await request(app).patch("/api/usuarios/s06").set(await como("admin")).send({ profiles: ["fisioterapia"] });
    }
  });

  it("US-079: programação semanal (tudo ou nada) e carga por dia só com agendado e realizado", async () => {
    const planoSemana = (await post("fisio", "/api/fisioterapia/planos", {
      idosoId: "p17", responsavelId: renata, objetivo: "Condicionamento geral.", dataInicio: "2030-09-01", dataFim: "2030-09-30", frequenciaSemanal: 2,
    })).body.id;
    const corpo = { semana: "2030-09-04", tipoId: sessaoTipo, sessoes: [{ diaSemana: 1, hora: "09:00" }, { diaSemana: 3, hora: "09:00" }] };
    const programada = await post("fisio", `/api/fisioterapia/planos/${planoSemana}/programar-semana`, corpo);
    assert.equal(programada.status, 201);
    assert.equal(programada.body.sessoes.length, 2);
    assert.ok(programada.body.sessoes.every((s) => s.planoFisioterapiaId === planoSemana && s.profissional.id === renata));
    assert.equal(new Date(programada.body.sessoes[0].inicio).toISOString(), "2030-09-02T12:00:00.000Z");
    const repetida = await post("fisio", `/api/fisioterapia/planos/${planoSemana}/programar-semana`, {
      ...corpo, sessoes: [{ diaSemana: 5, hora: "10:00" }, { diaSemana: 1, hora: "09:00" }],
    });
    assert.equal(repetida.status, 409);
    assert.equal(repetida.body.error.details.sessao, 1);
    assert.match(repetida.body.error.message, /^Sessão 2:/);

    let rotina = await get("fisio", `/api/fisioterapia/rotina-semanal?semana=2030-09-04&profissionalId=${renata}`);
    assert.equal(rotina.status, 200);
    assert.deepEqual(rotina.body.semana.inicio, "2030-09-02");
    assert.deepEqual(rotina.body.cargaPorDia.map((d) => d.sessoes), [1, 0, 1, 0, 0, 0, 0]);
    assert.equal(rotina.body.cargaPorDia[0].minutos, 40);
    await post("recepcao", `/api/agendamentos/${programada.body.sessoes[1].id}/cancelar`, { motivo: "Feriado" });
    rotina = await get("fisio", `/api/fisioterapia/rotina-semanal?semana=2030-09-04&profissionalId=${renata}`);
    assert.deepEqual(rotina.body.cargaPorDia.map((d) => d.sessoes), [1, 0, 0, 0, 0, 0, 0]);
    assert.equal(rotina.body.resumo.canceladas, 1);
    assert.equal(rotina.body.sessoes.length, 2);
    assert.equal((await get("recepcao", "/api/fisioterapia/rotina-semanal")).status, 403);
  });

  it("US-080: indicadores de planos ativos e sessões previstas x realizadas", async () => {
    const setembro = await get("gestor", "/api/fisioterapia/indicadores?inicio=2030-09-01&fim=2030-09-30");
    assert.equal(setembro.status, 200);
    assert.ok(setembro.body.planos.ativos >= 1);
    assert.ok(setembro.body.planos.idososEmFisioterapia >= 1);
    assert.equal(setembro.body.sessoes.previstas, 1);
    assert.equal(setembro.body.sessoes.canceladas, 1);
    const marco = await get("gestor", "/api/fisioterapia/indicadores?inicio=2025-03-01&fim=2025-03-31");
    assert.equal(marco.body.sessoes.previstas, 3);
    assert.equal(marco.body.sessoes.realizadas, 1);
    assert.equal(marco.body.sessoes.naoRealizadas, 1);
    assert.equal(marco.body.sessoes.canceladas, 1);
    assert.equal(marco.body.sessoes.taxaRealizacao, 50);
    const vazio = await get("gestor", "/api/fisioterapia/indicadores?inicio=2024-01-01&fim=2024-01-31");
    assert.equal(vazio.body.sessoes.taxaRealizacao, null);
    assert.equal((await get("recepcao", "/api/fisioterapia/indicadores")).status, 403);
  });
});

// ---------------- Fatia 6 ----------------

Object.assign(EMAILS, { tecnico: "joana.rocha@lardoirmaovelho.example" });

async function notificacoesDe(usuarioId, tipo) {
  return prisma.$queryRaw`SELECT id, title, body, link FROM public.notifications WHERE user_id = ${usuarioId} AND kind = ${tipo} ORDER BY at`;
}

describe("grupo3 · tarefas (US-094 a US-096)", () => {
  let renata;
  let tarefa;
  const daquiA = (horas) => new Date(Date.now() + horas * 3_600_000).toISOString();

  before(async () => {
    renata = await colaboradorPorNome("Renata Gouveia");
  });

  it("US-094: cria tarefa com responsável, prazo, prioridade, status e descrição", async () => {
    const criada = await post("enfermagem", "/api/tarefas", {
      titulo: "Organizar materiais da sala de fisioterapia", descricao: "Separar faixas elásticas por cor.",
      responsavelId: renata, prazo: daquiA(48), prioridade: "alta",
    });
    assert.equal(criada.status, 201);
    tarefa = criada.body.id;
    assert.equal(criada.body.status, "pendente");
    assert.equal(criada.body.prioridade, "alta");
    assert.equal(criada.body.atrasada, false);
    assert.equal(criada.body.responsavel.nome, "Renata Gouveia");
    assert.equal(criada.body.historico[0].statusNovo, "pendente");
    assert.equal((await post("recepcao", "/api/tarefas", { titulo: "Sem permissão", responsavelId: renata, prazo: daquiA(1) })).status, 403);
  });

  it("US-095: status pelo responsável ou por tarefas.administrar, com histórico imutável", async () => {
    assert.equal((await patch("tecnico", `/api/tarefas/${tarefa}/status`, { status: "em_andamento" })).status, 403);
    const andamento = await patch("fisio", `/api/tarefas/${tarefa}/status`, { status: "em_andamento", observacao: "Comecei hoje." });
    assert.equal(andamento.status, 200);
    assert.equal(andamento.body.status, "em_andamento");
    assert.equal((await patch("fisio", `/api/tarefas/${tarefa}/status`, { status: "em_andamento" })).status, 422);
    const concluida = await patch("gestor", `/api/tarefas/${tarefa}/status`, { status: "concluida" });
    assert.equal(concluida.status, 200);
    assert.ok(concluida.body.concluidaEm);
    assert.deepEqual(concluida.body.historico.map((h) => [h.statusAnterior, h.statusNovo, h.autor.id]), [
      [null, "pendente", "s03"], ["pendente", "em_andamento", "s06"], ["em_andamento", "concluida", "s02"],
    ]);
    assert.equal(concluida.body.historico[1].observacao, "Comecei hoje.");
    assert.equal((await patch("gestor", `/api/tarefas/${tarefa}/status`, { status: "pendente" })).status, 409);
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.historico_tarefa SET observacao = 'x' WHERE tarefa_id = ${tarefa}::uuid`);
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.tarefa SET titulo = 'x' WHERE id = ${tarefa}::uuid`);
    await assert.rejects(prisma.$executeRaw`DELETE FROM grupo3.tarefa WHERE id = ${tarefa}::uuid`);
  });

  it("reabrir: só tarefas.administrar, com motivo, e registra \"reaberta\" no histórico", async () => {
    const criada = await post("gestor", "/api/tarefas", { titulo: "Tarefa para reabrir", responsavelId: renata, prazo: daquiA(24) });
    const url = `/api/tarefas/${criada.body.id}/reabrir`;
    assert.equal((await post("gestor", url, { motivo: "Ainda aberta" })).status, 409);
    await patch("fisio", `/api/tarefas/${criada.body.id}/status`, { status: "concluida" });
    assert.equal((await post("fisio", url, { motivo: "Faltou etapa" })).status, 403);
    assert.equal((await post("enfermagem", url, { motivo: "Faltou etapa" })).status, 403);
    assert.equal((await post("gestor", url, {})).status, 422);
    assert.equal((await post("gestor", url, { motivo: "ok" })).status, 422);
    const reaberta = await post("gestor", url, { motivo: "Faltou conferir o segundo andar", prazo: daquiA(72) });
    assert.equal(reaberta.status, 200);
    assert.equal(reaberta.body.status, "pendente");
    assert.equal(reaberta.body.concluidaEm, null);
    const ultimo = reaberta.body.historico.at(-1);
    assert.equal(ultimo.evento, "reaberta");
    assert.equal(ultimo.statusAnterior, "concluida");
    assert.equal(ultimo.statusNovo, "pendente");
    assert.equal(ultimo.observacao, "Faltou conferir o segundo andar");
    assert.equal(ultimo.autor.id, "s02");
    assert.ok(ultimo.em);
    assert.deepEqual(reaberta.body.historico.map((h) => h.evento), ["criada", "status", "reaberta"]);
    await patch("fisio", `/api/tarefas/${criada.body.id}/status`, { status: "cancelada" });
    await assert.rejects(prisma.$executeRaw`UPDATE grupo3.tarefa SET status = 'pendente', concluida_em = NULL WHERE id = ${criada.body.id}::uuid`);
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('grupo3.reabertura_tarefa', 'on', true)`;
      await tx.$executeRaw`UPDATE grupo3.tarefa SET status = 'pendente', titulo = 'outro' WHERE id = ${criada.body.id}::uuid`;
    }));
  });

  it("só quem criou (ou a administração) edita os dados da tarefa", async () => {
    const outra = await post("enfermagem", "/api/tarefas", { titulo: "Revisar lista de chamada", responsavelId: renata, prazo: daquiA(24) });
    const corpo = { titulo: "Revisar lista de chamada (manhã)", responsavelId: renata, prazo: daquiA(30), prioridade: "baixa" };
    assert.equal((await put("medico", `/api/tarefas/${outra.body.id}`, corpo)).status, 403);
    const editada = await put("enfermagem", `/api/tarefas/${outra.body.id}`, corpo);
    assert.equal(editada.status, 200);
    assert.equal(editada.body.prioridade, "baixa");
    assert.equal((await put("gestor", `/api/tarefas/${outra.body.id}`, { ...corpo, prioridade: "urgente" })).body.prioridade, "urgente");
  });

  it("US-096: atrasada é derivada e filtrável; tarefa concluída não fica atrasada", async () => {
    const vencida = await post("gestor", "/api/tarefas", { titulo: "Entregar relatório de presença", responsavelId: renata, prazo: daquiA(-5) });
    assert.equal(vencida.body.atrasada, true);
    const atrasadas = await get("tecnico", "/api/tarefas?atrasadas=true&limit=100");
    assert.ok(atrasadas.body.data.every((t) => t.atrasada));
    assert.ok(atrasadas.body.data.some((t) => t.id === vencida.body.id));
    assert.ok(!atrasadas.body.data.some((t) => t.titulo === "Atualizar contatos dos voluntários"));
    const minhas = await get("fisio", "/api/me/tarefas?limit=100");
    assert.ok(minhas.body.data.every((t) => t.responsavel.id === renata));
    assert.ok(minhas.body.data.some((t) => t.id === vencida.body.id));
  });
});

describe("grupo3 · jobs de alerta sem repetição (T-008)", () => {
  it("tarefa atrasada: duas rodadas geram uma notificação só", async () => {
    const renata = await colaboradorPorNome("Renata Gouveia");
    const vencida = await post("gestor", "/api/tarefas", {
      titulo: "Tarefa vencida para alerta", responsavelId: renata, prazo: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const primeira = await processarTarefasAtrasadas();
    const segunda = await processarTarefasAtrasadas();
    assert.ok(primeira.notificadas >= 1);
    assert.equal(segunda.processados, 0);
    const avisos = (await notificacoesDe("s06", "tarefa")).filter((n) => n.link === `/tarefas/${vencida.body.id}`);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0].body, /Tarefa vencida para alerta/);
  });

  it("responsável sem usuário: avisa quem criou, uma vez; ao vincular usuário, avisa o responsável", async () => {
    const semLogin = (await post("gestor", "/api/colaboradores", { nome: "Responsável sem login", vinculo: "externo" })).body.id;
    const vencida = await post("enfermagem", "/api/tarefas", {
      titulo: "Tarefa de quem não tem login", responsavelId: semLogin, prazo: new Date(Date.now() - 7_200_000).toISOString(),
    });
    const link = `/tarefas/${vencida.body.id}`;
    const r1 = await processarTarefasAtrasadas();
    await processarTarefasAtrasadas();
    assert.ok(r1.notificadasAoCriador >= 1);
    const aoCriador = (await notificacoesDe("s03", "tarefa")).filter((n) => n.link === link);
    assert.equal(aoCriador.length, 1);
    assert.match(aoCriador[0].body, /não tem acesso ao sistema/);

    const vinculo = await put("gestor", `/api/colaboradores/${semLogin}`, { nome: "Responsável sem login", vinculo: "externo", usuarioId: "s12" });
    assert.equal(vinculo.status, 200);
    const r2 = await processarTarefasAtrasadas();
    const r3 = await processarTarefasAtrasadas();
    assert.ok(r2.notificadas >= 1);
    assert.equal(r3.processados, 0);
    assert.equal((await notificacoesDe("s12", "tarefa")).filter((n) => n.link === link).length, 1);
    assert.equal((await notificacoesDe("s03", "tarefa")).filter((n) => n.link === link).length, 1);

    const concluidaAntes = await post("enfermagem", "/api/tarefas", {
      titulo: "Concluída antes do vínculo", responsavelId: semLogin, prazo: new Date(Date.now() - 7_200_000).toISOString(),
    });
    await patch("gestor", `/api/tarefas/${concluidaAntes.body.id}/status`, { status: "concluida" });
    await processarTarefasAtrasadas();
    assert.equal((await notificacoesDe("s12", "tarefa")).filter((n) => n.link === `/tarefas/${concluidaAntes.body.id}`).length, 0);
  });

  it("pendência odontológica: resumo sem nomes, só para atendimento-clinico.administrar, uma vez por idoso no ciclo", async () => {
    const primeira = await processarPendenciasOdontologicas();
    const segunda = await processarPendenciasOdontologicas();
    assert.ok(primeira.idososNovos > 0);
    assert.equal(segunda.processados, 0);
    assert.equal(segunda.notificadas, 0);
    for (const usuario of ["s01", "s02"]) {
      const avisos = await notificacoesDe(usuario, "odontologia");
      assert.equal(avisos.length, 1, usuario);
      assert.match(avisos[0].body, /^\d+ idosos? sem avaliação odontológica no ciclo \d{4}-[12]$/);
      assert.match(avisos[0].link, /^\/odontologia\/pendencias\?ciclo=\d{4}-[12]$/);
    }
    assert.equal((await notificacoesDe("s05", "odontologia")).length, 0);
    assert.equal((await notificacoesDe("s07", "odontologia")).length, 0);
    const nomes = await prisma.$queryRaw`SELECT name FROM public.patients`;
    const texto = (await notificacoesDe("s01", "odontologia")).map((n) => `${n.title} ${n.body} ${n.link}`).join(" ");
    assert.ok(nomes.every(({ name }) => !texto.includes(name)));
    assert.ok(!/\bp\d{2}\b/.test(texto));
  });
});

describe("grupo3 · indicadores para o Grupo 5", () => {
  it("atendimentos: números agregados por status e categoria, sem dados de idoso", async () => {
    const resposta = await get("gestor", "/api/indicadores/atendimentos?inicio=2030-03-01&fim=2030-03-31");
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.periodo.fuso, "America/Sao_Paulo");
    assert.ok(resposta.body.total > 0);
    assert.equal(resposta.body.previstos, resposta.body.total - resposta.body.cancelados);
    assert.ok(resposta.body.porCategoria.length > 0);
    const texto = JSON.stringify(resposta.body);
    assert.ok(!/idoso/i.test(texto) && !/"p\d{2}"/.test(texto));
    const vazio = await get("gestor", "/api/indicadores/atendimentos?inicio=2020-01-01&fim=2020-01-31");
    assert.equal(vazio.body.total, 0);
    assert.equal(vazio.body.taxaRealizacao, null);
    assert.equal(vazio.body.taxaCancelamento, null);
    assert.equal((await get("gestor", "/api/indicadores/atendimentos?inicio=2030-03-10&fim=2030-03-01")).status, 422);
  });

  it("tarefas: abertas, atrasadas e conclusão no prazo", async () => {
    const resposta = await get("gestor", "/api/indicadores/tarefas");
    assert.equal(resposta.status, 200);
    assert.ok(resposta.body.agora.atrasadas >= 1);
    assert.ok(resposta.body.agora.abertas >= resposta.body.agora.atrasadas);
    assert.equal(resposta.body.agora.porPrioridade.length, 4);
    assert.ok(resposta.body.noPeriodo.concluidas >= 1);
    assert.equal(
      resposta.body.noPeriodo.taxaConclusaoNoPrazo,
      Math.round((resposta.body.noPeriodo.concluidasNoPrazo / resposta.body.noPeriodo.concluidas) * 1000) / 10,
    );
    const vazio = await get("gestor", "/api/indicadores/tarefas?inicio=2020-01-01&fim=2020-01-31");
    assert.equal(vazio.body.noPeriodo.concluidas, 0);
    assert.equal(vazio.body.noPeriodo.taxaConclusaoNoPrazo, null);
  });

  it("equipe: presença do dia e cobertura das escalas", async () => {
    const hoje = await get("gestor", "/api/indicadores/equipe");
    assert.equal(hoje.status, 200);
    assert.ok(hoje.body.colaboradoresAtivos > 0);
    assert.ok(hoje.body.presentesNoDia >= 1);
    assert.equal(hoje.body.porVinculo.length, 3);
    const semEscala = await get("gestor", "/api/indicadores/equipe?data=2020-01-01");
    assert.equal(semEscala.body.escalasNoDia, 0);
    assert.equal(semEscala.body.taxaPresencaEscala, null);
  });

  it("leitura com a permissão proposta (modulo.dashboard)", async () => {
    for (const rota of ["atendimentos", "tarefas", "equipe"]) {
      assert.equal((await get("recepcao", `/api/indicadores/${rota}`)).status, 403, rota);
      assert.equal((await get("admin", `/api/indicadores/${rota}`)).status, 200, rota);
    }
  });
});

// ---------------- Fatia 7 ----------------

describe("grupo3 · relatório de evolução da fisioterapia (US-081)", () => {
  let plano;

  before(async () => {
    const renata = await colaboradorPorNome("Renata Gouveia");
    const sessaoTipo = await tipoPorNome("Sessão de fisioterapia");
    plano = (await post("fisio", "/api/fisioterapia/planos", {
      idosoId: "p18", responsavelId: renata, objetivo: "Reabilitação pós-queda.", dataInicio: "2025-04-01", frequenciaSemanal: 3,
    })).body.id;
    const atividade = (await post("fisio", `/api/fisioterapia/planos/${plano}/atividades`, { descricao: "Treino de transferência" })).body.id;
    const sessao = async (inicio) => (await post("recepcao", "/api/agendamentos", {
      idosoId: "p18", tipoId: sessaoTipo, profissionalId: renata, inicio, planoFisioterapiaId: plano,
    })).body.id;
    const feita = await sessao("2025-04-07T09:00:00-03:00");
    await post("recepcao", `/api/agendamentos/${feita}/realizacao`, { status: "realizado" });
    await post("fisio", `/api/fisioterapia/atividades/${atividade}/execucoes`, { agendamentoId: feita, status: "realizada" });
    const faltou = await sessao("2025-04-09T09:00:00-03:00");
    await post("recepcao", `/api/agendamentos/${faltou}/realizacao`, { status: "nao_realizado", observacao: "Recusou" });
    const cancelada = await sessao("2025-04-11T09:00:00-03:00");
    await post("recepcao", `/api/agendamentos/${cancelada}/cancelar`, { motivo: "Consulta externa no horário" });
    await post("fisio", `/api/fisioterapia/planos/${plano}/evolucoes`, { texto: "Transferência cama-cadeira com supervisão." });
  });

  it("consolida plano, atividades, sessões e evoluções no período", async () => {
    const abril = await get("fisio", `/api/fisioterapia/relatorios/evolucao?inicio=2025-04-01&fim=2025-04-30&idosoId=p18`);
    assert.equal(abril.status, 200);
    assert.deepEqual(abril.body.periodo, { inicio: "2025-04-01", fim: "2025-04-30" });
    const item = abril.body.data.find((d) => d.plano.id === plano);
    assert.equal(item.idoso.id, "p18");
    assert.deepEqual(item.sessoes, { total: 3, agendadas: 0, realizadas: 1, naoRealizadas: 1, canceladas: 1, taxaRealizacao: 50 });
    assert.equal(item.atividades[0].execucoes.realizada, 1);
    assert.equal(item.atividades[0].execucoes.total, 1);
    assert.deepEqual(item.evolucoes, []);
    const agora = await get("fisio", `/api/fisioterapia/relatorios/evolucao?planoId=${plano}`);
    const atual = agora.body.data[0];
    assert.equal(atual.sessoes.total, 0);
    assert.equal(atual.sessoes.taxaRealizacao, null);
    assert.equal(atual.evolucoes.length, 1);
    assert.equal(atual.evolucoes[0].autor.id, "s06");
  });

  it("período máximo de 12 meses, permissão e leitura auditada", async () => {
    assert.equal((await get("fisio", "/api/fisioterapia/relatorios/evolucao?inicio=2025-01-01&fim=2025-12-31&idosoId=p18")).status, 200);
    assert.equal((await get("fisio", "/api/fisioterapia/relatorios/evolucao?inicio=2025-01-01&fim=2026-01-01&idosoId=p18")).status, 422);
    assert.equal((await get("recepcao", "/api/fisioterapia/relatorios/evolucao")).status, 403);
    assert.ok(await leituraAuditada("relatorio_fisioterapia.ler", "s06", "p18") >= 1);
  });
});

describe("grupo3 · relatório de consultas e tratamentos (US-090)", () => {
  let paulo;

  before(async () => {
    paulo = await colaboradorPorNome("Dr. Paulo Ferraz Neto");
    const luciana = await colaboradorPorNome("Dra. Luciana Prado");
    const medica = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p19", tipoId: await tipoPorNome("Consulta médica"), profissionalId: paulo, local: "Consultório 1",
      inicio: "2025-05-05T09:00:00-03:00",
    })).body.id;
    await post("recepcao", `/api/agendamentos/${medica}/realizacao`, { status: "realizado" });
    await post("medico", `/api/agendamentos/${medica}/registro-clinico`, { resumo: "Pressão controlada com a medicação atual.", finalizar: true });
    const odonto = (await post("recepcao", "/api/agendamentos", {
      idosoId: "p19", tipoId: await tipoPorNome("Consulta odontológica"), profissionalId: luciana, local: "Consultório odontológico",
      inicio: "2025-05-06T14:00:00-03:00",
    })).body.id;
    await post("recepcao", `/api/agendamentos/${odonto}/cancelar`, { motivo: "Idoso internado" });
    await post("medico", "/api/tratamentos-externos", {
      idosoId: "p19", area: "odontologica", tipo: "Restauração", localExterno: "CEO", data: "2025-05-10", observacoes: "Dente 36.",
    });
  });

  const url = (extra = "") => `/api/relatorios/consultas-tratamentos?inicio=2025-05-01&fim=2025-05-31&idosoId=p19${extra}`;

  it("por padrão só metadados (data, idoso, profissional, tipo, status)", async () => {
    const resposta = await get("gestor", url());
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.data.length, 3);
    assert.deepEqual(resposta.body.resumo, { consultas: 2, tratamentosExternos: 1, porStatus: { realizado: 2, cancelado: 1 } });
    for (const item of resposta.body.data) {
      assert.deepEqual(Object.keys(item).sort(), ["area", "data", "id", "idoso", "origem", "profissional", "status", "tipo"]);
    }
    const texto = JSON.stringify(resposta.body);
    assert.ok(!texto.includes("Pressão controlada") && !texto.includes("Dente 36"));
  });

  it("conteúdo clínico só com atendimento-clinico.visualizar e pedido explícito", async () => {
    const comConteudo = await get("odonto", url("&incluirConteudo=true"));
    assert.equal(comConteudo.status, 200);
    const consulta = comConteudo.body.data.find((d) => d.origem === "consulta" && d.status === "realizado");
    assert.equal(consulta.conteudo.registroClinico.resumo, "Pressão controlada com a medicação atual.");
    const tratamento = comConteudo.body.data.find((d) => d.origem === "tratamento_externo");
    assert.equal(tratamento.conteudo.observacoes, "Dente 36.");
    assert.equal((await get("recepcao", url())).status, 403);
    assert.equal((await get("fisio", url())).status, 403);
  });

  it("filtros por área, profissional e status; tratamento externo não tem profissional cadastrado", async () => {
    const odonto = await get("gestor", url("&area=odontologica"));
    assert.equal(odonto.body.data.length, 2);
    assert.ok(odonto.body.data.every((d) => d.area === "odontologica"));
    const doPaulo = await get("gestor", url(`&profissionalId=${paulo}`));
    assert.deepEqual(doPaulo.body.data.map((d) => [d.origem, d.profissional.nome]), [["consulta", "Dr. Paulo Ferraz Neto"]]);
    const canceladas = await get("gestor", url("&status=cancelado"));
    assert.deepEqual(canceladas.body.data.map((d) => d.tipo), ["Consulta odontológica"]);
  });

  it("período máximo de 12 meses e leitura auditada", async () => {
    assert.equal((await get("gestor", "/api/relatorios/consultas-tratamentos?inicio=2024-06-01&fim=2025-06-01")).status, 422);
    assert.equal((await get("gestor", "/api/relatorios/consultas-tratamentos?inicio=2024-06-02&fim=2025-06-01")).status, 200);
    assert.ok(await leituraAuditada("relatorio_consultas_tratamentos.ler", "s02", "p19") >= 1);
  });
});

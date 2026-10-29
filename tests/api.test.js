import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { prepare, shutdown } from "./prepare.js";

const password = "Sislar@2026";

async function token(email, senha = password) {
  const response = await request(app).post("/api/auth/login").send({ email, password: senha });
  assert.equal(response.status, 200);
  return response.body.token;
}

function auth(value) {
  return { Authorization: `Bearer ${value}` };
}

before(async () => {
  await prepare();
});

after(async () => {
  await shutdown();
});

describe("autenticação", () => {
  it("responde saúde do banco", async () => {
    const response = await request(app).get("/api/health");
    assert.equal(response.status, 200);
    assert.equal(response.body.database, "up");
  });

  it("publica a documentação OpenAPI", async () => {
    const spec = await request(app).get("/api/openapi.json");
    const docs = await request(app).get("/api/docs/");
    assert.equal(spec.status, 200);
    assert.equal(spec.body.openapi, "3.0.3");
    assert.equal(spec.body.paths["/api/auth/login"].post.summary, "Entrar");
    assert.equal(spec.body.paths["/api/visitas/{id}/saida"].patch.summary, "Registrar saída da visita");
    assert.equal(docs.status, 200);
    assert.match(docs.headers["content-type"], /html/);
    assert.match(docs.text, /SISLAR API/);
  });

  it("rejeita JSON quebrado", async () => {
    const response = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{");
    assert.equal(response.status, 400);
  });

  it("rejeita e-mail vazio e senha vazia", async () => {
    const response = await request(app).post("/api/auth/login").send({ email: "nao-e-email", password: "" });
    assert.equal(response.status, 422);
  });

  it("não revela se o e-mail existe", async () => {
    const unknown = await request(app).post("/api/auth/login").send({ email: "ninguem@lardoirmaovelho.example", password: "senha-qualquer" });
    const wrong = await request(app).post("/api/auth/login").send({ email: "marta.lima@lardoirmaovelho.example", password: "errada" });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.error.message, wrong.body.error.message);
  });

  it("entra e devolve o perfil sem a senha", async () => {
    const response = await request(app).post("/api/auth/login").send({ email: "marta.lima@lardoirmaovelho.example", password });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.passwordHash, undefined);
    assert.ok(response.body.user.permissions.includes("usuarios.manage"));
    const me = await request(app).get("/api/auth/eu").set(auth(response.body.token));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "marta.lima@lardoirmaovelho.example");
  });

  it("recusa rota sem token", async () => {
    const response = await request(app).get("/api/prontuarios");
    assert.equal(response.status, 401);
  });

  it("redefine a senha uma única vez", async () => {
    const asked = await request(app).post("/api/auth/recuperar-senha").send({ email: "helena.duarte@lardoirmaovelho.example" });
    assert.equal(asked.status, 200);
    assert.ok(asked.body.resetToken);
    const next = "NovaSenha@1";
    const changed = await request(app).post("/api/auth/redefinir-senha").send({ token: asked.body.resetToken, password: next });
    assert.equal(changed.status, 200);
    const again = await request(app).post("/api/auth/redefinir-senha").send({ token: asked.body.resetToken, password: "OutraSenha@2" });
    assert.equal(again.status, 400);
    const login = await request(app).post("/api/auth/login").send({ email: "helena.duarte@lardoirmaovelho.example", password: next });
    assert.equal(login.status, 200);
    const restored = await request(app).patch("/api/perfil/senha").set(auth(login.body.token)).send({ currentPassword: next, password });
    assert.equal(restored.status, 200);
  });

  it("não confirma e-mail desconhecido na recuperação", async () => {
    const response = await request(app).post("/api/auth/recuperar-senha").send({ email: "ausente@lardoirmaovelho.example" });
    assert.equal(response.status, 200);
    assert.equal(response.body.resetToken, undefined);
  });
});

describe("usuários e permissões", () => {
  it("voluntário não abre prontuário", async () => {
    const voluntario = await token("helena.duarte@lardoirmaovelho.example");
    const response = await request(app).get("/api/prontuarios").set(auth(voluntario));
    assert.equal(response.status, 403);
  });

  it("bloqueia o próprio acesso e rejeita e-mail duplicado", async () => {
    const admin = await token("marta.lima@lardoirmaovelho.example");
    const self = await request(app).patch("/api/usuarios/s01").set(auth(admin)).send({ active: false });
    assert.equal(self.status, 422);
    const created = await request(app).post("/api/usuarios").set(auth(admin)).send({
      name: "Usuário de Teste",
      email: "teste.bloqueio@lardoirmaovelho.example",
      password: "Teste@123",
      roleLabel: "Apoio",
      sector: "Administração",
      profiles: ["recepcao"],
    });
    assert.equal(created.status, 201);
    const duplicate = await request(app).post("/api/usuarios").set(auth(admin)).send({
      name: "Outro",
      email: "teste.bloqueio@lardoirmaovelho.example",
      password: "Teste@123",
      roleLabel: "Apoio",
      sector: "Administração",
      profiles: ["recepcao"],
    });
    assert.equal(duplicate.status, 409);
    const blocked = await request(app).patch(`/api/usuarios/${created.body.user.id}`).set(auth(admin)).send({ active: false });
    assert.equal(blocked.status, 200);
    const login = await request(app).post("/api/auth/login").send({ email: "teste.bloqueio@lardoirmaovelho.example", password: "Teste@123" });
    assert.equal(login.status, 403);
    const wrong = await request(app).post("/api/auth/login").send({ email: "teste.bloqueio@lardoirmaovelho.example", password: "nao-confere" });
    assert.equal(wrong.status, 401);
  });

  it("rejeita página e limite fora da faixa", async () => {
    const admin = await token("marta.lima@lardoirmaovelho.example");
    const zero = await request(app).get("/api/prontuarios?page=0").set(auth(admin));
    const huge = await request(app).get("/api/prontuarios?limit=101").set(auth(admin));
    const far = await request(app).get("/api/prontuarios?page=9999").set(auth(admin));
    assert.equal(zero.status, 422);
    assert.equal(huge.status, 422);
    assert.equal(far.status, 200);
    assert.deepEqual(far.body.data, []);
  });
});

describe("prontuário", () => {
  it("não deixa a busca virar SQL", async () => {
    const enfermagem = await token("carla.nunes@lardoirmaovelho.example");
    const response = await request(app).get("/api/prontuarios").query({ q: "%' OR 1=1 --" }).set(auth(enfermagem));
    assert.equal(response.status, 200);
    assert.equal(response.body.meta.total, 0);
  });

  it("preserva o texto anterior na correção e trava o rascunho finalizado", async () => {
    const enfermagem = await token("carla.nunes@lardoirmaovelho.example");
    const tecnico = await token("joana.rocha@lardoirmaovelho.example");
    const created = await request(app).post("/api/prontuarios/p01/evolucoes").set(auth(enfermagem)).send({
      type: "rotina",
      title: "Plantão de teste",
      description: "Texto original da evolução de teste.",
      status: "rascunho",
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const patched = await request(app).patch(`/api/prontuarios/p01/evolucoes/${id}`).set(auth(enfermagem)).send({
      description: "Texto do rascunho antes de fechar.",
    });
    assert.equal(patched.status, 200);
    const closed = await request(app).post(`/api/prontuarios/p01/evolucoes/${id}/finalizar`).set(auth(enfermagem));
    assert.equal(closed.status, 200);
    const locked = await request(app).patch(`/api/prontuarios/p01/evolucoes/${id}`).set(auth(enfermagem)).send({
      description: "Tentativa indevida de apagar o texto.",
    });
    assert.equal(locked.status, 409);
    const denied = await request(app).post(`/api/prontuarios/p01/evolucoes/${id}/corrigir`).set(auth(tecnico)).send({
      reason: "Tentativa sem permissão",
      description: "Não deveria gravar.",
    });
    assert.equal(denied.status, 403);
    const corrected = await request(app).post(`/api/prontuarios/p01/evolucoes/${id}/corrigir`).set(auth(enfermagem)).send({
      reason: "Horário da refeição informado incorretamente.",
      description: "Texto corrigido da evolução de teste.",
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.description, "Texto corrigido da evolução de teste.");
    const history = await request(app).get(`/api/prontuarios/p01/evolucoes/${id}/correcoes`).set(auth(enfermagem));
    assert.equal(history.status, 200);
    assert.equal(history.body.data[0].previousDescription, "Texto do rascunho antes de fechar.");
    const future = await request(app).post("/api/prontuarios/p01/evolucoes").set(auth(enfermagem)).send({
      type: "rotina",
      title: "Futuro",
      description: "Não pode registrar evolução no futuro.",
      at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(future.status, 422);
  });

  it("valida bordas de pressão e glicemia", async () => {
    const tecnico = await token("joana.rocha@lardoirmaovelho.example");
    const equal = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "pa", systolic: 120, diastolic: 120, pulse: 70, context: "Repouso",
    });
    const inverted = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "pa", systolic: 90, diastolic: 140, pulse: 70, context: "Repouso",
    });
    const mixed = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "glicemia", glucose: 110, systolic: 120, context: "Jejum",
    });
    const low = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "glicemia", glucose: 19, context: "Jejum",
    });
    const high = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "glicemia", glucose: 601, context: "Jejum",
    });
    const text = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "glicemia", glucose: "110", context: "Jejum",
    });
    const min = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "glicemia", glucose: 20, context: "Jejum",
    });
    const max = await request(app).post("/api/prontuarios/p01/sinais-vitais").set(auth(tecnico)).send({
      kind: "glicemia", glucose: 600, context: "Jejum",
    });
    assert.equal(equal.status, 422);
    assert.equal(inverted.status, 422);
    assert.equal(mixed.status, 422);
    assert.equal(low.status, 422);
    assert.equal(high.status, 422);
    assert.equal(text.status, 422);
    assert.equal(min.status, 201);
    assert.equal(min.body.glucose, 20);
    assert.equal(min.body.systolic, null);
    assert.equal(max.status, 201);
  });

  it("técnico não encerra ocorrência nem baixa documento", async () => {
    const enfermagem = await token("carla.nunes@lardoirmaovelho.example");
    const tecnico = await token("joana.rocha@lardoirmaovelho.example");
    const created = await request(app).post("/api/prontuarios/p01/ocorrencias").set(auth(tecnico)).send({
      category: "Comportamento",
      title: "Agitação no teste",
      description: "Morador inquieto no fim da tarde durante o teste.",
      responsibleId: "s03",
    });
    assert.equal(created.status, 201);
    const denied = await request(app).post(`/api/prontuarios/p01/ocorrencias/${created.body.id}/encerrar`).set(auth(tecnico)).send({
      text: "Técnico não encerra.",
    });
    assert.equal(denied.status, 403);
    const closed = await request(app).post(`/api/prontuarios/p01/ocorrencias/${created.body.id}/encerrar`).set(auth(enfermagem)).send({
      text: "Sem novas queixas no plantão seguinte.",
    });
    assert.equal(closed.status, 200);
    const twice = await request(app).post(`/api/prontuarios/p01/ocorrencias/${created.body.id}/encerrar`).set(auth(enfermagem)).send({
      text: "Segunda tentativa.",
    });
    assert.equal(twice.status, 409);
    const uploadDenied = await request(app).post("/api/prontuarios/p01/documentos").set(auth(tecnico)).attach("arquivo", Buffer.from("%PDF-1.4"), { filename: "exame.pdf", contentType: "application/pdf" }).field("type", "Exame laboratorial");
    assert.equal(uploadDenied.status, 403);
    const missing = await request(app).post("/api/prontuarios/p01/documentos").set(auth(enfermagem)).field("type", "Exame laboratorial");
    assert.equal(missing.status, 422);
    const uploaded = await request(app).post("/api/prontuarios/p01/documentos").set(auth(enfermagem)).attach("arquivo", Buffer.from("%PDF-1.4"), { filename: "exame.pdf", contentType: "application/pdf" }).field("type", "Exame laboratorial");
    assert.equal(uploaded.status, 201);
    const download = await request(app).get(`/api/prontuarios/p01/documentos/${uploaded.body.id}/download`).set(auth(tecnico));
    assert.equal(download.status, 403);
    const ok = await request(app).get(`/api/prontuarios/p01/documentos/${uploaded.body.id}/download`).set(auth(enfermagem));
    assert.equal(ok.status, 200);
  });
});

describe("estoque, farmácia e temperatura", () => {
  it("não deixa a saída estourar o saldo", async () => {
    const estoque = await token("sergio.camargo@lardoirmaovelho.example");
    const item = await request(app).post("/api/estoque/itens").set(auth(estoque)).send({
      name: "Item de teste", category: "Teste", unit: "un", minQty: 1, location: "Teste", qty: 2,
    });
    assert.equal(item.status, 201);
    const zero = await request(app).post("/api/estoque/movimentacoes").set(auth(estoque)).send({
      itemId: item.body.id, type: "saida", qty: 0, reason: "Quantidade nula",
    });
    const exact = await request(app).post("/api/estoque/movimentacoes").set(auth(estoque)).send({
      itemId: item.body.id, type: "saida", qty: 2, reason: "Consumo do teste",
    });
    const over = await request(app).post("/api/estoque/movimentacoes").set(auth(estoque)).send({
      itemId: item.body.id, type: "saida", qty: 1, reason: "Acima do saldo",
    });
    assert.equal(zero.status, 422);
    assert.equal(exact.status, 201);
    assert.equal(exact.body.balanceAfter, 0);
    assert.equal(over.status, 422);
  });

  it("separa solicitar, aprovar e receber", async () => {
    const enfermagem = await token("carla.nunes@lardoirmaovelho.example");
    const gestor = await token("ricardo.teixeira@lardoirmaovelho.example");
    const estoque = await token("sergio.camargo@lardoirmaovelho.example");
    const invalid = await request(app).post("/api/estoque/reposicoes").set(auth(enfermagem)).send({ itemId: "st01", qty: 0 });
    assert.equal(invalid.status, 422);
    const asked = await request(app).post("/api/estoque/reposicoes").set(auth(enfermagem)).send({ itemId: "st01", qty: 5, notes: "Teste" });
    assert.equal(asked.status, 201);
    const denied = await request(app).post(`/api/estoque/reposicoes/${asked.body.id}/aprovar`).set(auth(enfermagem));
    assert.equal(denied.status, 403);
    const early = await request(app).post(`/api/estoque/reposicoes/${asked.body.id}/receber`).set(auth(estoque));
    assert.equal(early.status, 409);
    const approved = await request(app).post(`/api/estoque/reposicoes/${asked.body.id}/aprovar`).set(auth(gestor));
    assert.equal(approved.status, 200);
    const twice = await request(app).post(`/api/estoque/reposicoes/${asked.body.id}/aprovar`).set(auth(gestor));
    assert.equal(twice.status, 409);
    const received = await request(app).post(`/api/estoque/reposicoes/${asked.body.id}/receber`).set(auth(estoque));
    assert.equal(received.status, 200);
    assert.equal(received.body.status, "recebida");
  });

  it("recusa lote vencido e aceita lote vigente", async () => {
    const farmacia = await token("tiago.menezes@lardoirmaovelho.example");
    const expired = await request(app).post("/api/farmacia/dispensacoes").set(auth(farmacia)).send({ lotId: "m04a", qty: 1, patientId: "p01" });
    const ok = await request(app).post("/api/farmacia/dispensacoes").set(auth(farmacia)).send({ lotId: "m01b", qty: 1, patientId: "p01" });
    const over = await request(app).post("/api/farmacia/dispensacoes").set(auth(farmacia)).send({ lotId: "m01b", qty: 100000 });
    assert.equal(expired.status, 422);
    assert.equal(ok.status, 201);
    assert.equal(over.status, 422);
  });

  it("abre alerta só fora da faixa do equipamento", async () => {
    const enfermagem = await token("carla.nunes@lardoirmaovelho.example");
    const edge = await request(app).post("/api/temperatura/leituras").set(auth(enfermagem)).send({ equipmentId: "eq01", sensorId: "sn01", value: 8 });
    const above = await request(app).post("/api/temperatura/leituras").set(auth(enfermagem)).send({ equipmentId: "eq01", sensorId: "sn01", value: 8.1 });
    const below = await request(app).post("/api/temperatura/leituras").set(auth(enfermagem)).send({ equipmentId: "eq01", sensorId: "sn01", value: 1.9 });
    const absurd = await request(app).post("/api/temperatura/leituras").set(auth(enfermagem)).send({ equipmentId: "eq01", value: -51 });
    const wrongSensor = await request(app).post("/api/temperatura/leituras").set(auth(enfermagem)).send({ equipmentId: "eq01", sensorId: "sn02", value: 4 });
    assert.equal(edge.status, 201);
    assert.equal(edge.body.alert, null);
    assert.equal(above.status, 201);
    assert.equal(above.body.alert.kind, "acima");
    assert.equal(below.status, 201);
    assert.equal(below.body.alert.kind, "abaixo");
    assert.equal(absurd.status, 422);
    assert.equal(wrongSensor.status, 422);
  });
});

describe("importação", () => {
  it("recusa cabeçalho, arquivo e linhas inválidas", async () => {
    const estoque = await token("sergio.camargo@lardoirmaovelho.example");
    const header = await request(app).post("/api/importacoes").set(auth(estoque)).attach("arquivo", Buffer.from("a,b\n1,2\n"), { filename: "ruim.csv", contentType: "text/csv" });
    const ext = await request(app).post("/api/importacoes").set(auth(estoque)).attach("arquivo", Buffer.from("nome;sexo\n"), { filename: "planilha.txt", contentType: "text/plain" });
    const none = await request(app).post("/api/importacoes").set(auth(estoque)).attach("arquivo", Buffer.from("nome;sexo;nascimento;ala;quarto;leito\n;X;ontem;;;\n"), { filename: "vazio.csv", contentType: "text/csv" });
    const mixed = await request(app).post("/api/importacoes").set(auth(estoque)).attach("arquivo", Buffer.from("nome;sexo;nascimento;ala;quarto;leito\nAna Teste da Silva;F;1940-01-02;Ala Ipê;901;A\n;X;2099-01-01;Ala;1;C\n"), { filename: "misto.csv", contentType: "text/csv" });
    assert.equal(header.status, 422);
    assert.equal(ext.status, 422);
    assert.equal(none.status, 422);
    assert.equal(mixed.status, 201);
    assert.equal(mixed.body.created, 1);
    assert.equal(mixed.body.errors.length, 1);
  });
});

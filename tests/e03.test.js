import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { prepare, shutdown } from "./prepare.js";

const password = "Sislar@2026";
const route = "/api/prontuarios/p01";

async function login(email) {
  const response = await request(app).post("/api/auth/login").send({ email, password });
  assert.equal(response.status, 200);
  return { Authorization: `Bearer ${response.body.token}` };
}

before(async () => { await prepare(); });
after(async () => { await shutdown(); });

describe("E03 prontuário e enfermagem", () => {
  it("grava dados clínicos estruturados e oculta a seção de perfis sem acesso", async () => {
    const nurse = await login("carla.nunes@lardoirmaovelho.example");
    const pharmacy = await login("tiago.menezes@lardoirmaovelho.example");
    const payload = { sections: [{ id: "avaliacao", title: "Avaliação", fields: [
      { label: "Alergias", value: "Penicilina" },
      { label: "Mobilidade", value: "Com apoio" },
    ] }] };
    const invalid = await request(app).put(`${route}/dados-clinicos`).set(nurse).send({
      sections: [{ id: "avaliacao", title: "Avaliação", fields: [
        { label: "Alergias", value: "Penicilina" }, { label: "Alergias", value: "Outra" },
      ] }],
    });
    assert.equal(invalid.status, 422);
    const saved = await request(app).put(`${route}/dados-clinicos`).set(nurse).send(payload);
    assert.equal(saved.status, 200);
    const clinical = await request(app).get(`${route}/dados-clinicos`).set(nurse);
    assert.equal(clinical.status, 200);
    assert.deepEqual(clinical.body.sections, payload.sections);
    const denied = await request(app).get(`${route}/dados-clinicos`).set(pharmacy);
    assert.equal(denied.status, 403);
    const full = await request(app).get(`${route}/completo`).set(nurse);
    assert.equal(full.status, 200);
    assert.deepEqual(full.body.sections.dadosClinicos, payload.sections);
    assert.ok(Array.isArray(full.body.sections.evolucoes));
    const limited = await request(app).get(`${route}/completo`).set(pharmacy);
    assert.equal(limited.status, 200);
    assert.equal(limited.body.sections.dadosClinicos, undefined);
    assert.ok(Array.isArray(limited.body.sections.sinaisVitais));
    const summary = await request(app).get(route).set(pharmacy);
    assert.equal(summary.body.careData, undefined);
    const logged = await prisma.audit_log.findFirst({ where: { entity: "dados_clinicos", entity_id: "p01", action: "atualizar" } });
    assert.ok(logged);
    assert.deepEqual(logged.payload.current, payload.sections);
    const history = await request(app).get(`${route}/dados-clinicos/historico`).set(nurse);
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.data[0].current, payload.sections);
    assert.equal((await request(app).get(`${route}/dados-clinicos/historico`).set(pharmacy)).status, 403);
  });

  it("administrador configura acesso clínico por perfil sem alterar outras permissões", async () => {
    const admin = await login("marta.lima@lardoirmaovelho.example");
    const pharmacy = await login("tiago.menezes@lardoirmaovelho.example");
    const profiles = await request(app).get("/api/prontuarios/acesso/perfis").set(admin);
    assert.equal(profiles.status, 200);
    assert.ok(profiles.body.data.some((row) => row.id === "farmacia" && row.view === false));
    const forbidden = await request(app).put("/api/prontuarios/acesso/perfis/farmacia").set(pharmacy).send({ view: true, edit: true });
    assert.equal(forbidden.status, 403);
    const invalid = await request(app).put("/api/prontuarios/acesso/perfis/farmacia").set(admin).send({ view: false, edit: true });
    assert.equal(invalid.status, 422);
    const granted = await request(app).put("/api/prontuarios/acesso/perfis/farmacia").set(admin).send({ view: true, edit: true });
    assert.equal(granted.status, 200);
    try {
      const clinical = await request(app).get(`${route}/dados-clinicos`).set(pharmacy);
      assert.equal(clinical.status, 200);
      const changed = await request(app).put(`${route}/dados-clinicos`).set(pharmacy).send({
        sections: [{ id: "avaliacao", title: "Avaliação", fields: [{ label: "Alergias", value: "Penicilina" }] }],
      });
      assert.equal(changed.status, 200);
      const unrelated = await request(app).get(`${route}/sinais-vitais`).set(pharmacy);
      assert.equal(unrelated.status, 200);
      const permissions = await request(app).get("/api/auth/eu").set(pharmacy);
      assert.ok(permissions.body.user.permissions.includes("clinico.view"));
      assert.ok(permissions.body.user.permissions.includes("clinico.edit"));
      assert.ok(permissions.body.user.permissions.includes("vitais.view"));
    } finally {
      const revoked = await request(app).put("/api/prontuarios/acesso/perfis/farmacia").set(admin).send({ view: false, edit: false });
      assert.equal(revoked.status, 200);
    }
    const denied = await request(app).get(`${route}/dados-clinicos`).set(pharmacy);
    assert.equal(denied.status, 403);
    const deniedEdit = await request(app).put(`${route}/dados-clinicos`).set(pharmacy).send({
      sections: [{ id: "avaliacao", title: "Avaliação", fields: [{ label: "Alergias", value: "Nenhuma" }] }],
    });
    assert.equal(deniedEdit.status, 403);
    const unrelated = await request(app).get(`${route}/sinais-vitais`).set(pharmacy);
    assert.equal(unrelated.status, 200);
  });

  it("filtra evoluções e impede acessar correções de outro idoso", async () => {
    const nurse = await login("carla.nunes@lardoirmaovelho.example");
    const from = new Date(Date.now() - 60_000).toISOString();
    const created = await request(app).post(`${route}/evolucoes`).set(nurse).send({
      type: "reavaliacao", title: "Reavaliação E03", description: "Evolução criada para testar filtros do prontuário.", status: "finalizado",
    });
    assert.equal(created.status, 201);
    const filtered = await request(app).get(`${route}/evolucoes`).set(nurse).query({ from, type: "reavaliacao", authorId: "s03", limit: 5 });
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.data.some((row) => row.id === created.body.id));
    assert.equal(filtered.body.meta.limit, 5);
    const wrongType = await request(app).get(`${route}/evolucoes`).set(nurse).query({ from, type: "intercorrencia" });
    assert.equal(wrongType.status, 200);
    assert.ok(wrongType.body.data.every((row) => row.id !== created.body.id));
    const invalidPeriod = await request(app).get(`${route}/evolucoes`).set(nurse).query({ from: "2026-12-01", to: "2026-01-01" });
    assert.equal(invalidPeriod.status, 422);
    const wrongPatient = await request(app).get(`/api/prontuarios/p02/evolucoes/${created.body.id}/correcoes`).set(nurse);
    assert.equal(wrongPatient.status, 404);
  });

  it("gera pontos cronológicos para gráficos de pressão e glicemia", async () => {
    const nurse = await login("carla.nunes@lardoirmaovelho.example");
    const from = new Date(Date.now() - 60_000).toISOString();
    const pressure = await request(app).post(`${route}/sinais-vitais`).set(nurse).send({ kind: "pa", systolic: 121, diastolic: 78, pulse: 70, context: "Repouso" });
    const glucose = await request(app).post(`${route}/sinais-vitais`).set(nurse).send({ kind: "glicemia", glucose: 105, context: "Jejum" });
    assert.equal(pressure.status, 201);
    assert.equal(glucose.status, 201);
    const graph = await request(app).get(`${route}/sinais-vitais/grafico`).set(nurse).query({ from });
    assert.equal(graph.status, 200);
    assert.ok(graph.body.points.some((point) => point.id === pressure.body.id && point.systolic === 121));
    assert.ok(graph.body.points.some((point) => point.id === glucose.body.id && point.glucose === 105));
    assert.ok(graph.body.points.every((point, index, points) => index === 0 || points[index - 1].at <= point.at));
    const onlyGlucose = await request(app).get(`${route}/sinais-vitais/grafico`).set(nurse).query({ from, kind: "glicemia" });
    assert.ok(onlyGlucose.body.points.every((point) => point.kind === "glicemia"));
  });

  it("vincula anexos apenas a registros do mesmo prontuário", async () => {
    const nurse = await login("carla.nunes@lardoirmaovelho.example");
    const evolution = await request(app).post(`${route}/evolucoes`).set(nurse).send({
      type: "rotina", title: "Registro para anexo", description: "Evolução criada para associar documento de teste.",
    });
    assert.equal(evolution.status, 201);
    const file = Buffer.from("%PDF-1.4\n1 0 obj\n");
    const wrong = await request(app).post("/api/prontuarios/p02/documentos").set(nurse)
      .attach("arquivo", file, { filename: "anexo.pdf", contentType: "application/pdf" })
      .field("type", "Exame").field("linkedRecordType", "evolucao").field("linkedRecordId", evolution.body.id);
    assert.equal(wrong.status, 422);
    const uploaded = await request(app).post(`${route}/documentos`).set(nurse)
      .attach("arquivo", file, { filename: "anexo.pdf", contentType: "application/pdf" })
      .field("type", "Exame").field("linkedRecordType", "evolucao").field("linkedRecordId", evolution.body.id);
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.linkedRecordType, "evolucao");
    assert.equal(uploaded.body.linkedRecordId, evolution.body.id);
    const listed = await request(app).get(`${route}/documentos`).set(nurse);
    assert.ok(listed.body.data.some((row) => row.id === uploaded.body.id && row.linkedRecordId === evolution.body.id));
  });

  it("mantém revisões de planos, consolida a linha do tempo e audita a ficha", async () => {
    const admin = await login("marta.lima@lardoirmaovelho.example");
    const invalid = await request(app).post(`${route}/planos`).set(admin).send({
      title: "Plano de suporte", area: "Enfermagem", objective: "Acompanhar mobilidade e alimentação.", responsibleId: "s03", startDate: "2026-11-11", endDate: "2026-01-01",
    });
    assert.equal(invalid.status, 422);
    const created = await request(app).post(`${route}/planos`).set(admin).send({
      title: "Plano de suporte", area: "Enfermagem", objective: "Acompanhar mobilidade e alimentação.", responsibleId: "s03", startDate: "2026-11-11",
    });
    assert.equal(created.status, 201);
    const revised = await request(app).patch(`${route}/planos/${created.body.id}`).set(admin).send({
      reason: "Revisão da equipe assistencial", objective: "Acompanhar mobilidade, alimentação e hidratação.",
    });
    assert.equal(revised.status, 200);
    const detail = await request(app).get(`${route}/planos/${created.body.id}`).set(admin);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.carePlanUpdates[0].previousData.objective, "Acompanhar mobilidade e alimentação.");
    assert.equal(detail.body.carePlanUpdates[0].newData.objective, "Acompanhar mobilidade, alimentação e hidratação.");
    const timeline = await request(app).get(`${route}/linha-do-tempo`).set(admin).query({ type: "plano", page: 1, limit: 5 });
    assert.equal(timeline.status, 200);
    assert.ok(timeline.body.data.some((row) => row.id === created.body.id));
    assert.ok(timeline.body.data.every((row) => row.type === "plano"));
    const ficha = await request(app).get(`${route}/ficha`).set(admin);
    assert.equal(ficha.status, 200);
    assert.ok(ficha.body.exportedAt);
    assert.equal(ficha.body.patient.id, "p01");
    assert.ok(ficha.body.careData);
    const logged = await prisma.audit_log.findFirst({ where: { entity: "ficha_idoso", entity_id: "p01", action: "exportar" } });
    assert.ok(logged);
  });
});

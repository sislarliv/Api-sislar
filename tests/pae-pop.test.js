import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { prepare, shutdown } from "./prepare.js";

const password = "Sislar@2026";

function day(offset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function login(email) {
  const response = await request(app).post("/api/auth/login").send({ email, password });
  assert.equal(response.status, 200);
  return { Authorization: `Bearer ${response.body.token}` };
}

before(prepare);
after(shutdown);

describe("PAE do Grupo 1", () => {
  it("cadastra modelo com campos, responsáveis, ações e versão", async () => {
    const admin = await login("marta.lima@lardoirmaovelho.example");
    const created = await request(app).post("/api/pae/modelos").set(admin).send({
      name: "Acompanhamento de teste",
      description: "Plano de acompanhamento criado no teste de integração.",
      responsibleIds: ["s03", "s06"],
      fields: [{ label: "Observação", fieldType: "texto", required: true }],
      actions: [{ title: "Registrar acompanhamento", roleLabel: "Enfermagem" }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 1);
    assert.equal(created.body.status, "vigente");
    assert.deepEqual(created.body.responsibleIds.sort(), ["s03", "s06"]);
    assert.equal(created.body.fields[0].label, "Observação");
    assert.equal(created.body.actions[0].title, "Registrar acompanhamento");
    const archived = await request(app).patch(`/api/pae/modelos/${created.body.id}/status`).set(admin).send({ status: "arquivado" });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.status, "arquivado");
  });

  it("atribui prazo e responsável às ações, guarda versões e filtra pendências", async () => {
    const admin = await login("marta.lima@lardoirmaovelho.example");
    const incomplete = await request(app).post("/api/pae").set(admin).send({
      patientId: "p02", templateId: "pt1", responsibleId: "s03", startDate: day(),
      values: { f1: "Andador", f3: "sim" },
    });
    assert.equal(incomplete.status, 422);

    const created = await request(app).post("/api/pae").set(admin).send({
      patientId: "p02", templateId: "pt1", responsibleId: "s03",
      startDate: day(), reviewDate: day(10), values: { f1: "Andador", f3: "sim" },
      actions: [{ templateActionId: "a2", responsibleId: "s06", dueDate: day(7) }],
    });
    assert.equal(created.status, 201);
    const paeId = created.body.id;
    const detail = await request(app).get(`/api/pae/${paeId}`).set(admin);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.version, 1);
    assert.equal(detail.body.paeActions.length, 2);
    const first = detail.body.paeActions.find((action) => action.templateActionId === "a1");
    const second = detail.body.paeActions.find((action) => action.templateActionId === "a2");
    assert.equal(first.responsibleId, "s03");
    assert.equal(first.dueDate, day(10));
    assert.equal(second.responsibleId, "s06");
    assert.equal(second.dueDate, day(7));

    const pending = await request(app).get("/api/pae/pendencias").set(admin).query({
      patientId: "p02", responsibleId: "s06", dueFrom: day(7), dueUntil: day(7), status: "pendente",
    });
    assert.equal(pending.status, 200);
    assert.ok(pending.body.data.some((item) => item.id === second.id));
    assert.ok(pending.body.data.every((item) => item.responsibleId === "s06"));

    const executed = await request(app).post(`/api/pae/${paeId}/acoes/${second.id}/executar`).set(admin).send({ notes: "Caminhada realizada." });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.status, "executada");
    assert.equal(executed.body.doneBy, "s01");
    assert.ok(await prisma.audit_log.findFirst({ where: { entity: "acao_pae", entity_id: second.id, action: "executar" } }));
    assert.equal((await request(app).post(`/api/pae/${paeId}/acoes/${second.id}/executar`).set(admin).send({})).status, 409);

    const revised = await request(app).post(`/api/pae/${paeId}/revisar`).set(admin).send({
      reviewDate: day(20), responsibleId: "s06", values: { f1: "Bengala" },
      actions: [{ id: first.id, dueDate: day(15), responsibleId: "s06" }],
      summary: "Nova avaliação de mobilidade.",
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.version, 2);
    const versions = await request(app).get(`/api/pae/${paeId}/versoes`).set(admin);
    assert.equal(versions.status, 200);
    assert.equal(versions.body.currentVersion, 2);
    assert.deepEqual(versions.body.data.map((item) => [item.version, item.current]), [[2, true], [1, false]]);
    const previous = await request(app).get(`/api/pae/${paeId}/versoes/1`).set(admin);
    const current = await request(app).get(`/api/pae/${paeId}/versoes/2`).set(admin);
    assert.equal(previous.status, 200);
    assert.equal(current.status, 200);
    assert.equal(previous.body.snapshot.values.find((value) => value.fieldId === "f1").value, "Andador");
    assert.equal(current.body.snapshot.values.find((value) => value.fieldId === "f1").value, "Bengala");
    assert.equal(current.body.snapshot.actions.find((action) => action.id === first.id).dueDate, day(15));
    assert.equal((await request(app).get("/api/pae/pendencias").set(admin).query({ dueFrom: day(20), dueUntil: day(1) })).status, 422);
    const closed = await request(app).post(`/api/pae/${paeId}/revisar`).set(admin).send({
      reviewDate: day(25), status: "encerrado", summary: "Encerramento do plano de teste.",
    });
    assert.equal(closed.status, 200);
    const openPending = await request(app).get("/api/pae/pendencias").set(admin).query({ patientId: "p02" });
    assert.equal(openPending.body.data.some((item) => item.id === first.id), false);
    const closedPending = await request(app).get("/api/pae/pendencias").set(admin)
      .query({ patientId: "p02", paeStatus: "encerrado" });
    assert.equal(closedPending.body.data.some((item) => item.id === first.id), true);
  });
});

describe("POPs do Grupo 1", () => {
  it("cadastra, publica e versiona procedimento", async () => {
    const admin = await login("marta.lima@lardoirmaovelho.example");
    const volunteer = await login("helena.duarte@lardoirmaovelho.example");
    const body = {
      code: "POP-E14-TESTE", title: "Procedimento de acompanhamento", category: "Enfermagem",
      purpose: "Padronizar o acompanhamento assistencial no teste de integração.",
      validFrom: day(-1), validUntil: day(20), status: "rascunho",
      sections: [{ title: "Execução", items: ["Registrar o acompanhamento no prontuário."] }],
      related: [{ kind: "modulo", label: "Enfermagem" }],
    };
    const created = await request(app).post("/api/pop").set(admin).send(body);
    assert.equal(created.status, 201);
    const popId = created.body.id;
    assert.equal((await request(app).get(`/api/pop/${popId}`).set(volunteer)).status, 404);

    const published = await request(app).patch(`/api/pop/${popId}/status`).set(admin).send({ status: "vigente" });
    assert.equal(published.status, 200);
    assert.equal((await request(app).get(`/api/pop/${popId}`).set(volunteer)).status, 200);
    const publishedVersion = await request(app).get(`/api/pop/${popId}/versoes/1`).set(admin);
    assert.equal(publishedVersion.status, 200);
    assert.equal(publishedVersion.body.content.status, "vigente");
    const version = await request(app).post(`/api/pop/${popId}/versoes`).set(admin).send({
      ...body, code: undefined, status: "vigente", summary: "Segunda versão do procedimento.",
      sections: [{ title: "Execução", items: ["Registrar e conferir o acompanhamento."] }],
    });
    assert.equal(version.status, 201);
    assert.equal(version.body.version, 2);
    assert.ok(await prisma.audit_log.findFirst({ where: { entity: "pop", entity_id: popId, action: "publicar_versao" } }));
    const previous = await request(app).get(`/api/pop/${popId}/versoes/1`).set(admin);
    assert.equal(previous.status, 200);
    assert.equal(previous.body.sections[0].items[0], "Registrar o acompanhamento no prontuário.");
    assert.equal(previous.body.content.title, body.title);
    assert.equal(previous.body.content.related[0].label, "Enfermagem");
  });

  it("mostra só procedimentos aplicáveis para consulta e permite filtrar validade e processo ao gestor", async () => {
    const volunteer = await login("helena.duarte@lardoirmaovelho.example");
    const admin = await login("marta.lima@lardoirmaovelho.example");
    const seededVersion = await request(app).get("/api/pop/pop1/versoes/1").set(admin);
    assert.equal(seededVersion.status, 200);
    assert.equal(seededVersion.body.content.code, "POP-ENF-001");
    const applicable = await request(app).get("/api/pop").set(volunteer);
    assert.equal(applicable.status, 200);
    assert.ok(applicable.body.data.some((pop) => pop.id === "pop1"));
    assert.ok(!applicable.body.data.some((pop) => pop.id === "pop5"));
    assert.equal((await request(app).get("/api/pop/pop5").set(volunteer)).status, 404);
    assert.equal((await request(app).get("/api/pop").set(volunteer).query({ status: "vencido" })).status, 403);

    const expired = await request(app).get("/api/pop").set(admin).query({ status: "vencido" });
    assert.equal(expired.status, 200);
    assert.ok(expired.body.data.some((pop) => pop.id === "pop5" && pop.effectiveStatus === "vencido"));
    const procedure = await request(app).get("/api/pop").set(volunteer).query({
      q: "pressão", category: "enfermagem", relatedKind: "modulo", relatedLabel: "Enfermagem",
    });
    assert.equal(procedure.status, 200);
    assert.deepEqual(procedure.body.data.map((pop) => pop.id), ["pop2"]);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { prepare, shutdown } from "./prepare.js";

async function bearer(email) {
  const login = await request(app).post("/api/auth/login").send({ email, password: "Sislar@2026" });
  assert.equal(login.status, 200);
  return { Authorization: `Bearer ${login.body.token}` };
}

before(prepare);
after(shutdown);

describe("cadastro e localização de idosos", () => {
  it("impede dois idosos ativos no mesmo leito e registra transferências", async () => {
    const admin = await bearer("marta.lima@lardoirmaovelho.example");
    const room = await request(app).post("/api/quartos").set(admin).send({ wing: "Ala Teste", number: "901", beds: ["A", "B"] });
    assert.equal(room.status, 201);
    assert.equal(room.body.capacity, 2);

    const input = {
      name: "Ana Teste de Cadastro", treatment: "Dona Ana", sex: "F",
      birthDate: "1940-02-10", admissionDate: "2020-03-01",
      wing: "Ala Teste", room: "901", bed: "A",
    };
    const created = await request(app).post("/api/idosos").set(admin).send(input);
    assert.equal(created.status, 201);
    assert.match(created.body.code, /^LIV-/);
    const id = created.body.id;
    const futureBirth = await request(app).post("/api/idosos").set(admin).send({ ...input, birthDate: "2999-01-01" });
    assert.equal(futureBirth.status, 422);

    const conflict = await request(app).post("/api/idosos").set(admin).send({ ...input, name: "Outra Pessoa de Teste" });
    assert.equal(conflict.status, 409);

    const occupied = await request(app).get(`/api/quartos/${room.body.id}`).set(admin);
    assert.equal(occupied.body.occupancy, 1);
    assert.equal(occupied.body.beds.find((bed) => bed.label === "A").occupant.id, id);
    const blocked = await request(app).patch(`/api/quartos/${room.body.id}`).set(admin).send({ active: false });
    assert.equal(blocked.status, 409);

    const moved = await request(app).post(`/api/idosos/${id}/transferencias`).set(admin).send({
      wing: "Ala Teste", room: "901", bed: "B", reason: "Mudança de leito para manutenção",
    });
    assert.equal(moved.status, 201);
    assert.equal(moved.body.patient.bed, "B");
    const history = await request(app).get(`/api/idosos/${id}/transferencias`).set(admin);
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.current.bed, "B");

    const inactive = await request(app).patch(`/api/idosos/${id}`).set(admin).send({ active: false });
    assert.equal(inactive.status, 200);
    const reuse = await request(app).post("/api/idosos").set(admin).send({ ...input, name: "Beatriz Teste de Cadastro", bed: "B" });
    assert.equal(reuse.status, 201);
    const reactivate = await request(app).patch(`/api/idosos/${id}`).set(admin).send({ active: true });
    assert.equal(reactivate.status, 409);
  });

  it("edita dados, contatos e avisos com histórico e permissões", async () => {
    const admin = await bearer("marta.lima@lardoirmaovelho.example");
    const reception = await bearer("aline.barros@lardoirmaovelho.example");
    const volunteer = await bearer("helena.duarte@lardoirmaovelho.example");
    const room = await request(app).post("/api/quartos").set(admin).send({ wing: "Ala Teste", number: "902" });
    assert.equal(room.status, 201);
    const customBed = await request(app).post(`/api/quartos/${room.body.id}/leitos`).set(admin).send({ label: "C" });
    assert.equal(customBed.status, 201);
    const customOccupant = await request(app).post("/api/idosos").set(admin).send({
      name: "Morador de Leito Configurado", treatment: "Seu Morador", sex: "M",
      birthDate: "1941-01-01", admissionDate: "2021-01-01",
      wing: "Ala Teste", room: "902", bed: "C",
    });
    assert.equal(customOccupant.status, 201);

    const created = await request(app).post("/api/idosos").set(reception).send({
      name: "Carlos Teste de Cadastro", treatment: "Seu Carlos", sex: "M",
      birthDate: "1938-06-09", admissionDate: "2021-02-03",
      wing: "Ala Teste", room: "902", bed: "A",
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const edited = await request(app).patch(`/api/idosos/${id}`).set(reception).send({
      presenceStatus: "outro", presenceDetail: "Na capela",
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.presenceStatus, "outro");
    const clinicalDenied = await request(app).patch(`/api/idosos/${id}`).set(reception).send({ status: "observacao" });
    assert.equal(clinicalDenied.status, 403);
    const clinicalEdit = await request(app).patch(`/api/idosos/${id}`).set(admin).send({ status: "observacao" });
    assert.equal(clinicalEdit.status, 200);
    const invalid = await request(app).patch(`/api/idosos/${id}`).set(reception).send({ presenceStatus: "outro", presenceDetail: "" });
    assert.equal(invalid.status, 422);

    const contact = await request(app).post(`/api/idosos/${id}/contatos`).set(reception).send({
      name: "Maria de Teste", relation: "Filha", phone: "(11) 99999-0000", priority: 1,
      notes: "Atende pela manhã",
    });
    assert.equal(contact.status, 201);
    assert.equal(contact.body.isPrimary, true);
    const second = await request(app).post(`/api/idosos/${id}/contatos`).set(reception).send({
      name: "Pedro de Teste", relation: "Filho", phone: "(11) 99999-0001", priority: 2, isPrimary: true,
    });
    assert.equal(second.status, 201);
    const contacts = await request(app).get(`/api/idosos/${id}/contatos`).set(reception);
    assert.equal(contacts.status, 200);
    assert.equal(contacts.body.data.find((row) => row.id === contact.body.id).isPrimary, false);
    assert.equal(contacts.body.data.find((row) => row.id === second.body.id).isPrimary, true);

    const deniedNotice = await request(app).post(`/api/idosos/${id}/avisos`).set(reception).send({ label: "Atenção", kind: "outro" });
    assert.equal(deniedNotice.status, 403);
    const notice = await request(app).post(`/api/idosos/${id}/avisos`).set(admin).send({
      label: "Acompanhar na saída", kind: "mobilidade", context: "cadastro", detail: "Usa andador",
    });
    assert.equal(notice.status, 201);
    const chartNotice = await request(app).post(`/api/idosos/${id}/avisos`).set(admin).send({
      label: "Atenção clínica", kind: "outro", context: "prontuario", detail: "Acompanhar evolução",
    });
    assert.equal(chartNotice.status, 201);
    const registration = await request(app).get(`/api/idosos/${id}`).set(reception);
    assert.equal(registration.status, 200);
    assert.equal(registration.body.alerts.some((row) => row.id === chartNotice.body.id), false);
    const receptionNotices = await request(app).get(`/api/idosos/${id}/avisos`).set(reception);
    assert.equal(receptionNotices.body.data.some((row) => row.id === chartNotice.body.id), false);
    assert.equal((await request(app).get(`/api/idosos/${id}/avisos?context=prontuario`).set(reception)).status, 403);
    const summary = await request(app).get(`/api/idosos/${id}/resumo`).set(reception);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.location.room, "902");
    assert.equal(summary.body.contacts.length, 2);
    assert.equal(summary.body.alerts.some((row) => row.id === notice.body.id), true);
    const removed = await request(app).delete(`/api/idosos/${id}/avisos/${notice.body.id}`).set(admin);
    assert.equal(removed.status, 204);
    const notices = await request(app).get(`/api/idosos/${id}/avisos?context=cadastro`).set(reception);
    assert.equal(notices.body.data.some((row) => row.id === notice.body.id), false);

    const history = await request(app).get(`/api/idosos/${id}/historico`).set(reception);
    assert.equal(history.status, 200);
    assert.equal(history.body.data.some((row) => row.action === "atualizar"), true);
    const search = await request(app).get("/api/idosos").set(reception).query({ q: "Carlos Teste", wing: "Ala Teste", room: "902", status: "observacao", presenceStatus: "outro", active: "true" });
    assert.equal(search.status, 200);
    assert.equal(search.body.data.some((row) => row.id === id), true);
    const denied = await request(app).get(`/api/idosos/${id}`).set(volunteer);
    assert.equal(denied.status, 403);
  });
});

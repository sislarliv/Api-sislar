import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { prepare, shutdown } from "./prepare.js";

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(email) {
  const response = await request(app).post("/api/auth/login").send({ email, password: "Sislar@2026" });
  assert.equal(response.status, 200);
  return response.body.token;
}

before(prepare);
after(shutdown);

describe("migração do Grupo 1", () => {
  it("separa prévia, correção, carga, amostra e conclusão do lote", async () => {
    const admin = await login("marta.lima@lardoirmaovelho.example");
    const estoque = await login("sergio.camargo@lardoirmaovelho.example");
    const legacy = await request(app).get("/api/importacoes/legado").set(auth(admin));
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.body.data));
    const room = await request(app).post("/api/quartos").set(auth(admin)).send({
      wing: "Ala Migração", number: "990", beds: ["A", "B"],
    });
    assert.equal(room.status, 201);
    const freeBeds = await prisma.$queryRaw`SELECT r.wing, r.number AS room, b.label AS bed
      FROM beds b JOIN rooms r ON r.id = b.room_id
      WHERE r.active AND b.active AND r.wing = 'Ala Migração' AND NOT EXISTS (
        SELECT 1 FROM patients p WHERE p.active AND p.wing = r.wing
          AND p.room = r.number AND p.bed = b.label
      ) ORDER BY r.wing, r.number, b.label LIMIT 2`;
    assert.equal(freeBeds.length, 2);
    const [first, second] = freeBeds;
    const csv = `nome;sexo;nascimento;ala;quarto;leito\n`
      + `Ana Migração;F;1940-01-02;${first.wing};${first.room};${first.bed}\n`
      + `;X;2099-01-01;${second.wing};${second.room};${second.bed}\n`;
    const denied = await request(app).post("/api/importacoes").set(auth(estoque))
      .attach("arquivo", Buffer.from(csv), { filename: "lote.csv", contentType: "text/csv" });
    assert.equal(denied.status, 403);
    const preview = await request(app).post("/api/importacoes").set(auth(admin))
      .attach("arquivo", Buffer.from(csv), { filename: "lote.csv", contentType: "text/csv" });
    assert.equal(preview.status, 201);
    const batchId = preview.body.job.id;
    assert.equal(preview.body.job.status, "previa");
    assert.equal(preview.body.job.summary.valida, 1);
    assert.equal(preview.body.job.summary.rejeitada, 1);
    assert.equal(await prisma.patients.count({ where: { name: "Ana Migração" } }), 0);

    const rejected = await request(app).get(`/api/importacoes/${batchId}/rejeicoes`).set(auth(admin));
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data[0].lineNumber, 3);
    assert.ok(rejected.body.data[0].errors.length);
    const tooSoon = await request(app).post(`/api/importacoes/${batchId}/confirmar`).set(auth(admin));
    assert.equal(tooSoon.status, 409);

    const corrected = await request(app).patch(`/api/importacoes/${batchId}/linhas/3`).set(auth(admin)).send({
      data: { nome: "Beto Migração", sexo: "M", nascimento: "1939-05-20" },
      reason: "Conferência com a ficha física de origem.",
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.job.summary.valida, 2);
    const history = await request(app).get(`/api/importacoes/${batchId}/linhas/3/historico`).set(auth(admin));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].reason, "Conferência com a ficha física de origem.");

    const imported = await request(app).post(`/api/importacoes/${batchId}/confirmar`).set(auth(admin));
    assert.equal(imported.status, 200);
    assert.equal(imported.body.job.summary.importada, 2);
    assert.equal(await prisma.patients.count({ where: { name: "Ana Migração" } }), 1);
    const line = imported.body.job.rows.find((row) => row.lineNumber === 2);
    assert.ok(line.patientId);

    const unchecked = await request(app).post(`/api/importacoes/${batchId}/amostra`).set(auth(admin)).send({
      rows: [{ lineNumber: 2 }], checklist: [{ item: "Identidade", checked: false }], approved: true,
    });
    assert.equal(unchecked.status, 422);
    const sample = await request(app).post(`/api/importacoes/${batchId}/amostra`).set(auth(admin)).send({
      rows: [{ lineNumber: 2, notes: "Ficha e cadastro conferidos." }],
      checklist: [{ item: "Identidade e dados clínicos", checked: true }], approved: true,
    });
    assert.equal(sample.status, 200);
    assert.equal(sample.body.job.validationStatus, "aprovada");
    const concluded = await request(app).post(`/api/importacoes/${batchId}/concluir`).set(auth(admin)).send({
      periodStart: "2026-01-01", periodEnd: "2026-10-31", result: "Lote conferido e aprovado.",
    });
    assert.equal(concluded.status, 200);
    assert.equal(concluded.body.job.status, "concluido");
    assert.equal(concluded.body.job.completedBy, "s01");
    assert.equal(concluded.body.job.completedCount, 2);

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const uploaded = await request(app).post("/api/migracao/documentos").set(auth(admin))
      .field("patientId", line.patientId).field("category", "Ficha antiga")
      .field("documentDate", "2020-06-01").field("origin", "Arquivo físico da instituição")
      .field("batchId", batchId)
      .attach("arquivo", pdf, { filename: "ficha.pdf", contentType: "application/pdf" });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.patientId, line.patientId);
    const documents = await request(app).get("/api/migracao/documentos")
      .query({ patientId: line.patientId }).set(auth(admin));
    assert.equal(documents.status, 200);
    assert.equal(documents.body.data[0].origin, "Arquivo físico da instituição");
    const anotherDocument = await request(app).post("/api/migracao/documentos").set(auth(admin))
      .field("patientId", line.patientId).field("category", "Ficha antiga")
      .field("documentDate", "2020-06-02").field("origin", "Arquivo físico da instituição")
      .field("batchId", batchId).field("sourceIdentifier", "")
      .attach("arquivo", pdf, { filename: "outra-ficha.pdf", contentType: "application/pdf" });
    assert.equal(anotherDocument.status, 201);
    assert.equal(anotherDocument.body.sourceIdentifier, null);

    const nextRoom = await request(app).post("/api/quartos").set(auth(admin)).send({
      wing: "Ala Migração", number: "991", beds: ["A"],
    });
    assert.equal(nextRoom.status, 201);
    const misaligned = await request(app).post("/api/importacoes").set(auth(admin))
      .attach("arquivo", Buffer.from(
        "nome;sexo;nascimento;ala;quarto;leito;admissao;identificador_origem\n"
        + "Clara Migração;F;1942-03-04;Ala Migração;991;A;ORIGEM-123\n",
      ), { filename: "desalinhado.csv", contentType: "text/csv" });
    assert.equal(misaligned.status, 201);
    assert.equal(misaligned.body.job.summary.rejeitada, 1);
    const fixed = await request(app).patch(`/api/importacoes/${misaligned.body.job.id}/linhas/2`)
      .set(auth(admin)).send({
        data: { nome: "Clara Migração", sexo: "F", nascimento: "1942-03-04",
          ala: "Ala Migração", quarto: "991", leito: "A", identificador_origem: "ORIGEM-123" },
        reason: "Colunas alinhadas conforme a fonte original.",
      });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.job.summary.valida, 1);
    assert.equal(fixed.body.job.rows[0].currentData.admissao, "");
    assert.equal(fixed.body.job.rows[0].currentData.identificador_origem, "ORIGEM-123");
  });
});

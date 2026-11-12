import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMigrationCsv, validateMigrationRow } from "../src/lib/migrationCsv.js";

describe("modelo de migração", () => {
  it("aceita CSV UTF-8 com JSON e delimitador entre aspas", () => {
    const content = 'nome;sexo;nascimento;ala;quarto;leito;dados_clinicos\n'
      + 'Ana Teste;F;1940-01-02;Ala Ipê;301;A;"[{""sectionId"":""clinico"",""sectionTitle"":""Clínico"",""label"":""Observação"",""value"":""Sem queixas; estável""}]"\n';
    const rows = parseMigrationCsv(Buffer.from(content));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lineNumber, 2);
    const checked = validateMigrationRow(rows[0].data, "2026-11-11");
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.careFields[0].value, "Sem queixas; estável");
  });

  it("rejeita data impossível e múltiplos contatos principais", () => {
    const checked = validateMigrationRow({
      nome: "Ana Teste", sexo: "F", nascimento: "1940-02-30", ala: "Ala Ipê", quarto: "301", leito: "A",
      contatos: JSON.stringify([
        { name: "Maria", relation: "Filha", phone: "11999999999", isPrimary: true },
        { name: "João", relation: "Filho", phone: "11888888888", isPrimary: true },
      ]),
    }, "2026-11-11");
    assert.ok(checked.errors.some((error) => error.includes("nascimento")));
    assert.ok(checked.errors.some((error) => error.includes("apenas um contato")));
  });

  it("rejeita cabeçalho inesperado e arquivo sem linhas", () => {
    assert.throws(() => parseMigrationCsv(Buffer.from("nome;sexo\nAna;F\n")), /Cabeçalho inválido/);
    assert.throws(() => parseMigrationCsv(Buffer.from("nome;sexo;nascimento;ala;quarto;leito\n")), /Planilha sem dados/);
  });

  it("mantém linha vazia na prévia para correção", () => {
    const rows = parseMigrationCsv(Buffer.from(
      "nome;sexo;nascimento;ala;quarto;leito\nAna Teste;F;1940-01-02;Ala;1;A\n\nBeto Teste;M;1939-05-20;Ala;2;B\n",
    ));
    assert.equal(rows.length, 3);
    assert.equal(rows[1].lineNumber, 3);
    assert.ok(validateMigrationRow(rows[1].data, "2026-11-11").errors.length);
  });
});

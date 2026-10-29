import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertEvolutionTransition } from "../src/lib/evolutionRules.js";
import { effectivePopStatus } from "../src/lib/popStatus.js";
import { permissionsFor } from "../src/lib/permissions.js";

describe("regras de evolução", () => {
  it("bloqueia alteração de evolução finalizada", () => {
    assert.throws(() => assertEvolutionTransition("finalizado", "update"), { status: 409 });
    assert.throws(() => assertEvolutionTransition("finalizado", "finalize"), { status: 409 });
  });

  it("só corrige evolução finalizada", () => {
    assert.throws(() => assertEvolutionTransition("rascunho", "correct"), { status: 409 });
    assert.doesNotThrow(() => assertEvolutionTransition("finalizado", "correct"));
    assert.doesNotThrow(() => assertEvolutionTransition("rascunho", "update"));
  });
});

describe("validade do POP", () => {
  const now = new Date(2026, 9, 28);

  it("marca vencido, vencendo e vigente nas bordas", () => {
    assert.equal(effectivePopStatus("vigente", "2026-10-27", now), "vencido");
    assert.equal(effectivePopStatus("vigente", "2026-10-28", now), "vencendo");
    assert.equal(effectivePopStatus("vigente", "2026-11-27", now), "vencendo");
    assert.equal(effectivePopStatus("vigente", "2026-11-28", now), "vigente");
  });

  it("preserva rascunho e arquivado", () => {
    assert.equal(effectivePopStatus("rascunho", "2020-01-01", now), "rascunho");
    assert.equal(effectivePopStatus("arquivado", "2030-01-01", now), "arquivado");
  });
});

describe("permissões", () => {
  it("técnico não baixa documento nem encerra ocorrência", () => {
    const perms = permissionsFor(["tecnico"]);
    assert.equal(perms.has("documento.download"), false);
    assert.equal(perms.has("ocorrencia.close"), false);
    assert.equal(perms.has("evolucao.create"), true);
  });

  it("gestor com enfermagem soma as permissões", () => {
    const perms = permissionsFor(["gestor", "enfermagem"]);
    assert.equal(perms.has("dados.edit"), true);
    assert.equal(perms.has("pop.manage"), true);
    assert.equal(perms.has("usuarios.manage"), false);
  });

  it("administração tem gestão de usuários", () => {
    assert.equal(permissionsFor(["admin"]).has("usuarios.manage"), true);
  });

  it("voluntário não vê prontuário", () => {
    assert.equal(permissionsFor(["voluntario"]).has("prontuario.view"), false);
  });
});

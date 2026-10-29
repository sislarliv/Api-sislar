import { HttpError } from "./httpError.js";

export function assertEvolutionTransition(current, action) {
  if ((action === "update" || action === "finalize") && current !== "rascunho") {
    throw new HttpError(409, "Evolução finalizada não pode ser alterada. Registre uma correção.");
  }
  if (action === "correct" && current !== "finalizado") {
    throw new HttpError(409, "Somente evolução finalizada pode ser corrigida.");
  }
}

export function assertNotTooFuture(date, label = "Data") {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) {
    throw new HttpError(422, `${label} inválida.`);
  }
  if (value.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new HttpError(422, `${label} não pode estar no futuro.`);
  }
  return value;
}

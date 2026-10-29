import { HttpError } from "../lib/httpError.js";

export function notFound(message = "Registro não encontrado.") {
  throw new HttpError(404, message);
}

export async function audit(tx, { userId, action, entity, entityId, payload }) {
  await tx.audit_log.create({
    data: {
      user_id: userId ?? null,
      action,
      entity,
      entity_id: entityId ?? null,
      payload: payload ?? {},
    },
  });
}

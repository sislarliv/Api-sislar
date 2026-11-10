// Auditoria de LEITURA de dados clínicos (registro clínico, acompanhamento odontológico, tratamento
// externo e pendências): quem acessou, quando (audit_log.at) e qual idoso. Usa a auditoria da Fundação.
import { audit } from "../db/helpers.js";
import { prisma } from "../db/prisma.js";

/**
 * @param req requisição (req.user)
 * @param {{ entidade: string, idosoIds: string[], ids?: string[], rota: string }} leitura
 */
export async function auditarLeitura(req, { entidade, idosoIds, ids = [], rota }) {
  const idosos = [...new Set(idosoIds.filter(Boolean))];
  await audit(prisma, {
    userId: req.user.id,
    action: `${entidade}.ler`,
    entity: `grupo3.${entidade}`,
    entityId: ids.length === 1 ? ids[0] : null,
    payload: { resultado: "sucesso", rota, idosos, registros: ids.slice(0, 200), total: ids.length },
  });
}

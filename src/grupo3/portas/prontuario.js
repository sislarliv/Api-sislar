// Porta de integração com o prontuário (Grupo 1 — US-023, US-030, US-031).
// - Evolução (US-023) já existe no repositório (public.evolutions): publicarNoProntuario usa o adaptador real.
// - Linha do tempo (US-030) e visibilidade do prontuário (US-031) ainda não existem: podeVerIdoso é stub.
import { prisma } from "../../db/prisma.js";

/**
 * Regra de visibilidade do prontuário (US-031). O Grupo 3 já exige a permissão do módulo clínico;
 * esta porta acrescenta a restrição por idoso quando o Grupo 1 a definir.
 * TODO(integracao-G1): delegar para a regra de visibilidade do prontuário.
 */
export async function podeVerIdoso(_usuario, _idoso) {
  return true;
}

const ROTULO_AREA = { medica: "Consulta médica", odontologica: "Consulta odontológica", fisioterapia: "Evolução de fisioterapia" };

// Permissão do Grupo 1 para gravar evolução. A porta não a contorna: quem não tem fica "aguardando_permissao".
export const PERMISSAO_PUBLICAR = "evolucao.create";

export function podePublicar(usuario) {
  return usuario.permissions.includes(PERMISSAO_PUBLICAR);
}

/**
 * Publica um registro clínico finalizado no prontuário do idoso como evolução finalizada (US-086).
 * Contrato: { idosoId, autorUsuarioId, area, tipo, realizadoEm, resumo, adendo: boolean, referenciaId }.
 * Retorna { status: "publicado", referencia: id da evolução }.
 * Quem chama deve conferir podePublicar(autor) antes: o autor precisa ter evolucao.create.
 * TODO(integracao-G1): quando existir a linha do tempo (US-030), publicar também nela.
 */
export async function publicarNoProntuario(registro, db = prisma) {
  const rotulo = ROTULO_AREA[registro.area] ?? "Atendimento";
  const titulo = `${registro.adendo ? "Adendo · " : ""}${rotulo}: ${registro.tipo}`.slice(0, 160);
  const descricao = registro.resumo.length >= 10 ? registro.resumo : `${registro.resumo} (registro do Grupo 3)`;
  // TODO(integracao-G1): solução temporária. O catálogo de tipos da evolução (rotina, reavaliacao, cuidado,
  // intercorrencia) não tem "consulta" nem "fisioterapia"; usar os tipos próprios quando o Grupo 1 criá-los.
  // O Grupo 3 não altera o catálogo do Grupo 1.
  const tipoEvolucao = "reavaliacao";
  const rows = await db.$queryRaw`
    INSERT INTO public.evolutions (patient_id, at, author_id, type, title, description, notes, status, closed_at)
    VALUES (${registro.idosoId}, ${registro.realizadoEm}, ${registro.autorUsuarioId}, ${tipoEvolucao}, ${titulo},
            ${descricao.slice(0, 8000)}, ${`Origem: agenda/atendimento clínico (registro ${registro.referenciaId}).`},
            'finalizado', now())
    RETURNING id
  `;
  return { status: "publicado", referencia: rows[0].id };
}

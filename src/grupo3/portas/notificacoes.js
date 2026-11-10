// Porta de integração com a camada de notificações (Grupo 4 — T-005 / US-117).
// Adaptador real para o canal interno: grava em public.notifications, a caixa de notificações que a API
// já expõe em GET /api/notificacoes. Os outros canais (e-mail, WhatsApp, SMS) dependem da D-008.
// TODO(integracao-G4): quando o serviço de notificações do Grupo 4 existir, trocar este adaptador por
// ele, mantendo o contrato abaixo.

/**
 * @param {{ usuarioId: string, titulo: string, corpo: string, link?: string, tipo?: string }} mensagem
 *   tipo: categoria da notificação (agenda, tarefa, odontologia). Padrão: agenda.
 * @param db cliente Prisma (ou transação)
 * @returns {Promise<{ status: "enviado" | "entregue", canal: string, referencia: string | null }>}
 */
export async function enviarNotificacao(mensagem, db) {
  const rows = await db.$queryRaw`
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (${mensagem.usuarioId}, ${mensagem.tipo ?? "agenda"}, ${mensagem.titulo}, ${mensagem.corpo}, ${mensagem.link ?? null})
    RETURNING id
  `;
  // No canal interno, gravar na caixa do usuário já é a entrega.
  return { status: "entregue", canal: "interno", referencia: rows[0].id };
}

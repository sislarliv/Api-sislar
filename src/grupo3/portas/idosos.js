// Porta de integração com o cadastro de idosos (Grupo 1 — US-011).
// Adaptador real sobre public.patients. Na API o idoso é identificado pelo mesmo id usado no
// prontuário (ex.: "p01"); no schema grupo3 fica gravado o UUID patients.ref.
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

function paraIdoso(row) {
  return {
    id: row.id,
    ref: row.ref,
    nome: row.name,
    // TODO(integracao-G1): patients não tem status de inativação (óbito, desligamento). Até o
    // Grupo 1 criar esse status, todo idoso cadastrado é considerado ativo.
    ativo: true,
  };
}

export async function buscarIdoso(idosoId, db = prisma) {
  const rows = await db.$queryRaw`SELECT id, ref, name FROM public.patients WHERE id = ${idosoId}`;
  return rows[0] ? paraIdoso(rows[0]) : null;
}

export async function buscarIdososPorRef(refs, db = prisma) {
  const unicos = [...new Set(refs.filter(Boolean))];
  if (!unicos.length) return new Map();
  const rows = await db.$queryRaw`
    SELECT id, ref, name FROM public.patients
    WHERE ref IN (${Prisma.join(unicos.map((ref) => Prisma.sql`${ref}::uuid`))})
  `;
  return new Map(rows.map((row) => [row.ref, paraIdoso(row)]));
}

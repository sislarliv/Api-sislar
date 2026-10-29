import { randomUUID } from "node:crypto";
import { present, prisma } from "./prisma.js";

export const CATEGORIAS = ["medicamento", "insumo_enfermagem", "higiene", "alimentacao", "limpeza", "epi", "utilitario"];

export function idempotencyKey() {
  return randomUUID();
}

export async function ensureLocal(tx, nome, tipo) {
  const rows = await tx.$queryRaw`
    INSERT INTO grupo2.local_armazenamento (nome, tipo)
    VALUES (${nome}, ${tipo})
    ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
    RETURNING id, nome, tipo
  `;
  return rows[0];
}

export async function vincularLocal(tx, produtoId, localId, minima) {
  await tx.$executeRaw`
    INSERT INTO grupo2.produto_local_estoque (produto_id, local_id, quantidade_minima)
    VALUES (${produtoId}::uuid, ${localId}::uuid, ${minima})
    ON CONFLICT (produto_id, local_id) DO UPDATE SET quantidade_minima = EXCLUDED.quantidade_minima
  `;
}

export async function registrarEntrada(tx, { produtoId, localId, codigo, validade, fornecedor, quantidade, motivo, responsavelRef }) {
  const lote = await tx.$queryRaw`
    INSERT INTO grupo2.lote_estoque (produto_id, local_id, codigo, validade, fornecedor, saldo)
    VALUES (${produtoId}::uuid, ${localId}::uuid, ${codigo}, ${validade}::date, ${fornecedor}, 0)
    RETURNING id, codigo, validade, saldo, fornecedor, local_id
  `;
  const movimento = await tx.$queryRaw`
    INSERT INTO grupo2.movimentacao_estoque (
      produto_id, local_id, lote_id, tipo, quantidade, variacao, motivo, responsavel_ref, chave_idempotencia
    ) VALUES (
      ${produtoId}::uuid,
      ${localId}::uuid,
      ${lote[0].id}::uuid,
      'entrada'::grupo2.tipo_movimentacao,
      ${quantidade},
      ${quantidade},
      ${motivo},
      ${responsavelRef}::uuid,
      ${idempotencyKey()}
    )
    RETURNING id, lote_id, tipo::text AS tipo, quantidade, saldo_apos, motivo, ocorrido_em
  `;
  return { lote: lote[0], movimento: movimento[0] };
}

export async function dashboardCounts() {
  const [alerts, low, expired] = await Promise.all([
    prisma.$queryRaw`SELECT count(*)::int AS total FROM grupo2.alertas_temperatura_abertos`,
    prisma.$queryRaw`SELECT count(*)::int AS total FROM grupo2.estoque_abaixo_minimo`,
    prisma.$queryRaw`
      SELECT count(*)::int AS total
      FROM grupo2.lote_estoque
      WHERE saldo > 0 AND validade IS NOT NULL AND validade < grupo2.data_institucional(now())
    `,
  ]);
  return {
    openTempAlerts: alerts[0].total,
    lowStock: low[0].total,
    expiredLots: expired[0].total,
  };
}

export async function stockReport() {
  const [lowStock, expiredLots] = await Promise.all([
    prisma.$queryRaw`
      SELECT produto_id, produto AS nome, local_id, nome_local, quantidade_minima::float8 AS quantidade_minima, saldo_utilizavel::float8 AS saldo_utilizavel
      FROM grupo2.estoque_abaixo_minimo
      ORDER BY produto, nome_local
    `,
    prisma.$queryRaw`
      SELECT l.id, l.codigo, to_char(l.validade, 'YYYY-MM-DD') AS validade, l.saldo::float8 AS saldo, p.nome
      FROM grupo2.lote_estoque l
      JOIN grupo2.produto p ON p.id = l.produto_id
      WHERE l.saldo > 0 AND l.validade IS NOT NULL AND l.validade < grupo2.data_institucional(now())
      ORDER BY l.validade, p.nome
    `,
  ]);
  return { lowStock: present(lowStock), expiredLots: present(expiredLots) };
}

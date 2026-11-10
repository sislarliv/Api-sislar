// US-093 — presença: quem está trabalhando (o que aconteceu). Registro operacional: NÃO substitui o
// controle de ponto. A escala (US-083) é o planejado e fica em outra tabela; a presença pode apontar para o
// turno previsto. Entrada e saída em timestamptz: plantão que atravessa a meia-noite é uma presença só.
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { cruzaMeiaNoite, somarDias } from "../../grupo3/regras.js";
import { dia, horario, idParam, uuid } from "../../grupo3/validacao.js";

const router = Router();
const opcional = (schema) => schema.nullish().transform((value) => value ?? null);

function erroCampo(path, message) {
  return new HttpError(422, "Dados inválidos", [{ path, message }]);
}

const selectSql = `
  SELECT p.id, to_char(p.data, 'YYYY-MM-DD') AS data, p.situacao::text AS situacao, p.entrada_em, p.saida_em,
         to_char(p.entrada_em AT TIME ZONE grupo3.fuso_horario(), 'HH24:MI') AS hora_entrada,
         to_char(p.saida_em AT TIME ZONE grupo3.fuso_horario(), 'HH24:MI') AS hora_saida,
         (p.saida_em AT TIME ZONE grupo3.fuso_horario())::date > p.data AS saida_no_dia_seguinte,
         p.atividade, p.justificativa, p.escala_id, p.criado_em, p.atualizado_em,
         c.id AS colaborador_id, c.nome AS colaborador_nome, c.vinculo::text AS colaborador_vinculo,
         u.id AS registrado_por_id, u.name AS registrado_por_nome
  FROM grupo3.presenca p
  JOIN grupo3.colaborador c ON c.id = p.colaborador_id
  LEFT JOIN public.users u ON u.ref = p.registrado_por_ref
`;

function paraPresenca(row) {
  return {
    id: row.id,
    colaborador: { id: row.colaborador_id, nome: row.colaborador_nome, vinculo: row.colaborador_vinculo },
    data: row.data,
    situacao: row.situacao,
    horaEntrada: row.hora_entrada,
    horaSaida: row.hora_saida,
    saidaNoDiaSeguinte: row.saida_no_dia_seguinte === true,
    entradaEm: row.entrada_em,
    saidaEm: row.saida_em,
    emAndamento: row.situacao === "presente" && !row.saida_em,
    atividade: row.atividade,
    justificativa: row.justificativa,
    escalaId: row.escala_id,
    registradoPor: row.registrado_por_id ? { id: row.registrado_por_id, nome: row.registrado_por_nome } : null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function buscarPresenca(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectSql} WHERE p.id = $1::uuid`, id);
  return rows[0] ? paraPresenca(rows[0]) : null;
}

async function hojeInstitucional(db = prisma) {
  const rows = await db.$queryRaw`SELECT to_char((now() AT TIME ZONE grupo3.fuso_horario())::date, 'YYYY-MM-DD') AS hoje`;
  return rows[0].hoje;
}

// Hora local -> instante. Saída menor ou igual à entrada = dia seguinte.
async function instante(db, data, hora) {
  const rows = await db.$queryRaw`SELECT ((${data}::date + ${hora}::time) AT TIME ZONE grupo3.fuso_horario()) AS em`;
  return rows[0].em;
}

async function saidaEm(db, data, horaEntrada, horaSaida) {
  return instante(db, cruzaMeiaNoite(horaEntrada, horaSaida) ? somarDias(data, 1) : data, horaSaida);
}

router.get(
  "/presencas",
  requirePerm("equipe.visualizar"),
  validate(pageSchema.extend({
    data: dia.optional(),
    inicio: dia.optional(),
    fim: dia.optional(),
    colaboradorId: uuid.optional(),
    vinculo: z.enum(["funcionario", "voluntario", "externo"]).optional(),
    situacao: z.enum(["presente", "ausente"]).optional(),
    emAndamento: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, data, colaboradorId, vinculo, situacao, emAndamento } = req.query;
    const inicio = data ?? req.query.inicio ?? null;
    const fim = data ?? req.query.fim ?? null;
    if (inicio && fim && fim < inicio) throw erroCampo("fim", "O fim precisa ser igual ou depois do início.");
    const rows = await prisma.$queryRawUnsafe(
      `${selectSql.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
       WHERE ($1::date IS NULL OR p.data >= $1::date)
         AND ($2::date IS NULL OR p.data <= $2::date)
         AND ($3::uuid IS NULL OR p.colaborador_id = $3::uuid)
         AND ($4::text IS NULL OR c.vinculo::text = $4)
         AND ($5::text IS NULL OR p.situacao::text = $5)
         AND ($6::boolean IS NULL OR (p.situacao = 'presente' AND p.saida_em IS NULL) = $6)
       ORDER BY p.data DESC, p.entrada_em NULLS LAST, c.nome LIMIT $7 OFFSET $8`,
      inicio, fim, colaboradorId ?? null, vinculo ?? null, situacao ?? null, emAndamento ?? null, limit, (page - 1) * limit,
    );
    res.json({ data: rows.map(paraPresenca), meta: pageMeta(page, limit, rows[0]?.total ?? 0) });
  }),
);

router.post(
  "/presencas",
  requirePerm("equipe.criar"),
  validate(z.object({
    colaboradorId: uuid,
    data: dia,
    situacao: z.enum(["presente", "ausente"]).default("presente"),
    horaEntrada: opcional(horario),
    horaSaida: opcional(horario),
    atividade: opcional(z.string().trim().min(2).max(300)),
    justificativa: opcional(z.string().trim().min(3).max(500)),
    escalaId: opcional(uuid),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (b.situacao === "presente" && !b.horaEntrada) throw erroCampo("horaEntrada", "Informe a hora de entrada.");
    if (b.situacao === "ausente" && (b.horaEntrada || b.horaSaida)) throw erroCampo("situacao", "Ausência não tem horário de entrada ou saída.");
    if (b.horaSaida && b.horaSaida === b.horaEntrada) throw erroCampo("horaSaida", "Saída igual à entrada.");
    const presenca = await prisma.$transaction(async (tx) => {
      if (b.data > await hojeInstitucional(tx)) throw erroCampo("data", "Presença não pode ser registrada para data futura.");
      const colaborador = (await tx.$queryRaw`
        SELECT id, status::text AS status FROM grupo3.colaborador WHERE id = ${b.colaboradorId}::uuid
      `)[0];
      if (!colaborador) throw erroCampo("colaboradorId", "Colaborador não encontrado.");
      if (colaborador.status !== "ativo") throw erroCampo("colaboradorId", "Colaborador inativo.");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`grupo3.presenca:${b.colaboradorId}`}, 0))`;
      if (b.escalaId) {
        const escala = (await tx.$queryRaw`
          SELECT colaborador_id, to_char(inicio AT TIME ZONE grupo3.fuso_horario(), 'YYYY-MM-DD') AS data, situacao::text AS situacao
          FROM grupo3.escala WHERE id = ${b.escalaId}::uuid
        `)[0];
        if (!escala) throw erroCampo("escalaId", "Escala não encontrada.");
        if (escala.colaborador_id !== b.colaboradorId.toLowerCase() || escala.data !== b.data) {
          throw erroCampo("escalaId", "A escala precisa ser do mesmo colaborador e começar na mesma data.");
        }
        if (escala.situacao === "cancelada") throw erroCampo("escalaId", "Escala cancelada.");
        const jaTem = await tx.$queryRaw`SELECT 1 FROM grupo3.presenca WHERE escala_id = ${b.escalaId}::uuid`;
        if (jaTem.length) throw new HttpError(409, "Já existe presença registrada para esta escala.");
      }
      if (b.situacao === "presente") {
        const aberta = await tx.$queryRaw`
          SELECT 1 FROM grupo3.presenca
          WHERE colaborador_id = ${b.colaboradorId}::uuid AND situacao = 'presente' AND saida_em IS NULL
        `;
        if (aberta.length) throw new HttpError(409, "O colaborador já tem presença em aberto. Registre a saída antes.");
      }
      const entrada = b.horaEntrada ? await instante(tx, b.data, b.horaEntrada) : null;
      const saida = b.horaSaida ? await saidaEm(tx, b.data, b.horaEntrada, b.horaSaida) : null;
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.presenca (colaborador_id, escala_id, data, situacao, entrada_em, saida_em, atividade, justificativa, registrado_por_ref)
        VALUES (${b.colaboradorId}::uuid, ${b.escalaId}::uuid, ${b.data}::date, ${b.situacao}::grupo3.situacao_presenca,
                ${entrada}, ${saida}, ${b.atividade}, ${b.justificativa}, ${req.user.ref}::uuid)
        RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "presenca.registrar", entity: "grupo3.presenca", entityId: rows[0].id,
        payload: { resultado: "sucesso", colaboradorId: b.colaboradorId, data: b.data, situacao: b.situacao },
      });
      return buscarPresenca(rows[0].id, tx);
    });
    res.status(201).json(presenca);
  }),
);

router.patch(
  "/presencas/:id/saida",
  requirePerm("equipe.criar", "equipe.editar"),
  validate(idParam, "params"),
  validate(z.object({ horaSaida: horario })),
  asyncHandler(async (req, res) => {
    const presenca = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT id, situacao::text AS situacao, to_char(data, 'YYYY-MM-DD') AS data, saida_em,
               to_char(entrada_em AT TIME ZONE grupo3.fuso_horario(), 'HH24:MI') AS hora_entrada
        FROM grupo3.presenca WHERE id = ${req.params.id}::uuid FOR UPDATE
      `;
      const atual = rows[0];
      if (!atual) notFound("Presença não encontrada.");
      if (atual.situacao !== "presente" || atual.saida_em) throw new HttpError(409, "A saída já foi registrada ou não se aplica.");
      if (req.body.horaSaida === atual.hora_entrada) throw erroCampo("horaSaida", "Saída igual à entrada.");
      const saida = await saidaEm(tx, atual.data, atual.hora_entrada, req.body.horaSaida);
      await tx.$executeRaw`UPDATE grupo3.presenca SET saida_em = ${saida} WHERE id = ${atual.id}::uuid`;
      await audit(tx, {
        userId: req.user.id, action: "presenca.saida", entity: "grupo3.presenca", entityId: atual.id,
        payload: { resultado: "sucesso", saidaEm: saida },
      });
      return buscarPresenca(atual.id, tx);
    });
    res.json(presenca);
  }),
);

export default router;

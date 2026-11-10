// Cadastro único da equipe — US-082 (profissionais médicos e odontológicos, inclusive voluntários),
// US-091 (funcionários) e US-092 (voluntários e externos), com disponibilidade semanal.
// Contatos (e-mail e telefone) só aparecem para quem tem equipe.visualizar. Sem CPF nem documento.
import { Router } from "express";
import { z } from "zod";
import { audit, notFound } from "../../db/helpers.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { pageMeta, pageSchema } from "../../lib/paging.js";
import { likeTerm } from "../../lib/schemas.js";
import { asyncHandler } from "../../middleware/async.js";
import { requirePerm } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { reativarLembretesSemDestinatario } from "../../grupo3/lembretes.js";
import { horariosSobrepoem, mascararContatos } from "../../grupo3/regras.js";
import { horario, horarioFim, idParam, usuarioId, uuid } from "../../grupo3/validacao.js";
import { exigirEspecialidadeAtiva } from "./especialidades.js";

const router = Router();

const vinculo = z.enum(["funcionario", "voluntario", "externo"]);
const status = z.enum(["ativo", "inativo"]);
const opcional = (schema) => schema.nullish().transform((value) => value ?? null);

const corpo = z.object({
  nome: z.string().trim().min(3).max(160),
  vinculo,
  cargo: opcional(z.string().trim().min(2).max(120)),
  setor: opcional(z.string().trim().min(2).max(120)),
  especialidadeId: opcional(uuid),
  registroProfissional: opcional(z.string().trim().min(2).max(60)),
  email: opcional(z.string().trim().toLowerCase().email("E-mail inválido.").max(160)),
  telefone: opcional(z.string().trim().regex(/^[0-9 ()+-]{8,20}$/, "Telefone inválido.")),
  usuarioId: opcional(usuarioId),
});

const selectSql = `
  SELECT c.id, c.nome, c.vinculo::text AS vinculo, c.status::text AS status, c.cargo, c.setor,
         c.especialidade_id, es.nome AS especialidade_nome,
         c.registro_profissional, c.email, c.telefone, c.criado_em, c.atualizado_em,
         u.id AS usuario_id, u.name AS usuario_nome
  FROM grupo3.colaborador c
  LEFT JOIN grupo3.especialidade es ON es.id = c.especialidade_id
  LEFT JOIN public.users u ON u.ref = c.usuario_ref
`;

function paraColaborador(row) {
  return {
    id: row.id,
    nome: row.nome,
    vinculo: row.vinculo,
    status: row.status,
    cargo: row.cargo,
    setor: row.setor,
    especialidade: row.especialidade_id ? { id: row.especialidade_id, nome: row.especialidade_nome } : null,
    registroProfissional: row.registro_profissional,
    email: row.email,
    telefone: row.telefone,
    usuario: row.usuario_id ? { id: row.usuario_id, nome: row.usuario_nome } : null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

export async function buscarColaborador(id, db = prisma) {
  const rows = await db.$queryRawUnsafe(`${selectSql} WHERE c.id = $1::uuid`, id);
  return rows[0] ? paraColaborador(rows[0]) : null;
}

async function refDoUsuario(db, id, ignorarColaboradorId = null) {
  if (!id) return null;
  const users = await db.$queryRaw`SELECT ref, active FROM public.users WHERE id = ${id}`;
  if (!users[0]) throw new HttpError(422, "Dados inválidos", [{ path: "usuarioId", message: "Usuário não encontrado." }]);
  const vinculado = await db.$queryRaw`
    SELECT id FROM grupo3.colaborador
    WHERE usuario_ref = ${users[0].ref}::uuid AND (${ignorarColaboradorId}::uuid IS NULL OR id <> ${ignorarColaboradorId}::uuid)
  `;
  if (vinculado[0]) throw new HttpError(409, "Este usuário já está vinculado a outro colaborador.");
  return users[0].ref;
}

// Auditoria sem contatos: só registra quais campos mudaram.
function camposAlterados(anterior, novo) {
  const atual = { ...anterior, especialidadeId: anterior.especialidade?.id ?? null };
  return Object.keys(novo).filter((campo) => campo !== "usuarioId" && (atual[campo] ?? null) !== (novo[campo] ?? null));
}

router.get(
  "/colaboradores",
  requirePerm("equipe.visualizar", "agenda.criar", "agenda.editar"),
  validate(pageSchema.extend({
    vinculo: vinculo.optional(),
    status: status.optional(),
    setor: z.string().trim().min(1).max(120).optional(),
    especialidadeId: uuid.optional(),
    q: z.string().trim().min(1).max(80).optional(),
  }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, vinculo: v, status: s, setor, especialidadeId: esp, q } = req.query;
    const rows = await prisma.$queryRawUnsafe(
      `${selectSql.replace("SELECT", "SELECT count(*) OVER()::int AS total,")}
       WHERE ($1::text IS NULL OR c.vinculo::text = $1)
         AND ($2::text IS NULL OR c.status::text = $2)
         AND ($3::text IS NULL OR c.nome ILIKE $3)
         AND ($4::text IS NULL OR lower(c.setor) = lower($4))
         AND ($5::uuid IS NULL OR c.especialidade_id = $5::uuid)
       ORDER BY lower(c.nome) LIMIT $6 OFFSET $7`,
      v ?? null, s ?? null, q ? likeTerm(q) : null, setor ?? null, esp ?? null, limit, (page - 1) * limit,
    );
    res.json({
      data: rows.map((row) => mascararContatos(paraColaborador(row), req.user)),
      meta: pageMeta(page, limit, rows[0]?.total ?? 0),
    });
  }),
);

router.get(
  "/colaboradores/:id",
  requirePerm("equipe.visualizar", "agenda.criar", "agenda.editar"),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const colaborador = await buscarColaborador(req.params.id);
    if (!colaborador) notFound("Colaborador não encontrado.");
    res.json(mascararContatos(colaborador, req.user));
  }),
);

router.post(
  "/colaboradores",
  requirePerm("equipe.criar"),
  validate(corpo),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const colaborador = await prisma.$transaction(async (tx) => {
      const ref = await refDoUsuario(tx, b.usuarioId);
      await exigirEspecialidadeAtiva(tx, b.especialidadeId);
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.colaborador (nome, vinculo, cargo, setor, especialidade_id, registro_profissional, email, telefone, usuario_ref)
        VALUES (${b.nome}, ${b.vinculo}::grupo3.vinculo_colaborador, ${b.cargo}, ${b.setor}, ${b.especialidadeId}::uuid,
                ${b.registroProfissional}, ${b.email}, ${b.telefone}, ${ref}::uuid)
        RETURNING id
      `;
      await audit(tx, {
        userId: req.user.id, action: "colaborador.criar", entity: "grupo3.colaborador", entityId: rows[0].id,
        payload: { resultado: "sucesso", vinculo: b.vinculo, especialidadeId: b.especialidadeId, usuarioId: b.usuarioId },
      });
      return buscarColaborador(rows[0].id, tx);
    });
    res.status(201).json(colaborador);
  }),
);

router.put(
  "/colaboradores/:id",
  requirePerm("equipe.editar"),
  validate(idParam, "params"),
  validate(corpo),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const colaborador = await prisma.$transaction(async (tx) => {
      const atual = await buscarColaborador(req.params.id, tx);
      if (!atual) notFound("Colaborador não encontrado.");
      const ref = await refDoUsuario(tx, b.usuarioId, atual.id);
      if (b.especialidadeId !== (atual.especialidade?.id ?? null)) await exigirEspecialidadeAtiva(tx, b.especialidadeId);
      await tx.$executeRaw`
        UPDATE grupo3.colaborador
        SET nome = ${b.nome}, vinculo = ${b.vinculo}::grupo3.vinculo_colaborador, cargo = ${b.cargo}, setor = ${b.setor},
            especialidade_id = ${b.especialidadeId}::uuid, registro_profissional = ${b.registroProfissional},
            email = ${b.email}, telefone = ${b.telefone}, usuario_ref = ${ref}::uuid
        WHERE id = ${atual.id}::uuid
      `;
      await reativarLembretesSemDestinatario(tx, atual.id, ref);
      await audit(tx, {
        userId: req.user.id, action: "colaborador.editar", entity: "grupo3.colaborador", entityId: atual.id,
        payload: {
          resultado: "sucesso",
          campos: camposAlterados(atual, b),
          usuario: { anterior: atual.usuario?.id ?? null, novo: b.usuarioId },
        },
      });
      return buscarColaborador(atual.id, tx);
    });
    res.json(colaborador);
  }),
);

router.patch(
  "/colaboradores/:id/status",
  requirePerm("equipe.excluir"),
  validate(idParam, "params"),
  validate(z.object({ status })),
  asyncHandler(async (req, res) => {
    const colaborador = await prisma.$transaction(async (tx) => {
      const atual = await buscarColaborador(req.params.id, tx);
      if (!atual) notFound("Colaborador não encontrado.");
      await tx.$executeRaw`
        UPDATE grupo3.colaborador SET status = ${req.body.status}::grupo3.status_colaborador WHERE id = ${atual.id}::uuid
      `;
      await audit(tx, {
        userId: req.user.id, action: `colaborador.${req.body.status === "ativo" ? "ativar" : "inativar"}`,
        entity: "grupo3.colaborador", entityId: atual.id, payload: { resultado: "sucesso", anterior: atual.status },
      });
      return buscarColaborador(atual.id, tx);
    });
    res.json(colaborador);
  }),
);

// ---------- Disponibilidade (US-082, US-092) ----------

const disponibilidade = z.object({
  diaSemana: z.number().int().min(1).max(7),
  horaInicio: horario,
  horaFim: horarioFim,
  observacao: opcional(z.string().trim().min(1).max(300)),
}).refine((d) => d.horaFim > d.horaInicio, { message: "O fim precisa ser depois do início.", path: ["horaFim"] });

export async function listarDisponibilidades(colaboradorId, db = prisma) {
  const rows = await db.$queryRaw`
    SELECT id, dia_semana, to_char(hora_inicio, 'HH24:MI') AS hora_inicio, to_char(hora_fim, 'HH24:MI') AS hora_fim, observacao
    FROM grupo3.disponibilidade_colaborador
    WHERE colaborador_id = ${colaboradorId}::uuid
    ORDER BY dia_semana, hora_inicio
  `;
  return rows.map((row) => ({
    id: row.id, diaSemana: row.dia_semana, horaInicio: row.hora_inicio, horaFim: row.hora_fim, observacao: row.observacao,
  }));
}

router.get(
  "/colaboradores/:id/disponibilidades",
  requirePerm("equipe.visualizar", "agenda.criar", "agenda.editar"),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const colaborador = await buscarColaborador(req.params.id);
    if (!colaborador) notFound("Colaborador não encontrado.");
    res.json({ colaborador: { id: colaborador.id, nome: colaborador.nome }, data: await listarDisponibilidades(colaborador.id) });
  }),
);

// Substitui a disponibilidade inteira do colaborador (lista vazia = sem disponibilidade declarada).
router.put(
  "/colaboradores/:id/disponibilidades",
  requirePerm("equipe.editar"),
  validate(idParam, "params"),
  validate(z.object({ disponibilidades: z.array(disponibilidade).max(28) })),
  asyncHandler(async (req, res) => {
    const lista = req.body.disponibilidades;
    for (let i = 0; i < lista.length; i += 1) {
      for (let j = i + 1; j < lista.length; j += 1) {
        if (lista[i].diaSemana === lista[j].diaSemana
          && horariosSobrepoem({ inicio: lista[i].horaInicio, fim: lista[i].horaFim }, { inicio: lista[j].horaInicio, fim: lista[j].horaFim })) {
          throw new HttpError(422, "Dados inválidos", [{ path: `disponibilidades.${j}`, message: "Horários sobrepostos no mesmo dia." }]);
        }
      }
    }
    const data = await prisma.$transaction(async (tx) => {
      const colaborador = await buscarColaborador(req.params.id, tx);
      if (!colaborador) notFound("Colaborador não encontrado.");
      // Disponibilidade é declaração atual, não histórico: substituir é seguro e fica na auditoria.
      await tx.$executeRaw`DELETE FROM grupo3.disponibilidade_colaborador WHERE colaborador_id = ${colaborador.id}::uuid`;
      for (const d of lista) {
        await tx.$executeRaw`
          INSERT INTO grupo3.disponibilidade_colaborador (colaborador_id, dia_semana, hora_inicio, hora_fim, observacao)
          VALUES (${colaborador.id}::uuid, ${d.diaSemana}, ${d.horaInicio}::time, ${d.horaFim}::time, ${d.observacao})
        `;
      }
      await audit(tx, {
        userId: req.user.id, action: "colaborador.disponibilidade", entity: "grupo3.colaborador", entityId: colaborador.id,
        payload: { resultado: "sucesso", disponibilidades: lista.map(({ diaSemana, horaInicio, horaFim }) => ({ diaSemana, horaInicio, horaFim })) },
      });
      return listarDisponibilidades(colaborador.id, tx);
    });
    res.json({ data });
  }),
);

export default router;

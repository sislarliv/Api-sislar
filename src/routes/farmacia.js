import { Router } from "express";
import { z } from "zod";
import { notFound } from "../db/helpers.js";
import { ensureLocal, idempotencyKey, registrarEntrada, vincularLocal } from "../db/grupo2.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { assertNotTooFuture } from "../lib/evolutionRules.js";
import { uuidParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth, requirePerm("modulo.farmacia"));

const horario = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido.");
const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pacienteId = z.string().regex(/^[A-Za-z0-9_-]+$/);

function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function lotesDe(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return JSON.parse(value);
  return [];
}

const medicamentoSql = `
  SELECT p.id, p.nome, p.unidade, p.ativo,
         m.principio_ativo, m.apresentacao, m.concentracao, m.controlado, m.cadeia_frio,
         coalesce(min(e.quantidade_minima), 0)::float8 AS quantidade_minima,
         coalesce(sum(l.saldo), 0)::float8 AS saldo,
         coalesce(sum(CASE
           WHEN l.validade IS NULL OR l.validade >= grupo2.data_institucional(now()) THEN greatest(l.saldo, 0)
           ELSE 0 END), 0)::float8 AS saldo_utilizavel,
         coalesce((
           SELECT json_agg(json_build_object(
             'id', lote.id,
             'codigo', lote.codigo,
             'validade', to_char(lote.validade, 'YYYY-MM-DD'),
             'saldo', lote.saldo::float8,
             'fornecedor', lote.fornecedor,
             'localId', lote.local_id
           ) ORDER BY lote.validade NULLS LAST, lote.codigo)
           FROM grupo2.lote_estoque lote
           WHERE lote.produto_id = p.id
         ), '[]'::json) AS lotes
  FROM grupo2.produto p
  JOIN grupo2.medicamento m ON m.produto_id = p.id
  LEFT JOIN grupo2.produto_local_estoque e ON e.produto_id = p.id
  LEFT JOIN grupo2.lote_estoque l ON l.produto_id = p.id
`;

function apresentarMedicamento(row) {
  const item = present(row);
  const lotes = lotesDe(item.lotes);
  return {
    ...item,
    lotes,
    belowMin: Number(item.saldoUtilizavel) < Number(item.quantidadeMinima),
    hasExpiredLot: lotes.some((lote) => Number(lote.saldo) > 0 && lote.validade && lote.validade < today()),
  };
}

router.get("/medicamentos", asyncHandler(async (_req, res) => {
  const rows = await prisma.$queryRawUnsafe(`${medicamentoSql} GROUP BY p.id, m.produto_id ORDER BY p.nome`);
  res.json({ data: rows.map(apresentarMedicamento) });
}));

router.get("/medicamentos/:id", validate(uuidParam, "params"), asyncHandler(async (req, res) => {
  const rows = await prisma.$queryRawUnsafe(
    `${medicamentoSql} WHERE p.id = $1::uuid GROUP BY p.id, m.produto_id`,
    req.params.id,
  );
  if (!rows[0]) notFound();
  res.json(apresentarMedicamento(rows[0]));
}));

router.post(
  "/medicamentos",
  requirePerm("estoque.manage"),
  validate(z.object({
    name: z.string().trim().min(2).max(160),
    activeIngredient: z.string().trim().min(2).max(160),
    form: z.string().trim().min(2).max(80),
    strength: z.string().trim().min(1).max(40),
    unit: z.string().trim().min(1).max(30),
    minQty: z.number().min(0).max(1000000),
    location: z.string().trim().min(2).max(80),
    coldChain: z.boolean().optional(),
    controlled: z.boolean().optional(),
  })),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const local = await ensureLocal(tx, req.body.location, "farmacia");
      const created = await tx.$queryRaw`
        INSERT INTO grupo2.produto (nome, categoria, unidade)
        VALUES (${req.body.name}, 'medicamento'::grupo2.categoria_produto, ${req.body.unit})
        RETURNING id, nome, unidade, ativo
      `;
      await tx.$executeRaw`
        INSERT INTO grupo2.medicamento (produto_id, principio_ativo, apresentacao, concentracao, controlado, cadeia_frio)
        VALUES (
          ${created[0].id}::uuid,
          ${req.body.activeIngredient},
          ${req.body.form},
          ${req.body.strength},
          ${req.body.controlled ?? false},
          ${req.body.coldChain ?? false}
        )
      `;
      await vincularLocal(tx, created[0].id, local.id, req.body.minQty);
      return created[0];
    });
    res.status(201).json(present(row));
  }),
);

router.post(
  "/medicamentos/:id/lotes",
  requirePerm("estoque.manage"),
  validate(uuidParam, "params"),
  validate(z.object({
    code: z.string().trim().min(2).max(40),
    expiry: dia.nullable().optional(),
    qty: z.number().positive().max(1000000),
    supplier: z.string().trim().min(2).max(120),
    localId: z.string().uuid().optional(),
  })),
  asyncHandler(async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      const meds = await tx.$queryRaw`SELECT produto_id FROM grupo2.medicamento WHERE produto_id = ${req.params.id}::uuid`;
      if (!meds[0]) notFound();
      const locais = await tx.$queryRaw`
        SELECT local_id FROM grupo2.produto_local_estoque WHERE produto_id = ${req.params.id}::uuid
      `;
      const localId = req.body.localId ?? (locais.length === 1 ? locais[0].local_id : null);
      if (!localId) throw new HttpError(422, "Informe o local do lote.");
      if (!locais.some((item) => item.local_id === localId)) throw new HttpError(422, "Produto não está nesse local.");
      return registrarEntrada(tx, {
        produtoId: req.params.id,
        localId,
        codigo: req.body.code,
        validade: req.body.expiry ?? null,
        fornecedor: req.body.supplier,
        quantidade: req.body.qty,
        motivo: "Entrada de lote",
        responsavelRef: req.user.ref,
      });
    });
    res.status(201).json(present(created.lote));
  }),
);

router.get("/prescricoes", asyncHandler(async (req, res) => {
  const patientId = typeof req.query.patientId === "string" ? req.query.patientId : null;
  const rows = await prisma.$queryRaw`
    SELECT p.id, p.situacao::text AS situacao, p.inicio_em, p.termino_em, p.motivo_situacao, p.criado_em,
           pt.id AS patient_id, pt.name AS patient_name,
           coalesce(json_agg(json_build_object(
             'id', ip.id,
             'produtoId', ip.produto_id,
             'nome', pr.nome,
             'dose', ip.texto_dose,
             'unidadesPorDose', ip.unidades_por_dose::float8,
             'via', ip.via_administracao,
             'instrucoes', ip.instrucoes,
             'horarios', coalesce((
               SELECT json_agg(to_char(ad.horario, 'HH24:MI') ORDER BY ad.horario)
               FROM grupo2.agenda_dose ad WHERE ad.item_prescricao_id = ip.id
             ), '[]'::json)
           ) ORDER BY pr.nome) FILTER (WHERE ip.id IS NOT NULL), '[]'::json) AS itens
    FROM grupo2.prescricao p
    JOIN patients pt ON pt.ref = p.idoso_ref
    LEFT JOIN grupo2.item_prescricao ip ON ip.prescricao_id = p.id
    LEFT JOIN grupo2.produto pr ON pr.id = ip.produto_id
    WHERE ${patientId}::text IS NULL OR pt.id = ${patientId}
    GROUP BY p.id, pt.id
    ORDER BY p.inicio_em DESC
  `;
  res.json({ data: present(rows) });
}));

router.post(
  "/prescricoes",
  requirePerm("farmacia.prescrever"),
  validate(z.object({
    patientId: pacienteId,
    startDate: dia,
    endDate: dia.nullish(),
    itens: z.array(z.object({
      produtoId: z.string().uuid(),
      dose: z.string().trim().min(1).max(80),
      unidadesPorDose: z.number().positive().max(1000000).default(1),
      via: z.string().trim().min(1).max(40),
      instrucoes: z.string().trim().max(500).nullish(),
      horarios: z.array(horario).min(1).max(24),
    })).min(1).max(20),
  })),
  asyncHandler(async (req, res) => {
    if (req.body.endDate && req.body.endDate < req.body.startDate) throw new HttpError(422, "A data final precisa ser igual ou posterior ao início.");
    const created = await prisma.$transaction(async (tx) => {
      const patient = await tx.patients.findUnique({ where: { id: req.body.patientId }, select: { ref: true } });
      if (!patient) notFound("Morador não encontrado.");
      const prescricao = await tx.$queryRaw`
        INSERT INTO grupo2.prescricao (idoso_ref, prescritor_ref, registrado_por_ref, inicio_em, termino_em)
        VALUES (
          ${patient.ref}::uuid,
          ${req.user.ref}::uuid,
          ${req.user.ref}::uuid,
          ${req.body.startDate}::date,
          ${req.body.endDate ?? null}::date
        )
        RETURNING id, situacao::text AS situacao, inicio_em, termino_em
      `;
      for (const item of req.body.itens) {
        const med = await tx.$queryRaw`SELECT produto_id FROM grupo2.medicamento WHERE produto_id = ${item.produtoId}::uuid`;
        if (!med[0]) notFound("Medicamento não encontrado.");
        const gravado = await tx.$queryRaw`
          INSERT INTO grupo2.item_prescricao (prescricao_id, produto_id, texto_dose, unidades_por_dose, via_administracao, instrucoes)
          VALUES (
            ${prescricao[0].id}::uuid,
            ${item.produtoId}::uuid,
            ${item.dose},
            ${item.unidadesPorDose},
            ${item.via},
            ${item.instrucoes ?? null}
          )
          RETURNING id
        `;
        for (const hora of item.horarios) {
          await tx.$executeRaw`
            INSERT INTO grupo2.agenda_dose (item_prescricao_id, horario)
            VALUES (${gravado[0].id}::uuid, ${hora}::time)
          `;
        }
      }
      return prescricao[0];
    });
    res.status(201).json(present(created));
  }),
);

router.patch(
  "/prescricoes/:id",
  requirePerm("farmacia.prescrever"),
  validate(uuidParam, "params"),
  validate(z.object({
    status: z.enum(["ativa", "suspensa", "encerrada"]),
    motivo: z.string().trim().min(1).max(500),
  })),
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw`
      UPDATE grupo2.prescricao
      SET situacao = ${req.body.status}::grupo2.situacao_prescricao,
          motivo_situacao = ${req.body.motivo},
          responsavel_situacao_ref = ${req.user.ref}::uuid
      WHERE id = ${req.params.id}::uuid
      RETURNING id, situacao::text AS situacao, motivo_situacao
    `;
    if (!rows[0]) notFound();
    res.json(present(rows[0]));
  }),
);

router.get("/administracoes", asyncHandler(async (_req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT a.id, a.item_prescricao_id, pt.id AS patient_id, a.agendado_em,
           a.situacao::text AS situacao, a.quantidade_administrada::float8 AS quantidade_administrada,
           a.motivo, a.registrado_em
    FROM grupo2.administracao_atual a
    JOIN grupo2.item_prescricao ip ON ip.id = a.item_prescricao_id
    JOIN grupo2.prescricao p ON p.id = ip.prescricao_id
    JOIN patients pt ON pt.ref = p.idoso_ref
    ORDER BY a.agendado_em DESC
    LIMIT 200
  `;
  res.json({ data: present(rows) });
}));

router.post(
  "/administracoes",
  requirePerm("farmacia.administrar"),
  validate(z.object({
    itemPrescricaoId: z.string().uuid(),
    scheduledAt: z.coerce.date(),
    status: z.enum(["administrada", "recusada", "adiada", "nao_administrada", "cancelada"]),
    quantidade: z.number().positive().max(1000000).optional(),
    motivo: z.string().trim().max(500).optional(),
  }).superRefine((body, ctx) => {
    if (body.status === "administrada" && body.quantidade == null) {
      ctx.addIssue({ code: "custom", path: ["quantidade"], message: "Informe a quantidade administrada." });
    }
    if (body.status !== "administrada" && !body.motivo) {
      ctx.addIssue({ code: "custom", path: ["motivo"], message: "Informe o motivo." });
    }
  })),
  asyncHandler(async (req, res) => {
    const scheduledAt = assertNotTooFuture(req.body.scheduledAt, "Horário previsto");
    const rows = await prisma.$queryRaw`
      INSERT INTO grupo2.administracao (
        item_prescricao_id, idoso_ref, agendado_em, agendado_data, agendado_horario,
        situacao, quantidade_administrada, motivo, responsavel_ref, chave_idempotencia
      )
      SELECT ${req.body.itemPrescricaoId}::uuid, p.idoso_ref, ${scheduledAt}, CURRENT_DATE, '00:00'::time,
             ${req.body.status}::grupo2.situacao_dose, ${req.body.quantidade ?? null}, ${req.body.motivo ?? null},
             ${req.user.ref}::uuid, ${idempotencyKey()}
      FROM grupo2.item_prescricao ip
      JOIN grupo2.prescricao p ON p.id = ip.prescricao_id
      WHERE ip.id = ${req.body.itemPrescricaoId}::uuid
      RETURNING id, item_prescricao_id, agendado_em, situacao::text AS situacao, quantidade_administrada, motivo
    `;
    if (!rows[0]) notFound("Item da prescrição não encontrado.");
    res.status(201).json(present(rows[0]));
  }),
);

router.post(
  "/administracoes/:id/correcoes",
  requirePerm("farmacia.administrar"),
  validate(uuidParam, "params"),
  validate(z.object({
    status: z.enum(["administrada", "recusada", "adiada", "nao_administrada", "cancelada"]),
    quantidade: z.number().positive().max(1000000).nullish(),
    motivo: z.string().trim().min(3).max(500),
  })),
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw`
      INSERT INTO grupo2.correcao_administracao (
        administracao_id, situacao_corrigida, quantidade_corrigida, motivo, responsavel_ref, chave_idempotencia
      )
      SELECT ${req.params.id}::uuid, ${req.body.status}::grupo2.situacao_dose, ${req.body.quantidade ?? null},
             ${req.body.motivo}, ${req.user.ref}::uuid, ${idempotencyKey()}
      FROM grupo2.administracao
      WHERE id = ${req.params.id}::uuid
      RETURNING id, administracao_id, situacao_corrigida::text AS situacao, quantidade_corrigida, motivo, corrigido_em
    `;
    if (!rows[0]) notFound();
    res.status(201).json(present(rows[0]));
  }),
);

router.get("/dispensacoes", asyncHandler(async (_req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT d.id, d.dispensado_em, d.observacao, pt.id AS patient_id, pt.name AS patient_name,
           coalesce(json_agg(json_build_object(
             'id', i.id,
             'produtoId', i.produto_id,
             'nome', p.nome,
             'loteId', i.lote_id,
             'quantidade', i.quantidade::float8
           ) ORDER BY p.nome) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS itens
    FROM grupo2.dispensacao d
    JOIN patients pt ON pt.ref = d.idoso_ref
    LEFT JOIN grupo2.item_dispensacao i ON i.dispensacao_id = d.id
    LEFT JOIN grupo2.produto p ON p.id = i.produto_id
    GROUP BY d.id, pt.id
    ORDER BY d.dispensado_em DESC
    LIMIT 200
  `;
  res.json({ data: present(rows) });
}));

router.post(
  "/dispensacoes",
  requirePerm("farmacia.dispensar"),
  validate(z.object({
    lotId: z.string().uuid(),
    patientId: pacienteId,
    qty: z.number().positive().max(1000000),
    itemPrescricaoId: z.string().uuid().optional(),
    notes: z.string().trim().max(500).optional(),
  })),
  asyncHandler(async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      const patient = await tx.patients.findUnique({ where: { id: req.body.patientId }, select: { ref: true } });
      if (!patient) notFound("Morador não encontrado.");
      const lote = await tx.$queryRaw`
        SELECT id, produto_id FROM grupo2.lote_estoque WHERE id = ${req.body.lotId}::uuid
      `;
      if (!lote[0]) notFound("Lote não encontrado.");
      const dispensacao = await tx.$queryRaw`
        INSERT INTO grupo2.dispensacao (idoso_ref, responsavel_ref, chave_idempotencia, observacao)
        VALUES (${patient.ref}::uuid, ${req.user.ref}::uuid, ${idempotencyKey()}, ${req.body.notes ?? null})
        RETURNING id, dispensado_em, observacao
      `;
      await tx.$executeRaw`
        INSERT INTO grupo2.item_dispensacao (dispensacao_id, item_prescricao_id, produto_id, lote_id, quantidade)
        VALUES (
          ${dispensacao[0].id}::uuid,
          ${req.body.itemPrescricaoId ?? null}::uuid,
          ${lote[0].produto_id}::uuid,
          ${lote[0].id}::uuid,
          ${req.body.qty}
        )
      `;
      return dispensacao[0];
    });
    res.status(201).json(present(created));
  }),
);

export default router;

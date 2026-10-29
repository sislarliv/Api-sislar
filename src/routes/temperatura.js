import { Router } from "express";
import { z } from "zod";
import { notFound } from "../db/helpers.js";
import { idempotencyKey } from "../db/grupo2.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { assertNotTooFuture } from "../lib/evolutionRules.js";
import { uuidParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth, requirePerm("modulo.temperatura"));

const tipos = ["freezer", "geladeira", "camara", "ambiente"];
const temperatura = z.number().gte(-9999.99).lte(9999.99);

function equipamento(row, sensors) {
  return {
    id: row.id,
    name: row.nome,
    location: row.localizacao,
    kind: row.tipo,
    content: row.conteudo,
    minTemp: Number(row.temperatura_minima_c),
    maxTemp: Number(row.temperatura_maxima_c),
    active: row.ativo,
    lastValue: row.last_value == null ? null : Number(row.last_value),
    sensors: sensors.map((sensor) => ({ id: sensor.id, code: sensor.rotulo, active: sensor.ativo })),
  };
}

async function sensoresPorEquipamento() {
  const rows = await prisma.$queryRaw`
    SELECT id, equipamento_id, rotulo, ativo
    FROM grupo2.configuracao_sensor
    ORDER BY rotulo
  `;
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.equipamento_id) ?? [];
    list.push(row);
    grouped.set(row.equipamento_id, list);
  }
  return grouped;
}

router.get("/equipamentos", asyncHandler(async (_req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT e.id, e.nome, e.tipo::text AS tipo, e.localizacao, e.conteudo, e.ativo,
           e.temperatura_minima_c::float8 AS temperatura_minima_c,
           e.temperatura_maxima_c::float8 AS temperatura_maxima_c,
           (
             SELECT l.temperatura_c::float8
             FROM grupo2.leitura_temperatura l
             WHERE l.equipamento_id = e.id
             ORDER BY l.medido_em DESC
             LIMIT 1
           ) AS last_value
    FROM grupo2.equipamento e
    ORDER BY e.nome
  `;
  const sensors = await sensoresPorEquipamento();
  res.json({ data: rows.map((row) => equipamento(row, sensors.get(row.id) ?? [])) });
}));

router.post(
  "/equipamentos",
  requirePerm("temperatura.manage"),
  validate(z.object({
    name: z.string().trim().min(2).max(120),
    location: z.string().trim().min(2).max(80),
    kind: z.enum(tipos),
    minTemp: temperatura,
    maxTemp: temperatura,
    content: z.string().trim().max(160).optional(),
  }).refine((body) => body.maxTemp >= body.minTemp, { message: "A temperatura máxima precisa ser maior ou igual à mínima.", path: ["maxTemp"] })),
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw`
      INSERT INTO grupo2.equipamento (nome, tipo, localizacao, conteudo, temperatura_minima_c, temperatura_maxima_c)
      VALUES (
        ${req.body.name},
        ${req.body.kind}::grupo2.tipo_equipamento,
        ${req.body.location},
        ${req.body.content ?? null},
        ${req.body.minTemp},
        ${req.body.maxTemp}
      )
      RETURNING id, nome, tipo::text AS tipo, localizacao, conteudo, ativo,
                temperatura_minima_c::float8 AS temperatura_minima_c,
                temperatura_maxima_c::float8 AS temperatura_maxima_c
    `;
    res.status(201).json(equipamento({ ...rows[0], last_value: null }, []));
  }),
);

router.get("/equipamentos/:id", validate(uuidParam, "params"), asyncHandler(async (req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT e.id, e.nome, e.tipo::text AS tipo, e.localizacao, e.conteudo, e.ativo,
           e.temperatura_minima_c::float8 AS temperatura_minima_c,
           e.temperatura_maxima_c::float8 AS temperatura_maxima_c
    FROM grupo2.equipamento e
    WHERE e.id = ${req.params.id}::uuid
  `;
  if (!rows[0]) notFound();
  const [sensors, leituras, alertas] = await Promise.all([
    prisma.$queryRaw`
      SELECT id, rotulo, ativo, dispositivo_externo_ref, protocolo, intervalo_minutos
      FROM grupo2.configuracao_sensor
      WHERE equipamento_id = ${req.params.id}::uuid
      ORDER BY rotulo
    `,
    prisma.$queryRaw`
      SELECT id, medido_em, temperatura_c::float8 AS temperatura_c, origem::text AS origem, observacao
      FROM grupo2.leitura_temperatura
      WHERE equipamento_id = ${req.params.id}::uuid
      ORDER BY medido_em DESC
      LIMIT 50
    `,
    prisma.$queryRaw`
      SELECT o.id, o.situacao::text AS situacao, o.motivo_reconhecimento, o.motivo_resolucao, l.medido_em,
             l.temperatura_c::float8 AS temperatura_c
      FROM grupo2.ocorrencia_temperatura o
      JOIN grupo2.leitura_temperatura l ON l.id = o.leitura_id
      WHERE l.equipamento_id = ${req.params.id}::uuid
      ORDER BY l.medido_em DESC
    `,
  ]);
  res.json({
    ...equipamento({ ...rows[0], last_value: leituras[0]?.temperatura_c ?? null }, sensors),
    readings: present(leituras),
    alerts: present(alertas),
  });
}));

router.post(
  "/equipamentos/:id/sensores",
  requirePerm("temperatura.manage"),
  validate(uuidParam, "params"),
  validate(z.object({
    code: z.string().trim().min(2).max(80),
    protocol: z.string().trim().max(40).optional(),
    intervalMinutes: z.number().int().positive().max(1440).optional(),
  })),
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw`
      INSERT INTO grupo2.configuracao_sensor (equipamento_id, rotulo, protocolo, intervalo_minutos, ativo)
      SELECT ${req.params.id}::uuid, ${req.body.code}, ${req.body.protocol ?? null}, ${req.body.intervalMinutes ?? null}, true
      FROM grupo2.equipamento
      WHERE id = ${req.params.id}::uuid
      RETURNING id, equipamento_id, rotulo, ativo
    `;
    if (!rows[0]) notFound();
    res.status(201).json({ id: rows[0].id, equipmentId: rows[0].equipamento_id, code: rows[0].rotulo, active: rows[0].ativo });
  }),
);

router.get("/alertas", requirePerm("temperatura.alertas"), asyncHandler(async (req, res) => {
  const status = ["aberta", "reconhecida", "resolvida"].includes(req.query.status) ? req.query.status : null;
  const rows = await prisma.$queryRaw`
    SELECT o.id, o.situacao::text AS situacao, l.equipamento_id, e.nome AS equipamento_nome, l.medido_em,
           l.temperatura_c::float8 AS temperatura_c,
           l.limite_minimo_c::float8 AS limite_minimo_c,
           l.limite_maximo_c::float8 AS limite_maximo_c,
           CASE WHEN l.temperatura_c < l.limite_minimo_c THEN 'abaixo' ELSE 'acima' END AS kind
    FROM grupo2.ocorrencia_temperatura o
    JOIN grupo2.leitura_temperatura l ON l.id = o.leitura_id
    JOIN grupo2.equipamento e ON e.id = l.equipamento_id
    WHERE ${status}::text IS NULL OR o.situacao::text = ${status}
    ORDER BY l.medido_em DESC
  `;
  res.json({ data: present(rows) });
}));

router.post(
  "/alertas/:id/reconhecer",
  requirePerm("temperatura.alertas"),
  validate(uuidParam, "params"),
  validate(z.object({ motivo: z.string().trim().min(1).max(500) })),
  asyncHandler(async (req, res) => {
    const current = await prisma.$queryRaw`
      SELECT situacao::text AS situacao FROM grupo2.ocorrencia_temperatura WHERE id = ${req.params.id}::uuid
    `;
    if (!current[0]) notFound();
    if (current[0].situacao !== "aberta") throw new HttpError(409, "Só uma ocorrência aberta pode ser reconhecida.");
    const rows = await prisma.$queryRaw`
      UPDATE grupo2.ocorrencia_temperatura
      SET situacao = 'reconhecida'::grupo2.situacao_ocorrencia,
          reconhecido_por_ref = ${req.user.ref}::uuid,
          reconhecido_em = now(),
          motivo_reconhecimento = ${req.body.motivo}
      WHERE id = ${req.params.id}::uuid
      RETURNING id, situacao::text AS situacao, motivo_reconhecimento, reconhecido_em
    `;
    res.json(present(rows[0]));
  }),
);

router.post(
  "/alertas/:id/resolver",
  requirePerm("temperatura.alertas"),
  validate(uuidParam, "params"),
  validate(z.object({ motivo: z.string().trim().min(1).max(500) })),
  asyncHandler(async (req, res) => {
    const current = await prisma.$queryRaw`
      SELECT situacao::text AS situacao FROM grupo2.ocorrencia_temperatura WHERE id = ${req.params.id}::uuid
    `;
    if (!current[0]) notFound();
    if (current[0].situacao !== "reconhecida") throw new HttpError(409, "Reconheça a ocorrência antes de resolvê-la.");
    const rows = await prisma.$queryRaw`
      UPDATE grupo2.ocorrencia_temperatura
      SET situacao = 'resolvida'::grupo2.situacao_ocorrencia,
          resolvido_por_ref = ${req.user.ref}::uuid,
          resolvido_em = now(),
          motivo_resolucao = ${req.body.motivo}
      WHERE id = ${req.params.id}::uuid
      RETURNING id, situacao::text AS situacao, motivo_resolucao, resolvido_em
    `;
    res.json(present(rows[0]));
  }),
);

router.post(
  "/alertas/:id/acoes",
  requirePerm("temperatura.alertas"),
  validate(uuidParam, "params"),
  validate(z.object({ acao: z.string().trim().min(1).max(500) })),
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw`
      INSERT INTO grupo2.acao_corretiva (ocorrencia_id, responsavel_ref, acao)
      SELECT ${req.params.id}::uuid, ${req.user.ref}::uuid, ${req.body.acao}
      FROM grupo2.ocorrencia_temperatura
      WHERE id = ${req.params.id}::uuid
      RETURNING id, ocorrencia_id, acao, ocorrido_em
    `;
    if (!rows[0]) notFound();
    res.status(201).json(present(rows[0]));
  }),
);

router.post(
  "/leituras",
  requirePerm("temperatura.registrar"),
  validate(z.object({
    equipmentId: z.string().uuid(),
    sensorId: z.string().uuid().optional(),
    value: temperatura,
    at: z.coerce.date().optional(),
    note: z.string().trim().max(500).optional(),
  })),
  asyncHandler(async (req, res) => {
    const at = assertNotTooFuture(req.body.at ?? new Date(), "Data da leitura");
    const result = await prisma.$transaction(async (tx) => {
      const equipment = await tx.$queryRaw`
        SELECT id, nome, temperatura_minima_c::float8 AS minima, temperatura_maxima_c::float8 AS maxima, ativo
        FROM grupo2.equipamento
        WHERE id = ${req.body.equipmentId}::uuid
      `;
      if (!equipment[0]) notFound("Equipamento não encontrado.");
      const origem = req.body.sensorId ? "sensor" : "manual";
      const reading = await tx.$queryRaw`
        INSERT INTO grupo2.leitura_temperatura (
          equipamento_id, medido_em, temperatura_c, origem, limite_minimo_c, limite_maximo_c,
          responsavel_ref, configuracao_sensor_id, chave_idempotencia, observacao
        ) VALUES (
          ${equipment[0].id}::uuid,
          ${at},
          ${req.body.value},
          ${origem}::grupo2.origem_leitura,
          ${equipment[0].minima},
          ${equipment[0].maxima},
          ${origem === "manual" ? req.user.ref : null}::uuid,
          ${req.body.sensorId ?? null}::uuid,
          ${origem === "sensor" ? idempotencyKey() : null},
          ${req.body.note ?? null}
        )
        RETURNING id, equipamento_id, medido_em, temperatura_c::float8 AS temperatura_c, origem::text AS origem
      `;
      const alerta = await tx.$queryRaw`
        SELECT id, situacao::text AS situacao
        FROM grupo2.ocorrencia_temperatura
        WHERE leitura_id = ${reading[0].id}::uuid
      `;
      const min = Number(equipment[0].minima);
      const max = Number(equipment[0].maxima);
      const kind = req.body.value < min ? "abaixo" : req.body.value > max ? "acima" : null;
      return {
        reading: present(reading[0]),
        alert: alerta[0] ? { id: alerta[0].id, situacao: alerta[0].situacao, kind } : null,
      };
    });
    res.status(201).json(result);
  }),
);

export default router;

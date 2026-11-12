import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { audit } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { MIGRATION_COLUMNS, REQUIRED_MIGRATION_COLUMNS, parseMigrationCsv, validateMigrationRow } from "../lib/migrationCsv.js";
import { pageMeta, pageSchema } from "../lib/paging.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const uploadDir = fileURLToPath(new URL("../../uploads", import.meta.url));
const id = z.string().regex(/^[A-Za-z0-9_-]+$/);
const params = z.object({ id });
const lineParams = params.extend({ lineNumber: z.coerce.number().int().min(2) });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

function upload(middleware) {
  return (req, res, next) => middleware.single("arquivo")(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return next(new HttpError(422, "Arquivo acima do limite permitido."));
    return next(new HttpError(422, "Não foi possível receber o arquivo."));
  });
}

function requireDocumentPermission(code) {
  return (req, _res, next) => {
    if (!req.user.permissions.includes("dados.import")
      || !req.user.permissions.includes("prontuario.view")
      || !req.user.permissions.includes(code)) {
      next(new HttpError(403, "Você não tem autorização para esta ação."));
      return;
    }
    next();
  };
}

function requireMigrationAccess(req, _res, next) {
  if (!req.user.permissions.includes("dados.import") || !req.user.permissions.includes("prontuario.view")) {
    next(new HttpError(403, "Você não tem autorização para esta ação."));
    return;
  }
  next();
}

function institutionalToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function toDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(422, "Data inválida.");
  }
  return parsed;
}

function locationKey({ ala, quarto, leito }) {
  return `${ala}\u0000${quarto}\u0000${leito}`;
}

async function locationSets(tx) {
  const [occupied, available] = await Promise.all([
    tx.patients.findMany({ where: { active: true }, select: { wing: true, room: true, bed: true } }),
    tx.$queryRaw`SELECT r.wing, r.number AS room, b.label AS bed
      FROM beds b JOIN rooms r ON r.id = b.room_id WHERE r.active AND b.active`,
  ]);
  return {
    occupied: new Set(occupied.map((row) => `${row.wing}\u0000${row.room}\u0000${row.bed}`)),
    available: new Set(available.map((row) => `${row.wing}\u0000${row.room}\u0000${row.bed}`)),
  };
}

function evaluateRows(rows, sets) {
  const seen = new Set();
  const today = institutionalToday();
  return rows.map((row) => {
    if (row.status === "ignorada") return { ...row, errors: [], status: "ignorada" };
    const result = validateMigrationRow(row.current_data, today);
    const errors = [...result.errors];
    const key = locationKey(result.data);
    if (result.data.ala && result.data.quarto && result.data.leito) {
      if (!sets.available.has(key)) errors.push("quarto/leito inexistente ou inativo");
      if (sets.occupied.has(key)) errors.push("leito ocupado por idoso ativo");
      if (seen.has(key)) errors.push("leito repetido neste lote");
      seen.add(key);
    }
    return { ...row, errors, status: errors.length ? "rejeitada" : "valida" };
  });
}

async function refreshPreview(tx, batchId) {
  const rows = await tx.$queryRaw`SELECT * FROM migration_rows WHERE batch_id = ${batchId} ORDER BY line_number`;
  const evaluated = evaluateRows(rows, await locationSets(tx));
  const updates = evaluated.map((row) => ({ line_number: row.line_number, errors: row.errors, status: row.status }));
  await tx.$executeRaw`UPDATE migration_rows AS target SET errors = patch.errors, status = patch.status
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
      AS patch(line_number integer, errors jsonb, status text)
    WHERE target.batch_id = ${batchId} AND target.line_number = patch.line_number`;
  return evaluated;
}

async function createManyChunks(delegate, data) {
  for (let index = 0; index < data.length; index += 500) {
    await delegate.createMany({ data: data.slice(index, index + 500) });
  }
}

async function lockedBatch(tx, batchId) {
  const [batch] = await tx.$queryRaw`SELECT * FROM migration_batches WHERE id = ${batchId} FOR UPDATE`;
  if (!batch) throw new HttpError(404, "Lote não encontrado.");
  return batch;
}

async function batchResponse(tx, batchId, includeRows = false) {
  const [batch] = await tx.$queryRaw`SELECT * FROM migration_batches WHERE id = ${batchId}`;
  if (!batch) throw new HttpError(404, "Lote não encontrado.");
  const counts = await tx.$queryRaw`SELECT status, count(*)::int AS total FROM migration_rows
    WHERE batch_id = ${batchId} GROUP BY status`;
  const summary = Object.fromEntries(counts.map((row) => [row.status, row.total]));
  const result = { ...present(batch), summary, total: counts.reduce((sum, row) => sum + row.total, 0) };
  if (includeRows) {
    const rows = await tx.$queryRaw`SELECT line_number, original_data, current_data, errors, status, patient_id,
      corrected_at, corrected_by FROM migration_rows WHERE batch_id = ${batchId} ORDER BY line_number`;
    result.rows = present(rows);
  }
  return result;
}

router.use(requireAuth);

router.get("/importacoes/modelo", requireMigrationAccess, (_req, res) => {
  res.json({
    format: "CSV UTF-8, separador ponto e vírgula ou vírgula, primeira linha de cabeçalho",
    requiredColumns: REQUIRED_MIGRATION_COLUMNS,
    optionalColumns: MIGRATION_COLUMNS.slice(REQUIRED_MIGRATION_COLUMNS.length),
    clinicalData: "dados_clinicos: JSON de [{sectionId,sectionTitle,label,value}]",
    contacts: "contatos: JSON de [{name,relation,phone,isPrimary,priority,notes}]",
    validation: "Datas AAAA-MM-DD; sexo F/M; quarto/leito ativo e desocupado; até 5.000 linhas e 2 MB.",
  });
});

router.get("/importacoes", requireMigrationAccess, validate(pageSchema, "query"), asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const [totalRows, rows] = await Promise.all([
    prisma.$queryRaw`SELECT count(*)::int AS total FROM migration_batches`,
    prisma.$queryRaw`SELECT * FROM migration_batches ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
  ]);
  res.json({ data: present(rows), meta: pageMeta(page, limit, totalRows[0].total) });
}));

router.get("/importacoes/legado", requireMigrationAccess, asyncHandler(async (_req, res) => {
  const rows = await prisma.import_jobs.findMany({
    select: { id: true, filename: true, status: true, created_by: true, created_at: true, summary: true },
    orderBy: { created_at: "desc" },
  });
  res.json({ data: present(rows) });
}));

router.post("/importacoes", requireMigrationAccess, upload(csvUpload), asyncHandler(async (req, res) => {
  if (!req.file?.size) throw new HttpError(422, "Anexe um arquivo CSV.");
  const filename = path.basename(req.file.originalname || "importacao.csv");
  if (!filename.toLowerCase().endsWith(".csv")) throw new HttpError(422, "Envie um arquivo .csv.");
  const parsed = parseMigrationCsv(req.file.buffer);
  const batchId = randomUUID();
  const stored = `${batchId}.csv`;
  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, stored), req.file.buffer, { flag: "wx" });
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO migration_batches (id, filename, source_path, created_by)
        VALUES (${batchId}, ${filename}, ${stored}, ${req.user.id})`;
      await tx.$executeRaw`INSERT INTO migration_rows
        (batch_id, line_number, original_data, current_data, status)
        SELECT ${batchId}, (source.value->>'lineNumber')::integer,
          source.value->'data', source.value->'data', 'rejeitada'
        FROM jsonb_array_elements(${JSON.stringify(parsed)}::jsonb) AS source(value)`;
      await refreshPreview(tx, batchId);
      await audit(tx, { userId: req.user.id, action: "preparar", entity: "importacao", entityId: batchId,
        payload: { filename, lines: parsed.length } });
      return batchResponse(tx, batchId, true);
    }, { timeout: 120_000 });
    res.status(201).json({ job: result, preview: result.rows });
  } catch (error) {
    await unlink(path.join(uploadDir, stored)).catch(() => {});
    throw error;
  }
}));

router.get("/importacoes/:id", requireMigrationAccess, validate(params, "params"), asyncHandler(async (req, res) => {
  res.json({ job: await batchResponse(prisma, req.params.id, true) });
}));

router.get("/importacoes/:id/rejeicoes", requireMigrationAccess, validate(params, "params"), asyncHandler(async (req, res) => {
  await batchResponse(prisma, req.params.id);
  const rows = await prisma.$queryRaw`SELECT line_number, original_data, current_data, errors, status
    FROM migration_rows WHERE batch_id = ${req.params.id} AND status IN ('rejeitada', 'ignorada')
    ORDER BY line_number`;
  res.json({ data: present(rows) });
}));

router.get("/importacoes/:id/linhas/:lineNumber/historico", requireMigrationAccess,
  validate(lineParams, "params"), asyncHandler(async (req, res) => {
    const [row] = await prisma.$queryRaw`SELECT line_number FROM migration_rows
      WHERE batch_id = ${req.params.id} AND line_number = ${req.params.lineNumber}`;
    if (!row) throw new HttpError(404, "Linha não encontrada.");
    const history = await prisma.$queryRaw`SELECT at, by_id, reason, previous_data, new_data, action
      FROM migration_row_corrections WHERE batch_id = ${req.params.id}
      AND line_number = ${req.params.lineNumber} ORDER BY at, id`;
    res.json({ data: present(history) });
  }));

router.patch("/importacoes/:id/linhas/:lineNumber", requireMigrationAccess, validate(lineParams, "params"),
  validate(z.object({
    data: z.record(z.string().max(10000)).refine(
      (data) => Object.keys(data).every((key) => MIGRATION_COLUMNS.includes(key)),
      "Coluna fora do modelo de migração.",
    ),
    reason: z.string().trim().min(5).max(500),
    ignore: z.boolean().optional(),
  })),
  asyncHandler(async (req, res) => {
    const batchId = req.params.id;
    const lineNumber = req.params.lineNumber;
    const result = await prisma.$transaction(async (tx) => {
      const batch = await lockedBatch(tx, batchId);
      if (batch.status !== "previa") throw new HttpError(409, "Lote já confirmado.");
      const [row] = await tx.$queryRaw`SELECT * FROM migration_rows WHERE batch_id = ${batchId}
        AND line_number = ${lineNumber} FOR UPDATE`;
      if (!row) throw new HttpError(404, "Linha não encontrada.");
      if (!req.body.ignore && Object.keys(req.body.data).length === 0) {
        throw new HttpError(422, "Informe os campos corrigidos.");
      }
      if (row.current_data.__columnError && !req.body.ignore
        && REQUIRED_MIGRATION_COLUMNS.some((column) => !(column in req.body.data))) {
        throw new HttpError(422, "Linhas com colunas desalinhadas exigem reenvio dos seis campos obrigatórios.");
      }
      const nextData = req.body.ignore ? row.current_data
        : row.current_data.__columnError
          ? Object.fromEntries(MIGRATION_COLUMNS.map((column) => [column, req.body.data[column] ?? ""]))
          : { ...row.current_data, ...req.body.data };
      if (!req.body.ignore) delete nextData.__columnError;
      await tx.$executeRaw`INSERT INTO migration_row_corrections
        (batch_id, line_number, by_id, reason, previous_data, new_data, action)
        VALUES (${batchId}, ${lineNumber}, ${req.user.id}, ${req.body.reason},
          ${JSON.stringify(row.current_data)}::jsonb, ${JSON.stringify(nextData)}::jsonb,
          ${req.body.ignore ? "ignorar" : "corrigir"})`;
      await tx.$executeRaw`UPDATE migration_rows SET current_data = ${JSON.stringify(nextData)}::jsonb,
        status = ${req.body.ignore ? "ignorada" : "rejeitada"}, corrected_at = now(), corrected_by = ${req.user.id}
        WHERE batch_id = ${batchId} AND line_number = ${lineNumber}`;
      await refreshPreview(tx, batchId);
      await audit(tx, { userId: req.user.id, action: req.body.ignore ? "ignorar_linha" : "corrigir_linha",
        entity: "importacao", entityId: batchId, payload: { lineNumber, reason: req.body.reason } });
      return batchResponse(tx, batchId, true);
    }, { timeout: 120_000 });
    res.json({ job: result });
  }));

router.post("/importacoes/:id/confirmar", requireMigrationAccess, validate(params, "params"),
  asyncHandler(async (req, res) => {
    const batchId = req.params.id;
    const result = await prisma.$transaction(async (tx) => {
      const batch = await lockedBatch(tx, batchId);
      if (batch.status !== "previa") throw new HttpError(409, "Lote já confirmado.");
      const rows = await refreshPreview(tx, batchId);
      const rejected = rows.filter((row) => row.status === "rejeitada");
      const valid = rows.filter((row) => row.status === "valida");
      if (rejected.length) throw new HttpError(409, "Corrija ou ignore todas as linhas rejeitadas antes de confirmar.");
      if (!valid.length) throw new HttpError(422, "Nenhuma linha válida para importar.");
      const today = institutionalToday();
      const prepared = valid.map((row) => {
        const { data, careFields, contacts } = validateMigrationRow(row.current_data, today);
        const patientId = `imp-${randomUUID()}`;
        const admission = data.admissao || today;
        return { lineNumber: row.line_number, patientId, patient: {
          id: patientId, code: `IMP-${randomUUID()}`,
          name: data.nome, treatment: `${data.sexo === "F" ? "Dona" : "Seu"} ${data.nome.split(/\s+/)[0]}`,
          sex: data.sexo, birth_date: toDate(data.nascimento), admission_date: toDate(admission),
          wing: data.ala, room: data.quarto, bed: data.leito, status: "estavel", active: true,
          presence_status: "leito",
        }, careFields: careFields.map((field, index) => ({
          patient_id: patientId, section_id: field.sectionId.trim(), section_title: field.sectionTitle.trim(),
          label: field.label.trim(), value: field.value.trim(), sort_order: index,
        })), contacts: contacts.map((contact, index) => ({
          patient_id: patientId, name: contact.name.trim(), relation: contact.relation.trim(), phone: contact.phone.trim(),
          is_primary: contact.isPrimary === true, priority: contact.priority ?? Math.min(index + 1, 99),
          notes: contact.notes ?? null,
        })), location: {
          patient_id: patientId, by_id: req.user.id, wing: data.ala, room: data.quarto, bed: data.leito,
          reason: "Importação de lote",
        } };
      });
      await createManyChunks(tx.patients, prepared.map((item) => item.patient));
      await createManyChunks(tx.patient_care_fields, prepared.flatMap((item) => item.careFields));
      await createManyChunks(tx.patient_contacts, prepared.flatMap((item) => item.contacts));
      await createManyChunks(tx.patient_location_history, prepared.map((item) => item.location));
      await createManyChunks(tx.audit_log, prepared.map((item) => ({
        user_id: req.user.id, action: "importar", entity: "idoso", entity_id: item.patientId,
        payload: { batchId, lineNumber: item.lineNumber },
      })));
      await tx.$executeRaw`UPDATE migration_rows AS target
        SET status = 'importada', patient_id = patch.patient_id, errors = '[]'::jsonb
        FROM jsonb_to_recordset(${JSON.stringify(prepared.map((item) => ({
          line_number: item.lineNumber, patient_id: item.patientId,
        })))}::jsonb) AS patch(line_number integer, patient_id text)
        WHERE target.batch_id = ${batchId} AND target.line_number = patch.line_number`;
      await tx.$executeRaw`UPDATE migration_batches SET status = 'importado', imported_at = now(),
        imported_by = ${req.user.id} WHERE id = ${batchId}`;
      await audit(tx, { userId: req.user.id, action: "confirmar", entity: "importacao", entityId: batchId,
        payload: { imported: valid.length } });
      return batchResponse(tx, batchId, true);
    }, { isolationLevel: "Serializable", timeout: 120_000 });
    res.json({ job: result });
  }));

router.post("/importacoes/:id/amostra", requireMigrationAccess, validate(params, "params"),
  validate(z.object({
    rows: z.array(z.object({ lineNumber: z.number().int().min(2), notes: z.string().trim().max(1000).optional() })).min(1),
    checklist: z.array(z.object({ item: z.string().trim().min(3).max(120), checked: z.boolean(), notes: z.string().trim().max(1000).optional() })).min(1).max(30),
    approved: z.boolean(),
    notes: z.string().trim().max(2000).optional(),
  })), asyncHandler(async (req, res) => {
    const batchId = req.params.id;
    const result = await prisma.$transaction(async (tx) => {
      const batch = await lockedBatch(tx, batchId);
      if (batch.status !== "importado") throw new HttpError(409, "Amostra disponível após a importação e antes da conclusão.");
      if (req.body.approved && req.body.checklist.some((item) => !item.checked)) {
        throw new HttpError(422, "Todos os itens da conferência devem estar marcados para aprovação.");
      }
      const samples = new Set(req.body.rows.map((row) => row.lineNumber));
      if (samples.size !== req.body.rows.length) throw new HttpError(422, "Linhas de amostra repetidas.");
      const imported = await tx.$queryRaw`SELECT line_number FROM migration_rows WHERE batch_id = ${batchId}
        AND status = 'importada'`;
      const available = new Set(imported.map((row) => row.line_number));
      if ([...samples].some((line) => !available.has(line))) throw new HttpError(422, "Amostra contém linha não importada.");
      await tx.$executeRaw`DELETE FROM migration_sample_reviews WHERE batch_id = ${batchId}`;
      await tx.$executeRaw`INSERT INTO migration_sample_reviews
        (batch_id, line_number, checked_by, notes)
        SELECT ${batchId}, sample.line_number, ${req.user.id}, sample.notes
        FROM jsonb_to_recordset(${JSON.stringify(req.body.rows.map((row) => ({
          line_number: row.lineNumber, notes: row.notes ?? null,
        })))}::jsonb) AS sample(line_number integer, notes text)`;
      const validationStatus = req.body.approved ? "aprovada" : "reprovada";
      await tx.$executeRaw`UPDATE migration_batches SET validation_status = ${validationStatus},
        validated_at = now(), validated_by = ${req.user.id},
        validation_checklist = ${JSON.stringify(req.body.checklist)}::jsonb,
        validation_notes = ${req.body.notes ?? null} WHERE id = ${batchId}`;
      await audit(tx, { userId: req.user.id, action: "validar_amostra", entity: "importacao", entityId: batchId,
        payload: { status: validationStatus, sampleLines: [...samples] } });
      return batchResponse(tx, batchId);
    }, { timeout: 120_000 });
    res.json({ job: result });
  }));

router.post("/importacoes/:id/concluir", requireMigrationAccess, validate(params, "params"),
  validate(z.object({ periodStart: date, periodEnd: date, result: z.string().trim().min(3).max(1000) })),
  asyncHandler(async (req, res) => {
    const start = toDate(req.body.periodStart);
    const end = toDate(req.body.periodEnd);
    if (end < start) throw new HttpError(422, "Fim do período anterior ao início.");
    const batchId = req.params.id;
    const result = await prisma.$transaction(async (tx) => {
      const batch = await lockedBatch(tx, batchId);
      if (batch.status !== "importado" || batch.validation_status !== "aprovada") {
        throw new HttpError(409, "A conclusão exige importação e amostra aprovada.");
      }
      await tx.$executeRaw`UPDATE migration_batches SET status = 'concluido', period_start = ${start},
        period_end = ${end}, completed_at = now(), completed_by = ${req.user.id},
        completed_count = (SELECT count(*)::integer FROM migration_rows
          WHERE batch_id = ${batchId} AND status = 'importada'),
        result = ${req.body.result} WHERE id = ${batchId}`;
      await audit(tx, { userId: req.user.id, action: "concluir", entity: "importacao", entityId: batchId,
        payload: { periodStart: req.body.periodStart, periodEnd: req.body.periodEnd, result: req.body.result } });
      return batchResponse(tx, batchId);
    });
    res.json({ job: result });
  }));

function documentExtension(file) {
  const bytes = file.buffer;
  if (file.mimetype === "application/pdf" && bytes.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (file.mimetype === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (file.mimetype === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  throw new HttpError(422, "Envie PDF, PNG ou JPEG válido.");
}

router.get("/migracao/documentos", requireDocumentPermission("documento.view"),
  validate(z.object({ patientId: id }), "query"), asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw`SELECT d.id, d.patient_id, d.name, d.type, d.at, d.author_id,
      d.status, m.origin, m.source_identifier, m.document_date, m.digitized_at, m.digitized_by, m.batch_id
      FROM migration_document_metadata m JOIN documents d ON d.id = m.document_id
      WHERE d.patient_id = ${req.query.patientId} ORDER BY m.digitized_at DESC`;
    res.json({ data: present(rows) });
  }));

router.post("/migracao/documentos", requireDocumentPermission("documento.upload"), upload(documentUpload),
  asyncHandler(async (req, res) => {
    if (!req.file?.size) throw new HttpError(422, "Anexe um documento digitalizado.");
    const parsed = z.object({
      patientId: id,
      category: z.string().trim().min(2).max(80),
      documentDate: date,
      origin: z.string().trim().min(3).max(200),
      sourceIdentifier: z.string().trim().max(120).optional(),
      batchId: id.optional(),
      description: z.string().trim().max(1000).optional(),
      digitizedAt: z.coerce.date().optional(),
    }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(422, "Metadados do documento inválidos.", parsed.error.flatten());
    const body = parsed.data;
    const sourceIdentifier = body.sourceIdentifier || null;
    const documentDate = toDate(body.documentDate);
    const digitizedAt = body.digitizedAt ?? new Date();
    if (digitizedAt > new Date()) throw new HttpError(422, "Data de digitalização no futuro.");
    const ext = documentExtension(req.file);
    const stored = `${randomUUID()}.${ext}`;
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, stored), req.file.buffer, { flag: "wx" });
    try {
      const result = await prisma.$transaction(async (tx) => {
        const patient = await tx.patients.findUnique({ where: { id: body.patientId }, select: { id: true } });
        if (!patient) throw new HttpError(404, "Idoso não encontrado.");
        if (body.batchId) {
          const [source] = await tx.$queryRaw`SELECT b.status FROM migration_batches b
            JOIN migration_rows r ON r.batch_id = b.id
            WHERE b.id = ${body.batchId} AND r.patient_id = ${body.patientId}
              AND r.status = 'importada'`;
          if (!source || source.status === "previa") {
            throw new HttpError(422, "O idoso não pertence ao lote importado informado.");
          }
        }
        const doc = await tx.documents.create({ data: {
          patient_id: body.patientId, name: path.basename(req.file.originalname || `documento.${ext}`).slice(0, 180),
          type: body.category, author_id: req.user.id, status: "vigente", ext,
          size_kb: Math.max(1, Math.ceil(req.file.size / 1024)),
          description: body.description ?? null, storage_path: stored,
        } });
        await tx.$executeRaw`INSERT INTO migration_document_metadata
          (document_id, origin, source_identifier, document_date, digitized_at, digitized_by, batch_id)
          VALUES (${doc.id}, ${body.origin}, ${sourceIdentifier}, ${documentDate},
            ${digitizedAt}, ${req.user.id}, ${body.batchId ?? null})`;
        await audit(tx, { userId: req.user.id, action: "digitalizar", entity: "documento", entityId: doc.id,
          payload: { patientId: body.patientId, batchId: body.batchId ?? null, origin: body.origin } });
        return { ...present(doc), origin: body.origin, sourceIdentifier,
          documentDate: body.documentDate, digitizedAt: digitizedAt.toISOString(), digitizedBy: req.user.id,
          batchId: body.batchId ?? null };
      });
      res.status(201).json(result);
    } catch (error) {
      await unlink(path.join(uploadDir, stored)).catch(() => {});
      throw error;
    }
  }));

export default router;

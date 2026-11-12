-- Fluxo de migração do Grupo 1. Pode ser aplicado em banco existente.
-- Os dados de origem permanecem imutáveis.
BEGIN;
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE IF NOT EXISTS migration_batches (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  filename text NOT NULL,
  source_path text NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'previa' CHECK (status IN ('previa', 'importado', 'concluido')),
  imported_at timestamptz,
  imported_by text REFERENCES users(id),
  validation_status text NOT NULL DEFAULT 'pendente'
    CHECK (validation_status IN ('pendente', 'aprovada', 'reprovada')),
  validated_at timestamptz,
  validated_by text REFERENCES users(id),
  validation_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_notes text,
  period_start date,
  period_end date,
  completed_at timestamptz,
  completed_by text REFERENCES users(id),
  result text,
  CHECK (period_end IS NULL OR period_start IS NOT NULL),
  CHECK (period_end IS NULL OR period_end >= period_start)
);

ALTER TABLE migration_batches ADD COLUMN IF NOT EXISTS completed_count integer
  CHECK (completed_count >= 0);

CREATE TABLE IF NOT EXISTS migration_rows (
  batch_id text NOT NULL REFERENCES migration_batches(id) ON DELETE CASCADE,
  line_number integer NOT NULL CHECK (line_number >= 2),
  original_data jsonb NOT NULL,
  current_data jsonb NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('valida', 'rejeitada', 'ignorada', 'importada')),
  patient_id text REFERENCES patients(id),
  corrected_at timestamptz,
  corrected_by text REFERENCES users(id),
  PRIMARY KEY (batch_id, line_number)
);

CREATE TABLE IF NOT EXISTS migration_row_corrections (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  batch_id text NOT NULL,
  line_number integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  previous_data jsonb NOT NULL,
  new_data jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('corrigir', 'ignorar')),
  FOREIGN KEY (batch_id, line_number) REFERENCES migration_rows(batch_id, line_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS migration_sample_reviews (
  batch_id text NOT NULL,
  line_number integer NOT NULL,
  checked_by text NOT NULL REFERENCES users(id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  PRIMARY KEY (batch_id, line_number),
  FOREIGN KEY (batch_id, line_number) REFERENCES migration_rows(batch_id, line_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS migration_document_metadata (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  origin text NOT NULL,
  source_identifier text,
  document_date date NOT NULL,
  digitized_at timestamptz NOT NULL,
  digitized_by text NOT NULL REFERENCES users(id),
  batch_id text REFERENCES migration_batches(id),
  UNIQUE (batch_id, source_identifier)
);

CREATE INDEX IF NOT EXISTS migration_batches_created_at ON migration_batches (created_at DESC);
CREATE INDEX IF NOT EXISTS migration_rows_status ON migration_rows (batch_id, status);

INSERT INTO role_permissions (role_id, permission_code)
SELECT 'gestor', 'documento.upload'
WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'gestor')
  AND EXISTS (SELECT 1 FROM permissions WHERE code = 'documento.upload')
ON CONFLICT (role_id, permission_code) DO NOTHING;

UPDATE modules SET group_name = 'Grupo 1 · Prontuário, Saúde e Plano de Cuidado'
WHERE id = 'migracao';

COMMIT;

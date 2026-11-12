-- Atualização não destrutiva para o cadastro de idosos (E02).
-- Execute uma vez no banco existente. Também pode ser reaplicada.
BEGIN;
SET LOCAL search_path = public, pg_catalog;

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS presence_status text NOT NULL DEFAULT 'leito'
    CHECK (presence_status IN ('leito', 'atendimento', 'atividade', 'externo', 'outro')),
  ADD COLUMN IF NOT EXISTS presence_detail text;

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_bed_check;

CREATE UNIQUE INDEX IF NOT EXISTS patients_active_bed
  ON patients (wing, room, bed) WHERE active;

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  wing text NOT NULL,
  number text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wing, number)
);

CREATE TABLE IF NOT EXISTS beds (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (room_id, label)
);

INSERT INTO rooms (wing, number)
SELECT DISTINCT wing, room FROM patients
ON CONFLICT (wing, number) DO NOTHING;

INSERT INTO beds (room_id, label)
SELECT DISTINCT rooms.id, patients.bed
FROM patients JOIN rooms ON rooms.wing = patients.wing AND rooms.number = patients.room
ON CONFLICT (room_id, label) DO NOTHING;

CREATE TABLE IF NOT EXISTS patient_location_history (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text REFERENCES users(id),
  wing text NOT NULL,
  room text NOT NULL,
  bed text NOT NULL,
  reason text NOT NULL
);

CREATE INDEX IF NOT EXISTS patient_location_history_patient_at
  ON patient_location_history (patient_id, at DESC);

INSERT INTO patient_location_history (patient_id, at, wing, room, bed, reason)
SELECT id, admission_date::timestamptz, wing, room, bed, 'Localização inicial do cadastro'
FROM patients p
WHERE NOT EXISTS (SELECT 1 FROM patient_location_history h WHERE h.patient_id = p.id);

ALTER TABLE patient_alerts
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'ambos'
    CHECK (context IN ('cadastro', 'prontuario', 'ambos')),
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE patient_contacts
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 99),
  ADD COLUMN IF NOT EXISTS notes text;

INSERT INTO permissions (code, label, group_name) VALUES
  ('cadastro.idosos.manage', 'Cadastrar e editar idosos e contatos', 'Cadastro de idosos'),
  ('leitos.manage', 'Gerir quartos e leitos', 'Cadastro de idosos'),
  ('avisos.manage', 'Gerir avisos contextuais dos idosos', 'Cadastro de idosos')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, group_name = EXCLUDED.group_name;

INSERT INTO role_permissions (role_id, permission_code)
SELECT grants.role_id, grants.permission_code
FROM (VALUES
  ('admin', 'cadastro.idosos.manage'), ('admin', 'leitos.manage'), ('admin', 'avisos.manage'),
  ('gestor', 'cadastro.idosos.manage'), ('gestor', 'leitos.manage'), ('gestor', 'avisos.manage'),
  ('enfermagem', 'cadastro.idosos.manage'), ('enfermagem', 'leitos.manage'), ('enfermagem', 'avisos.manage'),
  ('recepcao', 'cadastro.idosos.manage')
) AS grants(role_id, permission_code)
JOIN roles ON roles.id = grants.role_id
ON CONFLICT (role_id, permission_code) DO NOTHING;

UPDATE modules SET group_name = 'Grupo 1 · Prontuário, Saúde e Plano de Cuidado'
WHERE id = 'idosos';

COMMIT;

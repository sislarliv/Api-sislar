CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE roles (
  id text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  label text NOT NULL,
  group_name text NOT NULL
);

CREATE TABLE role_permissions (
  role_id text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role_label text NOT NULL,
  sector text NOT NULL,
  council text,
  active boolean NOT NULL DEFAULT true,
  demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_profiles (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile text NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, profile)
);

CREATE TABLE password_resets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE patients (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  treatment text NOT NULL,
  sex text NOT NULL CHECK (sex IN ('F', 'M')),
  birth_date date NOT NULL,
  admission_date date NOT NULL,
  wing text NOT NULL,
  room text NOT NULL,
  bed text NOT NULL CHECK (bed IN ('A', 'B')),
  status text NOT NULL CHECK (status IN ('estavel', 'observacao', 'cuidado_especial', 'hospital')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (admission_date >= birth_date)
);

CREATE TABLE patient_tags (
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tag text NOT NULL,
  PRIMARY KEY (patient_id, tag)
);

CREATE TABLE patient_alerts (
  id text PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('alergia', 'mobilidade', 'alimentacao', 'comportamento', 'outro')),
  detail text
);

CREATE TABLE patient_contacts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name text NOT NULL,
  relation text NOT NULL,
  phone text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX patient_contacts_one_primary
  ON patient_contacts (patient_id) WHERE is_primary;

CREATE TABLE patient_care_fields (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  section_id text NOT NULL,
  section_title text NOT NULL,
  label text NOT NULL,
  value text NOT NULL,
  sort_order integer NOT NULL
);

CREATE TABLE evolutions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  author_id text NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('rotina', 'reavaliacao', 'cuidado', 'intercorrencia')),
  title text NOT NULL,
  description text NOT NULL,
  notes text,
  alimentacao text,
  hidratacao text,
  sono text,
  humor text,
  mobilidade text,
  pele text,
  status text NOT NULL CHECK (status IN ('rascunho', 'finalizado')),
  closed_at timestamptz,
  linked_occurrence_id text,
  CHECK (status <> 'finalizado' OR closed_at IS NOT NULL)
);

CREATE TABLE evolution_corrections (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  evolution_id text NOT NULL REFERENCES evolutions(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  previous_description text NOT NULL
);

CREATE TABLE vitals (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pa', 'glicemia')),
  at timestamptz NOT NULL,
  systolic integer,
  diastolic integer,
  pulse integer,
  glucose integer,
  context text NOT NULL,
  author_id text NOT NULL REFERENCES users(id),
  CHECK (
    (kind = 'pa' AND systolic IS NOT NULL AND diastolic IS NOT NULL AND pulse IS NOT NULL AND glucose IS NULL
      AND systolic BETWEEN 40 AND 250 AND diastolic BETWEEN 20 AND 150 AND pulse BETWEEN 30 AND 220
      AND systolic > diastolic)
    OR
    (kind = 'glicemia' AND glucose IS NOT NULL AND systolic IS NULL AND diastolic IS NULL AND pulse IS NULL
      AND glucose BETWEEN 20 AND 600)
  )
);

CREATE TABLE occurrences (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  category text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  at timestamptz NOT NULL,
  author_id text NOT NULL REFERENCES users(id),
  responsible_id text NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('aberta', 'acompanhamento', 'encerrada')),
  priority text NOT NULL CHECK (priority IN ('normal', 'atencao')),
  notes text
);

CREATE TABLE occurrence_history (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  occurrence_id text NOT NULL REFERENCES occurrences(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('abertura', 'acompanhamento', 'encerramento')),
  text text NOT NULL
);

CREATE TABLE documents (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  author_id text NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('vigente', 'arquivado')),
  ext text NOT NULL,
  size_kb integer NOT NULL CHECK (size_kb >= 0),
  description text,
  storage_path text NOT NULL,
  archived_at timestamptz,
  archived_by_id text REFERENCES users(id)
);

CREATE TABLE care_plans (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  title text NOT NULL,
  area text NOT NULL,
  objective text NOT NULL,
  responsible_id text NOT NULL REFERENCES users(id),
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL CHECK (status IN ('ativo', 'encerrado', 'futuro'))
);

CREATE TABLE care_plan_actions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id text NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  title text NOT NULL,
  responsible_id text NOT NULL REFERENCES users(id),
  frequency text NOT NULL,
  done boolean NOT NULL DEFAULT false
);

CREATE TABLE care_plan_updates (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id text NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text NOT NULL REFERENCES users(id),
  text text NOT NULL
);

CREATE TABLE pae_templates (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  description text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('vigente', 'arquivado')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pae_template_responsibles (
  template_id text NOT NULL REFERENCES pae_templates(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id),
  PRIMARY KEY (template_id, user_id)
);

CREATE TABLE pae_template_fields (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_id text NOT NULL REFERENCES pae_templates(id) ON DELETE CASCADE,
  label text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('texto', 'texto_longo', 'selecao', 'sim_nao', 'numero', 'data')),
  required boolean NOT NULL DEFAULT false,
  options text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL
);

CREATE TABLE pae_template_actions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_id text NOT NULL REFERENCES pae_templates(id) ON DELETE CASCADE,
  title text NOT NULL,
  role_label text NOT NULL,
  sort_order integer NOT NULL
);

CREATE TABLE paes (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  template_id text NOT NULL REFERENCES pae_templates(id),
  status text NOT NULL CHECK (status IN ('vigente', 'em_revisao', 'encerrado')),
  start_date date NOT NULL,
  review_date date,
  responsible_id text NOT NULL REFERENCES users(id),
  created_by text NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE pae_values (
  pae_id text NOT NULL REFERENCES paes(id) ON DELETE CASCADE,
  field_id text NOT NULL REFERENCES pae_template_fields(id),
  value text NOT NULL,
  PRIMARY KEY (pae_id, field_id)
);

CREATE TABLE pae_actions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pae_id text NOT NULL REFERENCES paes(id) ON DELETE CASCADE,
  template_action_id text REFERENCES pae_template_actions(id),
  title text NOT NULL,
  responsible_id text REFERENCES users(id),
  due_date date,
  status text NOT NULL CHECK (status IN ('pendente', 'executada', 'cancelada')),
  done_at timestamptz,
  notes text
);

CREATE TABLE pops (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  category text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  responsible_id text NOT NULL REFERENCES users(id),
  valid_from date NOT NULL,
  valid_until date NOT NULL,
  status text NOT NULL CHECK (status IN ('rascunho', 'vigente', 'arquivado')),
  purpose text NOT NULL,
  sections jsonb NOT NULL,
  related jsonb NOT NULL DEFAULT '[]',
  CHECK (valid_until >= valid_from)
);

CREATE TABLE pop_versions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pop_id text NOT NULL REFERENCES pops(id) ON DELETE CASCADE,
  version integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text NOT NULL REFERENCES users(id),
  summary text NOT NULL,
  valid_until date NOT NULL,
  sections jsonb NOT NULL,
  UNIQUE (pop_id, version)
);

CREATE TABLE medications (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  active_ingredient text NOT NULL,
  form text NOT NULL,
  strength text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('medicamento', 'insumo')),
  unit text NOT NULL,
  min_qty integer NOT NULL CHECK (min_qty >= 0),
  location text NOT NULL,
  cold_chain boolean NOT NULL DEFAULT false
);

CREATE TABLE medication_lots (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  medication_id text NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  code text NOT NULL,
  expiry date NOT NULL,
  qty integer NOT NULL CHECK (qty >= 0),
  supplier text NOT NULL,
  received_at date NOT NULL,
  UNIQUE (medication_id, code)
);

CREATE TABLE prescriptions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  medication_id text NOT NULL REFERENCES medications(id),
  dose text NOT NULL,
  route text NOT NULL,
  frequency text NOT NULL,
  instructions text,
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL CHECK (status IN ('vigente', 'suspensa', 'encerrada')),
  prescriber_id text NOT NULL REFERENCES users(id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE administrations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  prescription_id text NOT NULL REFERENCES prescriptions(id),
  patient_id text NOT NULL REFERENCES patients(id),
  medication_id text NOT NULL REFERENCES medications(id),
  scheduled_at timestamptz NOT NULL,
  administered_at timestamptz,
  status text NOT NULL CHECK (status IN ('administrado', 'recusado', 'nao_administrado', 'atrasado')),
  author_id text NOT NULL REFERENCES users(id),
  notes text,
  CHECK (
    (status = 'administrado' AND administered_at IS NOT NULL)
    OR (status <> 'administrado')
  )
);

CREATE TABLE dispensations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  medication_id text NOT NULL REFERENCES medications(id),
  lot_id text NOT NULL REFERENCES medication_lots(id),
  patient_id text REFERENCES patients(id),
  qty integer NOT NULL CHECK (qty > 0),
  at timestamptz NOT NULL DEFAULT now(),
  author_id text NOT NULL REFERENCES users(id),
  notes text
);

CREATE TABLE stock_items (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  category text NOT NULL,
  unit text NOT NULL,
  min_qty integer NOT NULL CHECK (min_qty >= 0),
  qty integer NOT NULL CHECK (qty >= 0),
  location text NOT NULL
);

CREATE TABLE stock_movements (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  item_id text NOT NULL REFERENCES stock_items(id),
  type text NOT NULL CHECK (type IN ('entrada', 'saida', 'ajuste')),
  qty integer NOT NULL CHECK (qty <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  author_id text NOT NULL REFERENCES users(id)
);

CREATE TABLE inventories (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  at timestamptz NOT NULL DEFAULT now(),
  author_id text NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('fechado')),
  notes text
);

CREATE TABLE inventory_lines (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  inventory_id text NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES stock_items(id),
  expected_qty integer NOT NULL CHECK (expected_qty >= 0),
  counted_qty integer NOT NULL CHECK (counted_qty >= 0)
);

CREATE TABLE replenishments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  item_id text NOT NULL REFERENCES stock_items(id),
  qty integer NOT NULL CHECK (qty > 0 AND qty <= 100000),
  status text NOT NULL CHECK (status IN ('solicitada', 'aprovada', 'recusada', 'recebida')),
  requester_id text NOT NULL REFERENCES users(id),
  approver_id text REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  received_at timestamptz,
  notes text
);

CREATE TABLE equipment (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  location text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('geladeira', 'ambiente', 'freezer')),
  min_temp numeric(5,2) NOT NULL,
  max_temp numeric(5,2) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (max_temp > min_temp)
);

CREATE TABLE sensors (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  equipment_id text NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE temperature_readings (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  equipment_id text NOT NULL REFERENCES equipment(id),
  sensor_id text REFERENCES sensors(id),
  value numeric(5,2) NOT NULL CHECK (value BETWEEN -50 AND 60),
  at timestamptz NOT NULL DEFAULT now(),
  author_id text NOT NULL REFERENCES users(id)
);

CREATE TABLE temperature_alerts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  equipment_id text NOT NULL REFERENCES equipment(id),
  reading_id text REFERENCES temperature_readings(id),
  kind text NOT NULL CHECK (kind IN ('abaixo', 'acima')),
  message text NOT NULL,
  status text NOT NULL CHECK (status IN ('aberto', 'resolvido')),
  at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text REFERENCES users(id)
);

CREATE TABLE notifications (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  read boolean NOT NULL DEFAULT false,
  link text
);

CREATE TABLE import_jobs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  filename text NOT NULL,
  status text NOT NULL CHECK (status IN ('concluida', 'com_erros', 'falhou')),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL,
  storage_path text
);

CREATE TABLE modules (
  id text PRIMARY KEY,
  label text NOT NULL,
  epic text NOT NULL,
  group_name text NOT NULL,
  description text NOT NULL,
  scope text NOT NULL
);

CREATE TABLE agenda_events (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL,
  patient_id text REFERENCES patients(id),
  professional_id text NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('agendado', 'realizado', 'cancelado')),
  notes text,
  CHECK (ends_at > starts_at)
);

CREATE TABLE visits (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id),
  visitor_name text NOT NULL,
  relation text NOT NULL,
  document text,
  arrived_at timestamptz NOT NULL,
  left_at timestamptz,
  registered_by text NOT NULL REFERENCES users(id),
  notes text,
  CHECK (left_at IS NULL OR left_at >= arrived_at)
);

CREATE TABLE emergencies (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text REFERENCES patients(id),
  kind text NOT NULL,
  description text NOT NULL,
  status text NOT NULL CHECK (status IN ('aberta', 'em_atendimento', 'encerrada')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by text NOT NULL REFERENCES users(id),
  closed_at timestamptz
);

CREATE TABLE appointments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id text NOT NULL REFERENCES patients(id),
  specialty text NOT NULL CHECK (specialty IN ('fisioterapia', 'medicina', 'odontologia', 'psicologia', 'nutricao')),
  professional_id text NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL,
  summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('rascunho', 'finalizado'))
);

CREATE TABLE audit_log (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX evolutions_patient_at ON evolutions (patient_id, at DESC);
CREATE INDEX vitals_patient_at ON vitals (patient_id, at DESC);
CREATE INDEX occurrences_patient_status ON occurrences (patient_id, status);
CREATE INDEX notifications_user_read ON notifications (user_id, read);
CREATE INDEX medication_lots_expiry ON medication_lots (expiry);
CREATE INDEX temperature_alerts_status ON temperature_alerts (status);
CREATE INDEX patients_status ON patients (status);
CREATE INDEX patients_name ON patients (name);

-- Atualização não destrutiva do prontuário do Grupo 1 em banco existente.
BEGIN;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS linked_record_type text,
  ADD COLUMN IF NOT EXISTS linked_record_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname = 'documents_linked_record_type_check'
  ) THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_linked_record_type_check
      CHECK (linked_record_type IN ('evolucao', 'ocorrencia', 'plano'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname = 'documents_linked_record_pair_check'
  ) THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_linked_record_pair_check
      CHECK ((linked_record_type IS NULL) = (linked_record_id IS NULL));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS documents_patient_record
  ON public.documents (patient_id, linked_record_type, linked_record_id);

ALTER TABLE public.care_plan_updates
  ADD COLUMN IF NOT EXISTS previous_data jsonb,
  ADD COLUMN IF NOT EXISTS new_data jsonb;

INSERT INTO public.permissions (code, label, group_name) VALUES
  ('clinico.view', 'Consultar dados clínicos estruturados', 'Prontuário'),
  ('clinico.edit', 'Editar dados clínicos estruturados', 'Prontuário')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, group_name = EXCLUDED.group_name;

INSERT INTO public.role_permissions (role_id, permission_code)
SELECT grants.role_id, grants.permission_code
FROM (VALUES
  ('admin', 'clinico.view'), ('admin', 'clinico.edit'),
  ('gestor', 'clinico.view'),
  ('enfermagem', 'clinico.view'), ('enfermagem', 'clinico.edit'),
  ('tecnico', 'clinico.view'),
  ('medico', 'clinico.view'), ('medico', 'clinico.edit'),
  ('fisioterapia', 'clinico.view'),
  ('odontologia', 'clinico.view')
) AS grants(role_id, permission_code)
JOIN public.roles ON roles.id = grants.role_id
ON CONFLICT (role_id, permission_code) DO NOTHING;

COMMIT;

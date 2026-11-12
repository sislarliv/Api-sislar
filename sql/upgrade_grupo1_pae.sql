-- Aplicar uma vez em bancos SISLAR existentes, sem recriar os dados.
-- Reexecutar é seguro. Requer public.users, public.paes, public.pae_actions e public.pop_versions.
BEGIN;

ALTER TABLE public.pae_actions ADD COLUMN IF NOT EXISTS done_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pae_actions'::regclass
      AND conname = 'pae_actions_done_by_fkey'
  ) THEN
    ALTER TABLE public.pae_actions
      ADD CONSTRAINT pae_actions_done_by_fkey
      FOREIGN KEY (done_by) REFERENCES public.users(id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.pae_versions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pae_id text NOT NULL REFERENCES public.paes(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  at timestamptz NOT NULL DEFAULT now(),
  by_id text NOT NULL REFERENCES public.users(id),
  summary text NOT NULL,
  snapshot jsonb NOT NULL,
  UNIQUE (pae_id, version)
);

ALTER TABLE public.pop_versions ADD COLUMN IF NOT EXISTS snapshot jsonb;

UPDATE public.pop_versions AS version
SET snapshot = jsonb_build_object(
  'code', pop.code, 'version', pop.version, 'title', pop.title,
  'category', pop.category, 'purpose', pop.purpose,
  'responsibleId', pop.responsible_id,
  'validFrom', to_char(pop.valid_from, 'YYYY-MM-DD'),
  'validUntil', to_char(pop.valid_until, 'YYYY-MM-DD'),
  'status', pop.status, 'sections', pop.sections, 'related', pop.related
)
FROM public.pops AS pop
WHERE version.pop_id = pop.id AND version.version = pop.version AND version.snapshot IS NULL;

COMMIT;

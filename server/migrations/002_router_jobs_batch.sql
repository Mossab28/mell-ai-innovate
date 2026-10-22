-- Chaque décision du routeur est gardée : de quoi entraîner un petit classifieur plus tard.
CREATE TABLE router_decisions (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  text          text NOT NULL,
  class         text NOT NULL,              -- classe finale appliquée
  raw_class     text,                       -- classe proposée par le modèle, avant seuil
  confidence    real,
  tapback       text,
  source        text NOT NULL,              -- model, rule, fallback
  model         text,
  latency_ms    integer NOT NULL DEFAULT 0,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX router_decisions_created ON router_decisions(created_at);

-- Travail long en tâche de fond, après l'accusé immédiat. Bail borné, tentatives bornées.
CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request      text NOT NULL,
  model        text NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  lease_until  timestamptz,
  deadline_at  timestamptz NOT NULL,
  result       text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_pending ON jobs(created_at) WHERE status IN ('queued', 'running');

-- Chemin batch, non temps réel : briefs du matin, veilles. Prêt pour l'inférence batch.
CREATE TABLE batch_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,               -- morning_brief, watch
  schedule_id  uuid REFERENCES schedules(id) ON DELETE SET NULL,
  deliver_at   timestamptz NOT NULL,        -- heure d'envoi à respecter
  payload      text NOT NULL,               -- consigne et contexte, figés à la création
  model        text NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts     integer NOT NULL DEFAULT 0,
  lease_until  timestamptz,
  result       text,
  error        text,
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX batch_jobs_pending ON batch_jobs(deliver_at) WHERE status IN ('queued', 'running');

-- Un rappel envoie un texte prêt ; un brief passe par le chemin batch.
ALTER TABLE schedules ADD COLUMN action text NOT NULL DEFAULT 'send_text' CHECK (action IN ('send_text', 'brief'));

-- Un envoi peut attendre son heure (brief préparé en avance).
ALTER TABLE outbox ADD COLUMN not_before timestamptz;

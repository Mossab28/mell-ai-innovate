-- Profil web de chaque personne (cookies + stockage local), chiffré par une clé dérivée pour elle.
-- Gardé par le serveur, jamais par l'hôte qui exécute les pages.
CREATE TABLE browser_profiles (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sealed     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Un site a envoyé un code (SMS, mail) : la tâche attend la réponse de la personne dans le fil.
CREATE TABLE browser_waits (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     uuid,
  question    text NOT NULL,
  answer      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  answered_at timestamptz
);
CREATE INDEX browser_waits_open ON browser_waits(user_id) WHERE answered_at IS NULL;

-- Journal de chaque passage du navigateur : de quoi répondre « où en est X ? » et mesurer.
CREATE TABLE browser_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  task_id     uuid,
  engine      text NOT NULL,
  objective   text NOT NULL,
  status      text NOT NULL,
  answer      text,
  reason      text,
  steps       integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  cost_usd    numeric(10, 5) NOT NULL DEFAULT 0,
  errors      jsonb,
  pages       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_runs_user ON browser_runs(user_id, created_at DESC);

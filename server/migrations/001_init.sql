-- Lignes iMessage : un Mac, un identifiant Apple, un numéro.
CREATE TABLE lines (
  id          text PRIMARY KEY,
  handle      text NOT NULL,              -- numéro ou adresse de la ligne
  secret      text NOT NULL,              -- secret HMAC du relais
  active      boolean NOT NULL DEFAULT true,
  max_users   integer NOT NULL DEFAULT 500,
  last_seen_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle           text NOT NULL UNIQUE,  -- numéro ou adresse de l'utilisateur
  line_id          text NOT NULL REFERENCES lines(id),
  name             text,
  timezone         text NOT NULL DEFAULT 'Europe/Paris',
  lang             text NOT NULL DEFAULT 'fr',
  attribution_code text,
  turn_lock_until  timestamptz,           -- un seul tour d'agent à la fois par personne
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_line ON users(line_id);

-- Historique de conversation, dans les deux sens.
CREATE TABLE messages (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction    text NOT NULL CHECK (direction IN ('in', 'out')),
  guid         text UNIQUE,               -- guid iMessage (entrants)
  text         text,
  tapback      text,
  target_guid  text,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz                -- entrants : traité par un tour d'agent
);
CREATE INDEX messages_user ON messages(user_id, id);
CREATE INDEX messages_pending ON messages(user_id) WHERE direction = 'in' AND processed_at IS NULL;

-- Mémoire : des faits courts, lisibles et effaçables par l'utilisateur.
CREATE TABLE memories (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fact       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_user ON memories(user_id);

-- Rappels et routines. Le texte est écrit à la création : à l'heure dite on envoie, sans modèle.
CREATE TABLE schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('once', 'recurring')),
  cron           text,                    -- recurring : expression cron, lue dans le fuseau
  timezone       text NOT NULL,
  message        text NOT NULL,
  next_run_at    timestamptz NOT NULL,
  missed_policy  text NOT NULL DEFAULT 'send_late' CHECK (missed_policy IN ('send_late', 'skip')),
  grace_seconds  integer NOT NULL DEFAULT 7200,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled')),
  last_run_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due ON schedules(next_run_at) WHERE status = 'active';

-- File d'envoi durable : le relais réclame, envoie, acquitte. Une réclamation expire toujours.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  line_id       text NOT NULL REFERENCES lines(id),
  to_handle     text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('text', 'tapback')),
  text          text,
  tapback       text,
  target_guid   text,
  effect        text,
  dedupe_key    text UNIQUE,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'sent', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  claimed_until timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX outbox_pending ON outbox(line_id, id) WHERE status IN ('queued', 'claimed');

-- Tâches autorisées une fois, pour un périmètre donné.
CREATE TABLE tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL,
  actions        text[] NOT NULL,
  spend_cap_cents integer NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'EUR',
  spent_cents    integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed', 'authorized', 'awaiting_bank', 'done', 'cancelled', 'expired')),
  authorized_at  timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_user ON tasks(user_id, created_at DESC);

-- Journal de chaque étape tentée, autorisée ou refusée.
CREATE TABLE task_steps (
  id           bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action       text NOT NULL,
  amount_cents integer NOT NULL DEFAULT 0,
  detail       text,
  decision     text NOT NULL CHECK (decision IN ('allowed', 'needs_approval', 'awaiting_bank')),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

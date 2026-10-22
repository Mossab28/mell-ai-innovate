-- Proactivité : la personne règle le volume (« moins de messages », « pas avant lundi »),
-- et Mell se crée des surveillances (« je te dis s'il y a un créneau plus tôt »).

-- quiet_until : rien de proactif avant cette heure ; proactive = less : seulement l'important.
ALTER TABLE users ADD COLUMN quiet_until timestamptz;
ALTER TABLE users ADD COLUMN proactive text NOT NULL DEFAULT 'normal' CHECK (proactive IN ('normal', 'less'));

CREATE TABLE watches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  what           text NOT NULL,                 -- ce que la personne lit : « un créneau de dermato avant le 30 »
  source         text NOT NULL CHECK (source IN ('doctolib', 'sncf', 'thefork', 'weather', 'mail', 'web')),
  args           jsonb NOT NULL DEFAULT '{}',
  condition      text NOT NULL,                 -- quand prévenir, en clair
  every_minutes  integer NOT NULL,
  next_check_at  timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_summary   text,                          -- ce qu'on a vu au dernier passage, pour ne pas répéter
  last_checked_at timestamptz,
  checks         integer NOT NULL DEFAULT 0,
  failures       integer NOT NULL DEFAULT 0,    -- échecs d'affilée
  lease_until    timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled', 'expired', 'failed')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watches_due ON watches(next_check_at) WHERE status = 'active';
CREATE INDEX watches_user ON watches(user_id) WHERE status = 'active';

-- Coffre : les valeurs vivent dans OpenBao. Ici, seulement ce qui n'est pas secret.

-- Index des entrées : ce que le modèle a le droit de savoir (une référence, un site, une date).
CREATE TABLE vault_entries (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ref        text NOT NULL,                 -- vault://login/resy.com
  kind       text NOT NULL CHECK (kind IN ('login', 'totp', 'personal')),
  name       text NOT NULL,                 -- resy.com, address
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ref)
);

-- Journal d'accès lisible par la personne : qui a écrit, injecté ou effacé quoi, pour quelle tâche.
CREATE TABLE vault_access_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ref        text,
  action     text NOT NULL CHECK (action IN ('put', 'inject', 'delete', 'delete_all', 'refused')),
  actor      text NOT NULL CHECK (actor IN ('user_link', 'thread', 'agent', 'system')),
  task_id    uuid,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_access_log_user ON vault_access_log(user_id, id);

-- Liens à usage unique pour saisir un secret hors du fil. Seul le haché du jeton est gardé.
CREATE TABLE vault_links (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('login', 'totp', 'personal')),
  site       text,
  task_id    uuid REFERENCES tasks(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_links_user ON vault_links(user_id);

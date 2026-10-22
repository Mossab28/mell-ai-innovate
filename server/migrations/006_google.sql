-- Connexion Google (Gmail + Agenda). Le jeton de rafraîchissement vit au coffre, chiffré par personne ;
-- ici, seulement ce qui n'est pas secret.

-- Un compte Google par personne. revoked : Google a refusé le jeton (accès retiré, mot de passe changé),
-- il faut un nouveau lien.
CREATE TABLE google_connections (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email        text,
  scopes       text[] NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Liens de connexion à usage unique envoyés dans le fil. Seul le haché de l'identifiant est gardé.
CREATE TABLE connect_links (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('google')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connect_links_user ON connect_links(user_id);

-- Journal des écritures chez Google (brouillon, envoi, événement) : des identifiants, jamais de contenu.
-- Effacé à la déconnexion, sauf la ligne qui dit qu'elle a eu lieu.
CREATE TABLE google_actions (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     text NOT NULL,
  target     text,
  task_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_actions_user ON google_actions(user_id, id);

-- Règle 7 : une tâche annonce aussi ses destinataires. Un mail ou une invitation ne part qu'à eux.
ALTER TABLE tasks ADD COLUMN recipients text[] NOT NULL DEFAULT '{}';

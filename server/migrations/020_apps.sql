-- Connecteurs via Composio (déjà validé par Google : aucun écran « appli non vérifiée »).
-- Gmail et Agenda réutilisent google_connections : method = composio, et l'id du compte Composio sert
-- de jeton (les appels Google REST passent par le proxy Composio). Les autres apps ont leur table.
ALTER TABLE google_connections DROP CONSTRAINT google_connections_method_check;
ALTER TABLE google_connections ADD CONSTRAINT google_connections_method_check CHECK (method IN ('oauth', 'app_password', 'composio'));
ALTER TABLE google_connections ADD COLUMN composio_account_id text;
ALTER TABLE google_connections ADD COLUMN composio_auth_config_id text;

-- Les autres connecteurs (Drive, Sheets, Outlook, Notion, Slack, Linear, HubSpot, Airtable, Asana, Trello, Stripe).
CREATE TABLE app_connections (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service        text NOT NULL,
  account_id     text NOT NULL,              -- compte connecté chez Composio
  auth_config_id text NOT NULL,
  login          text,                        -- ce qu'on dit à la personne (adresse, nom de compte)
  scopes         text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  connected_at   timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, service)
);

-- Connexions en cours : un lien a été envoyé, on suit le compte jusqu'à ce qu'il soit actif, puis on range
-- la vraie connexion et Mell écrit dans le fil. Au-delà de l'expiration, on abandonne.
CREATE TABLE app_connect_pending (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service        text NOT NULL,
  account_id     text NOT NULL,
  auth_config_id text NOT NULL,
  google         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (user_id, service)
);
CREATE INDEX app_connect_pending_live ON app_connect_pending(expires_at);

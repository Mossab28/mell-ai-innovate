-- Compte web par numéro : un code à 6 chiffres envoyé dans le fil Mell (ou par mail en secours), puis une session.
CREATE TABLE web_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  email       text,                                   -- renseigné si le code est parti par mail
  attempts    integer NOT NULL DEFAULT 0,
  verified_at timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_codes_user ON web_codes(user_id, created_at);

CREATE TABLE web_sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_sessions_user ON web_sessions(user_id);

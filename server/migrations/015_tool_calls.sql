-- Chaque appel d'outil de l'agent, avec ce qu'il a rendu : pour comprendre après coup pourquoi Mell
-- n'a pas fait ce qu'on lui demandait (règle 9 : tout se journalise).
CREATE TABLE tool_calls (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  mode       text,
  name       text NOT NULL,
  args       text,
  result     text,
  ms         integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_user ON tool_calls(user_id, id);

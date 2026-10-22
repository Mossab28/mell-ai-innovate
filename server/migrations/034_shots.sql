-- Captures d'écran envoyées dans le fil (confirmation de réservation ou d'achat) : servies par un lien
-- imprévisible, gardées 30 jours.
CREATE TABLE shots (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       text NOT NULL DEFAULT 'image/jpeg',
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shots_created ON shots(created_at);

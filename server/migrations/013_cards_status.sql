-- Cartes : chaque option (logement, restaurant, produit) devient un lien vers une page Mell avec
-- photo, titre et prix ; iMessage l'affiche en carte. Un bouton sur la page renvoie le choix à Mell.
CREATE TABLE cards (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  subtitle    text,
  url         text,
  image_url   text,
  source_host text,
  chosen_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cards_user ON cards(user_id, created_at);

-- Chargement : « en train d'écrire » entretenu pendant un travail de fond, et une bulle
-- d'avancement éditée sur place plutôt que des messages empilés.
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('text', 'tapback', 'delete', 'typing', 'edit'));
ALTER TABLE outbox ADD COLUMN edits integer NOT NULL DEFAULT 0;

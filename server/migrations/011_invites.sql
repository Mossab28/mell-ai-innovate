-- Accès sur invitation, comme Instinct : un code dans le premier message fait entrer, sinon la
-- personne attend sur la liste et Mell lui écrit quand c'est son tour.
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waitlist'));
ALTER TABLE users ADD COLUMN admitted_at timestamptz;
ALTER TABLE users ADD COLUMN waitlist_nudged_at timestamptz;

-- Un code par personne (ses invitations) ou par créateur (un stock). Le code est celui du texte pré-rempli : « Salut Mell ! (k7q2) ».
CREATE TABLE invites (
  code        text PRIMARY KEY,
  owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  label       text,
  uses_left   integer NOT NULL CHECK (uses_left >= 0),
  used        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invites_owner ON invites(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX users_waitlist ON users(created_at) WHERE status = 'waitlist';

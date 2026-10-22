-- Demandes d'accès depuis askmell.com : numéro et mail gardés, Moss'Ab accorde ou refuse depuis /admin.
CREATE TABLE access_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  email       text,
  country     text,                                   -- indicatif choisi (33, 44...)
  lang        text NOT NULL DEFAULT 'en',
  invite_code text,                                   -- code d'invitation présenté, s'il y en avait un
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE UNIQUE INDEX access_requests_phone_pending ON access_requests(phone) WHERE status = 'pending';
CREATE INDEX access_requests_status ON access_requests(status, created_at);

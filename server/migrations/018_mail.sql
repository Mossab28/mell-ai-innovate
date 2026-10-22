-- Une adresse mail à Mell pour chaque personne, comme Instinct (2333q@mail.instinct.com) : elle le met
-- en copie, lui transfère un mail, ou fait suivre toute sa boîte. Sans connecter Google.
-- Seule la partie avant @ est gardée : le domaine peut changer, l'adresse reste la même.
ALTER TABLE users ADD COLUMN mail_alias text UNIQUE;

-- Ses adresses à elle. Un mail authentifié venu de l'une d'elles vaut une demande de sa part,
-- une adresse n'entre ici que par Google connecté ou par son oui dans le fil.
CREATE TABLE mail_addresses (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address    text NOT NULL,              -- en minuscules
  source     text NOT NULL CHECK (source IN ('google', 'user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address)
);

-- Les mails reçus sur son adresse Mell. Gardés 30 jours, effaçables à sa demande.
CREATE TABLE inbox (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id    text NOT NULL,
  -- from_user : écrit par elle (copie, transfert à la main) ; forwarded : sa boîte qui fait suivre,
  -- other : quelqu'un d'autre écrit à l'adresse de Mell ; gmail_confirm : Gmail demande d'accepter le transfert.
  kind          text NOT NULL CHECK (kind IN ('from_user', 'forwarded', 'other', 'gmail_confirm')),
  from_addr     text,
  from_name     text,
  to_addrs      text,
  cc_addrs      text,
  subject       text,
  sent_at       timestamptz,
  body          text,
  attachments   jsonb NOT NULL DEFAULT '[]',
  authenticated boolean NOT NULL DEFAULT false,  -- DMARC (ou DKIM aligné) : l'expéditeur est bien celui qu'il dit
  forwarded_by  text,                            -- la boîte qui a fait suivre
  -- held : en attente de son oui (adresse inconnue qui se dit elle, ou transfert Gmail à accepter).
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'working', 'done', 'held')),
  lease_until   timestamptz,
  note          text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX inbox_user ON inbox(user_id, received_at DESC);
CREATE INDEX inbox_todo ON inbox(received_at) WHERE status IN ('new', 'working');

-- Gmail par mot de passe d'application (IMAP + SMTP de Google) : toute sa boîte, historique et envoi,
-- sans la validation Google ni l'écran « appli non validée ». Le code vit au coffre sous « gmail-app ».
-- method dit par où passent les mails ; l'agenda, s'il est coché, passe toujours par la connexion Google.
ALTER TABLE google_connections ADD COLUMN method text NOT NULL DEFAULT 'oauth' CHECK (method IN ('oauth', 'app_password'));

ALTER TABLE connect_links DROP CONSTRAINT connect_links_provider_check;
ALTER TABLE connect_links ADD CONSTRAINT connect_links_provider_check CHECK (provider IN ('google', 'gmail-app'));
-- Codes refusés par Google sur ce lien : au cinquième, le lien ne sert plus.
ALTER TABLE connect_links ADD COLUMN attempts integer NOT NULL DEFAULT 0;

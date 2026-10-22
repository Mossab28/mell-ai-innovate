-- Demande d'accès sans numéro : l'e-mail (adresse iMessage) suffit, Mell écrit à cette adresse.
ALTER TABLE access_requests ALTER COLUMN phone DROP NOT NULL;
CREATE UNIQUE INDEX access_requests_email_pending ON access_requests(email) WHERE status = 'pending' AND phone IS NULL;

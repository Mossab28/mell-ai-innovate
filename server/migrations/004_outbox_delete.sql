-- Consigne « supprimer ce message » envoyée au relais (secret tapé par l'utilisateur dans le fil).
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('text', 'tapback', 'delete'));

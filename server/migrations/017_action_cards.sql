-- Cartes d'action : au-delà des options (logements), un brouillon de mail avec « Envoyer », un achat avec
-- « Acheter · 34 € ». Toucher le bouton vaut l'accord de la personne pour cette action précise.
ALTER TABLE cards ADD COLUMN kind text NOT NULL DEFAULT 'option' CHECK (kind IN ('option', 'draft', 'purchase', 'info'));
ALTER TABLE cards ADD COLUMN body text;
ALTER TABLE cards ADD COLUMN actions jsonb NOT NULL DEFAULT '["choose"]';
ALTER TABLE cards ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
ALTER TABLE cards ADD COLUMN price_cents integer;
ALTER TABLE cards ADD COLUMN currency text NOT NULL DEFAULT 'EUR';
ALTER TABLE cards ADD COLUMN done_action text;

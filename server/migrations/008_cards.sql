-- Carte bancaire au coffre (phase de test entre nous) : chiffrée par personne comme le reste,
-- le modèle n'en voit que la marque et les quatre derniers chiffres (vault://card/visa-4242).
ALTER TABLE vault_entries DROP CONSTRAINT IF EXISTS vault_entries_kind_check;
ALTER TABLE vault_entries ADD CONSTRAINT vault_entries_kind_check CHECK (kind IN ('login', 'totp', 'personal', 'card'));
ALTER TABLE vault_links DROP CONSTRAINT IF EXISTS vault_links_kind_check;
ALTER TABLE vault_links ADD CONSTRAINT vault_links_kind_check CHECK (kind IN ('login', 'totp', 'personal', 'card'));

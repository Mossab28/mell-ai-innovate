-- Message « carte » : une image et une légende (lien) dans le MÊME message iMessage, comme une photo
-- envoyée avec du texte. Doit passer APRÈS 025_image (qui recrée la contrainte sans « card »).
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('text', 'tapback', 'delete', 'typing', 'edit', 'call', 'contact', 'image', 'card'));
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS image_url text;

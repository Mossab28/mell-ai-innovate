-- Fiche contact envoyée à l'inscription (vCard) : une fois Mell dans les contacts, iMessage affiche
-- les aperçus des cartes tout seul, sans « Toucher pour charger ».
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('text', 'tapback', 'delete', 'typing', 'edit', 'call', 'contact'));

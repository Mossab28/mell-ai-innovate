-- Cartes envoyées en photo : une photo s'affiche toujours d'office, un lien seul demande
-- « Toucher pour charger l'aperçu » même quand Mell est dans les contacts (constaté le 17/10).
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('text', 'tapback', 'delete', 'typing', 'edit', 'call', 'contact', 'image'));

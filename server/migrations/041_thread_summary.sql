-- La fiche de reprise du fil (compaction.ts, à la Hermes et OpenClaw) : ce qui s'est dit avant les derniers messages
-- que l'agent voit, tenue à jour par le même modèle. upto = le dernier message déjà repris dans la fiche.
ALTER TABLE users ADD COLUMN thread_summary text;
ALTER TABLE users ADD COLUMN thread_summary_upto bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN thread_summary_at timestamptz;

-- La voix de la personne, lue par le modèle sur ses propres messages, pour que Mell s'en rapproche peu à peu.
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_note text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_note_msgs integer NOT NULL DEFAULT 0;

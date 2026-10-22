-- La revue d'une conversation calmée (apprendre de ses corrections) : jusqu'où elle a déjà été relue.
ALTER TABLE users ADD COLUMN reviewed_at timestamptz;

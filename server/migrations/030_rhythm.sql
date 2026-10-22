-- Les heures des passages de Mell (matin, midi, soir), propres à chaque personne, lues par le modèle sur son rythme réel.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pulse_times jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pulse_times_at timestamptz;

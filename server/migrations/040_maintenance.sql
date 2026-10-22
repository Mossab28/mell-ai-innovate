-- Les passages d'entretien qui ne doivent pas repartir à chaque redémarrage (le curateur, une fois par semaine).
CREATE TABLE maintenance (
  name        text PRIMARY KEY,
  last_run_at timestamptz NOT NULL
);

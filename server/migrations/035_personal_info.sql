-- Ses infos perso (nom, e-mail, téléphone, adresse, date de naissance) : une mémoire que Mell lit et remplit
-- lui-même pour les formulaires. Le coffre ne garde que les vrais secrets (identifiants, cartes).
CREATE TABLE personal_info (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field      text NOT NULL CHECK (field IN ('full_name', 'email', 'phone', 'address', 'birthdate')),
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, field)
);

-- Un seul travail de fond à la fois par personne : ce qu'elle écrit pendant qu'il tourne (une précision, un
-- « attends », la même demande redite) et les avis du système (dépôt au coffre, accord) lui sont remis ici,
-- au lieu de lancer un second travail qui répondrait à côté du premier.
ALTER TABLE jobs ADD COLUMN followups jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Un retour que Mell s'est fixé peut finir sans rien écrire : rien à dire si c'est réglé.
ALTER TABLE jobs ADD COLUMN quiet_ok boolean NOT NULL DEFAULT false;

-- Retour que Mell se fixe de lui-même (un prix qui tombe à 23 h 53, un panier qui expire, une réponse attendue).
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_action_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_action_check CHECK (action IN ('send_text', 'brief', 'follow_up', 'check_back'));

-- Ses cartes de réduction, abonnements et cartes de fidélité : le navigateur les applique sur tout site où elles valent.
ALTER TABLE personal_info DROP CONSTRAINT IF EXISTS personal_info_field_check;
ALTER TABLE personal_info ADD CONSTRAINT personal_info_field_check CHECK (field IN ('full_name', 'email', 'phone', 'address', 'birthdate', 'discounts'));

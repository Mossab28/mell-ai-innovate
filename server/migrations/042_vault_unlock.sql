-- Le coffre de l'espace web (/me/coffre) s'ouvre avec un nouveau code, même déjà connecté : identifiants, cartes et
-- infos perso restent fermés sans lui. vault_until = jusqu'à quand cette session voit le coffre (5 minutes).
-- purpose distingue le code de connexion du code du coffre : l'un n'ouvre jamais l'autre.
ALTER TABLE web_sessions ADD COLUMN vault_until timestamptz;
ALTER TABLE web_codes ADD COLUMN purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'vault'));

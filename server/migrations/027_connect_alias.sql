-- Lien de connexion à notre nom : la personne voit askmell.com/connect/<jeton>, qui renvoie vers l'écran
-- Composio ; après l'autorisation, Composio la ramène sur askmell.com/connected/<jeton>, puis dans Messages.
ALTER TABLE app_connect_pending ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE app_connect_pending ADD COLUMN IF NOT EXISTS url text;
CREATE UNIQUE INDEX IF NOT EXISTS app_connect_pending_token ON app_connect_pending(token);

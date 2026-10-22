-- Échanges par réaction : on garde l'identifiant iMessage de chaque bulle envoyée (rendu par
-- BlueBubbles), pour savoir sur quoi la personne réagit, et à quoi la bulle se rapporte.
ALTER TABLE outbox ADD COLUMN guid text;
ALTER TABLE outbox ADD COLUMN ref text;
ALTER TABLE outbox ADD COLUMN reply_to text;
CREATE INDEX outbox_guid ON outbox(guid) WHERE guid IS NOT NULL;

-- Un résultat de travail de fond répond dans le fil du message qui l'a demandé.
ALTER TABLE jobs ADD COLUMN source_guid text;

-- Rappel qui relance : sans réaction ni réponse, une seule relance plus tard.
ALTER TABLE schedules ADD COLUMN follow_up_message text;
ALTER TABLE schedules ADD COLUMN follow_up_minutes integer;
ALTER TABLE schedules ADD COLUMN after_at timestamptz;
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_action_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_action_check CHECK (action IN ('send_text', 'brief', 'follow_up'));

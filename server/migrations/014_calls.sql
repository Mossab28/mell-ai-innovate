-- « Mell t'appelle » : un rappel peut finir en appel FaceTime audio.
--   wake         : réveil, l'appel part à l'heure dite (avec le texto) ;
--   if_no_answer : le texto part à l'heure, puis l'appel si elle n'a ni réagi ni répondu.
-- Sur une relance (action follow_up), call_mode dit que la relance est un appel.
ALTER TABLE schedules ADD COLUMN call_mode text CHECK (call_mode IN ('wake', 'if_no_answer'));

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('text', 'tapback', 'delete', 'typing', 'edit', 'call'));

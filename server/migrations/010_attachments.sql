-- Photos et vocaux reçus : gardés le temps d'être lus (description, transcription), puis effacés.
-- Seul le texte qu'on en tire reste dans la conversation.
CREATE TABLE attachments (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('image', 'audio', 'file')),
  mime       text NOT NULL,
  name       text,
  data       bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message ON attachments(message_id);

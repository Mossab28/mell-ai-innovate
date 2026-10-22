-- Composio identities belong to one toolkit. Reuse the per-service table so
-- connecting Calendar cannot replace Gmail or a direct Google connection.
WITH legacy AS (
  SELECT g.*,
    EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'https://www.googleapis.com/auth/gmail.%' OR s = 'https://mail.google.com/') AS has_mail,
    EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'https://www.googleapis.com/auth/calendar%') AS has_calendar
  FROM google_connections g
  WHERE method = 'composio' AND composio_account_id IS NOT NULL AND composio_auth_config_id IS NOT NULL
)
INSERT INTO app_connections (user_id, service, account_id, auth_config_id, login, scopes, status, connected_at, updated_at)
SELECT user_id, CASE WHEN has_mail THEN 'gmail' ELSE 'calendar' END,
  composio_account_id, composio_auth_config_id, email, scopes, status, connected_at, updated_at
FROM legacy WHERE has_mail <> has_calendar
ON CONFLICT (user_id, service) DO NOTHING;

-- Keep ambiguous old records for diagnosis, but never reuse one toolkit identity
-- for two services. Such records need a fresh service-specific connection.
DELETE FROM google_connections g WHERE method = 'composio' AND EXISTS (
  SELECT 1 FROM app_connections a WHERE a.user_id = g.user_id
    AND a.service IN ('gmail', 'calendar') AND a.account_id = g.composio_account_id
);

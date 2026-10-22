-- L'arbre des invitations : qui a fait entrer qui, et à quelle profondeur. Les quotas se réduisent avec la
-- profondeur (5, 3, 1, puis 0) : une personne que Moss'Ab fait entrer en a 5, ceux qu'elle invite 3, etc.
ALTER TABLE users ADD COLUMN invited_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN invite_depth integer NOT NULL DEFAULT 0;
CREATE INDEX users_invited_by ON users(invited_by);
UPDATE users u SET invited_by = i.owner_id FROM invites i WHERE i.code = u.attribution_code AND i.owner_id IS NOT NULL AND i.owner_id <> u.id;
UPDATE users c SET invite_depth = p.invite_depth + 1 FROM users p WHERE c.invited_by = p.id;
UPDATE users c SET invite_depth = p.invite_depth + 1 FROM users p WHERE c.invited_by = p.id;
UPDATE users c SET invite_depth = p.invite_depth + 1 FROM users p WHERE c.invited_by = p.id;

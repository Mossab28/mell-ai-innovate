-- Modes d'emploi appris par Mell (docs/SELF-IMPROVEMENT.md, repris de Hermes Agent) : la marche à suivre pour un site
-- ou une classe de tâches, écrite et corrigée par la revue après chaque travail de fond. `global` : partagé entre tous,
-- jamais de donnée personnelle ; `user` : la façon de faire d'une personne. Une leçon de comportement globale attend
-- l'accord dans /admin (`pending`) ; un mode d'emploi de site sert tout de suite.
CREATE TABLE skills (
  id           bigserial PRIMARY KEY,
  scope        text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'user')),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL,
  body         text NOT NULL,
  domains      text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'stale', 'archived')),
  version      integer NOT NULL DEFAULT 1,
  uses         integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_by   text NOT NULL DEFAULT 'review',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX skills_owner_name ON skills ((coalesce(user_id::text, '')), (lower(name)));

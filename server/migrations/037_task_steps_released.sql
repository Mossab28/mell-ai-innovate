-- Un paiement cliqué qui n'a pas abouti est rendu (releasePayment) : son étape le garde en mémoire, pour ne jamais le
-- rendre deux fois.
ALTER TABLE task_steps DROP CONSTRAINT IF EXISTS task_steps_decision_check;
ALTER TABLE task_steps ADD CONSTRAINT task_steps_decision_check CHECK (decision IN ('allowed', 'needs_approval', 'awaiting_bank', 'released'));

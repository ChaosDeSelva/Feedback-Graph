-- Run owners: who opened each run id (RunsStore.claim), from its first labelled write. A later write under the run by
-- anyone else is refused, and the operator token may clean up only a run it opened. A run with no row was opened
-- before owners were recorded: only you can clean it up.
CREATE TABLE run_owners (
  run        text PRIMARY KEY,
  principal  text NOT NULL CONSTRAINT run_owners_principal_check CHECK (principal IN ('operator', 'owner_token', 'browser', 'agent')),
  first_seen timestamptz NOT NULL
);

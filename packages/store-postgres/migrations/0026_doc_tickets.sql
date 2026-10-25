-- The Linear identifiers a pull request's document names in its title, body or branch (ENG-123): linkedDocs joins
-- them to the project's Linear ticket documents (ref 'linear:<identifier>'), both ways. Replaced on every upsert; empty
-- for uploads, tickets and pull requests synced before this.
ALTER TABLE docs ADD COLUMN tickets text[] NOT NULL DEFAULT '{}';
CREATE INDEX docs_tickets ON docs USING gin (tickets);

-- Imports that look like they name a repo file (a tsconfig path alias, a workspace package) but resolved to none, so
-- importer and test lists from the map may be short. Null: a map built before this was counted.
ALTER TABLE code_maps ADD COLUMN unresolved integer;

-- Where a fact came from (a model reading the code, a manifest read without a model, an uploaded document), and how
-- well its citation was checked when it was saved. Null on facts saved before these were recorded.
ALTER TABLE facts
  ADD COLUMN origin text CONSTRAINT facts_origin_check CHECK (origin IN ('model', 'manifest', 'document')),
  ADD COLUMN evidence text CONSTRAINT facts_evidence_check CHECK (evidence IN ('line', 'file', 'none'));

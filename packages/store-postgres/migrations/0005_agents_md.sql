-- A post-mortem can cite AGENTS.md (the instruction file Codex loads) as its own kind of context item.
ALTER TABLE context_items DROP CONSTRAINT context_items_kind_check;
ALTER TABLE context_items ADD CONSTRAINT context_items_kind_check
  CHECK (kind IN ('code', 'doc', 'claude_md', 'agents_md', 'memory', 'session', 'pr', 'ticket', 'upload'));

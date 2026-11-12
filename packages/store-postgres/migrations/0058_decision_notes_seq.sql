-- A decision's notes in the order they were written: two in the same millisecond tie on ts, and their random ids broke
-- the tie by chance. seq numbers them as inserted (existing notes in their table order).
ALTER TABLE decision_notes ADD COLUMN seq bigserial;
DROP INDEX decision_notes_decision;
CREATE INDEX decision_notes_decision ON decision_notes (decision_id, ts, seq);

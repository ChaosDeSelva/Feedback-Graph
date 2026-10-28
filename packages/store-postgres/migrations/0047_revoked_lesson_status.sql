ALTER TABLE lessons DROP CONSTRAINT lessons_status_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_status_check CHECK (status IN ('proposed', 'approved', 'rejected', 'revoked', 'superseded'));

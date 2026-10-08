ALTER TABLE contents ADD COLUMN intake_method TEXT NOT NULL DEFAULT 'subscription'
    CHECK(intake_method IN ('subscription','manual'));
ALTER TABLE contents ADD COLUMN manual_added_at TEXT
    CHECK((intake_method='subscription' AND manual_added_at IS NULL)
       OR (intake_method='manual' AND manual_added_at IS NOT NULL));

CREATE INDEX content_intake_timeline ON contents(intake_method,manual_added_at DESC,id DESC);

-- First successful intake remains authoritative, including explicit detail enrichment.
CREATE TRIGGER content_intake_immutable BEFORE UPDATE OF intake_method,manual_added_at,first_seen_at ON contents
WHEN NEW.intake_method IS NOT OLD.intake_method
  OR NEW.manual_added_at IS NOT OLD.manual_added_at
  OR NEW.first_seen_at IS NOT OLD.first_seen_at
BEGIN
    SELECT RAISE(ABORT,'First intake metadata is immutable');
END;

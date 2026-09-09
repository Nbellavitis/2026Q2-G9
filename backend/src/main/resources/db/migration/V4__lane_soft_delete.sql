-- Lanes are soft-deleted rather than removed.
--
-- queue_entry.lane_id is NOT NULL and references queue_lane with no ON DELETE action, so every
-- entry a lane has ever held - including the finished ones - pins that row forever. The service
-- guard only counted *active* entries, so a lane whose customers had all been served passed the
-- check and then died on the foreign key, surfacing as an unmapped 500. Keeping the row also keeps
-- the data that makes the feature measurable afterwards: which party-size band each finished
-- customer was served in, and the time factor that was in force at the time.
ALTER TABLE queue_lane ADD COLUMN deleted_at TIMESTAMPTZ;

-- A deleted lane must never be in rotation; `active` stays the single flag every query already reads.
ALTER TABLE queue_lane
    ADD CONSTRAINT ck_lane_deleted_inactive CHECK (deleted_at IS NULL OR active = FALSE);

-- Uniqueness has to stop applying to deleted rows. Otherwise retiring a lane would burn its name
-- for the lifetime of the queue, and recreating it would fail on the constraint - trading the old
-- 500 for a new one.
ALTER TABLE queue_lane DROP CONSTRAINT uq_lane_name;
CREATE UNIQUE INDEX uq_lane_name_live ON queue_lane (queue_id, name) WHERE deleted_at IS NULL;

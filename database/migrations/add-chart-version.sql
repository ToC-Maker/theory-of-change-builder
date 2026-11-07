-- Migration: Add charts.version for compare-and-swap saves
-- Purpose: Every change to chart_data advances charts.version, so a save can
--          say which version it was based on (UPDATE ... WHERE version = $n)
--          and a stale save is refused with the latest chart instead of
--          overwriting it. The trigger makes the Worker, a rolled-back Worker
--          and manual SQL all advance the version the same way; an UPDATE that
--          leaves chart_data unchanged (view_count, link sharing, an identical
--          resave) does not. updated_at cannot serve as the version: the
--          update_charts_updated_at trigger bumps it on any update.
-- Apply:   to staging, then production, BEFORE deploying the Worker. The new
--          Worker reads version and compares on it; the previous Worker keeps
--          working against the migrated schema (additive column, no SELECT *).
-- Down:    roll the Worker back to a version that does not read `version`
--          first (the current one fails every chart read without the column);
--          then DROP TRIGGER charts_bump_version ON charts;
--          DROP FUNCTION bump_chart_version();
--          ALTER TABLE charts DROP COLUMN version;
-- Idempotent: safe to re-run.
--
-- INTEGER, not BIGINT: the @neondatabase/serverless HTTP driver returns int4 as
-- a JS number and int8 as a string. A constant default adds the column without
-- rewriting the table; existing charts start at version 1.

BEGIN;

ALTER TABLE charts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION bump_chart_version() RETURNS trigger AS $$
BEGIN
  IF NEW.chart_data IS DISTINCT FROM OLD.chart_data THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS charts_bump_version ON charts;
CREATE TRIGGER charts_bump_version BEFORE UPDATE OF chart_data ON charts
  FOR EACH ROW EXECUTE FUNCTION bump_chart_version();

COMMIT;

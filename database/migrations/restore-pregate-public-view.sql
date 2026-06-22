-- restore-pregate-public-view.sql
--
-- Context
-- -------
-- PR #13 (cloudflare-migration, merged 2026-05-25) added a view-time gate in
-- worker/api/getChart.ts: the public /chart/{id} path now returns 403 for any
-- chart that HAS an owner (user_id IS NOT NULL) AND has
-- link_sharing_level = 'restricted'. Because 'restricted' is the column default
-- (see add-link-sharing.sql) and createChart never sets a level, every chart a
-- signed-in user created under the OLD public-by-default regime was
-- retroactively locked, breaking its /chart/{id} share link.
--
-- Fix
-- ---
-- Flip owned charts created before the gate's deploy (merge date 2026-05-25)
-- from the default 'restricted' to 'viewer' (public view; editing still
-- requires approval — only 'editor' grants public edit). This restores the
-- behavior those links had for months. The column DEFAULT stays 'restricted',
-- so new charts remain private-by-default as currently intended.
--
-- Notes
-- -----
-- * updated_at is intentionally preserved. There is no auto-update trigger on
--   charts in this database, so a plain UPDATE that sets only
--   link_sharing_level does NOT touch updated_at.
-- * Idempotent / re-run-safe: rows already at 'viewer' no longer match the
--   WHERE, and the date cutoffs are fixed historical timestamps.
-- * The updated_at < cutoff guard keeps the migration off charts whose content
--   was edited after the gate shipped (a conservative "leave live charts alone"
--   bound); all pre-merge charts already satisfy it.

UPDATE charts
SET link_sharing_level = 'viewer'
WHERE user_id IS NOT NULL
  AND (link_sharing_level = 'restricted' OR link_sharing_level IS NULL)
  AND created_at < '2026-05-25'
  AND updated_at < '2026-05-25';

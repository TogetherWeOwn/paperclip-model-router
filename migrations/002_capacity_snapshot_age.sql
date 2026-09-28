-- TOG-7885 (G8): make capacity-snapshot age observable. Adds the
-- company-scoped decision-field rollup behind the degraded-age alert:
-- `capacity_snapshot_age_ms` (wall-clock age of the snapshot the decision
-- served from, NULL when capacity routing is disabled or no snapshot was
-- ever stored) and `capacity_snapshot_stale` (true when that age exceeded
-- `capacityRouting.maxSnapshotAgeMs` at decision time). The existing
-- `model_router.company.<companyId>.capacity.snapshot_stale` metric series
-- is the live counter and these columns are its durable queryable rollup.
-- Backward compatible: both columns are nullable with a false default, so
-- rows written by older workers read as never-stored (NULL and false) and
-- never as fresh. NOTE: keep this header free of semicolons, the host
-- migration validator splits statements on them.
ALTER TABLE plugin_model_router_4dc1d582dd.decision_records
  ADD COLUMN capacity_snapshot_age_ms bigint,
  ADD COLUMN capacity_snapshot_stale boolean NOT NULL DEFAULT false;

CREATE INDEX decision_records_company_stale_recorded_at_idx
  ON plugin_model_router_4dc1d582dd.decision_records (company_id, capacity_snapshot_stale, recorded_at DESC);

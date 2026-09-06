CREATE TABLE plugin_model_router_4dc1d582dd.decision_records (
  id uuid PRIMARY KEY,
  company_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  request_id text NOT NULL,
  agent_id text,
  run_id text,
  issue_id text,
  task_class text,
  selection_outcome text,
  model_id text,
  fallback_used boolean NOT NULL,
  upstream_protocol text,
  outcome text NOT NULL,
  error_code text,
  upstream_status integer,
  latency_ms integer NOT NULL,
  input_tokens bigint,
  output_tokens bigint,
  stop_reason text,
  upstream_request_id text,
  capacity_mode text,
  capacity_telemetry text,
  capacity_lane text,
  capacity_lane_label text,
  capacity_posture text,
  capacity_reason text,
  capacity_degraded boolean NOT NULL,
  shadow_model_id text,
  CONSTRAINT decision_records_company_request_unique UNIQUE (company_id, request_id)
);

CREATE INDEX decision_records_company_recorded_at_idx
  ON plugin_model_router_4dc1d582dd.decision_records (company_id, recorded_at DESC);

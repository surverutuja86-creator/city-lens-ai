-- CityLens AI v3 — normalized PostgreSQL reference target model.
-- Production runtime migration is migrations/001_neon_runtime.sql; this file
-- documents the future fully-normalized model. The earth-distance index below
-- requires these standard PostgreSQL extensions.
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;


CREATE TYPE user_role  AS ENUM ('admin','operator','officer','field','reviewer','analyst');
CREATE TYPE inc_status AS ENUM ('DETECTED','UNDER_REVIEW','CONFIRMED','ASSIGNED','IN_PROGRESS',
  'REPAIR_SUBMITTED','AWAITING_VERIFICATION','VERIFIED','CLOSED','REOPENED','REJECTED');
CREATE TYPE tkt_status AS ENUM ('OPEN','ASSIGNED','ACKNOWLEDGED','WORK_STARTED','REPAIR_SUBMITTED',
  'AWAITING_VERIFICATION','RESOLVED','REOPENED','CLOSED');
CREATE TYPE sla_state  AS ENUM ('WITHIN_SLA','AT_RISK','BREACHED','RESOLVED_WITHIN_SLA','RESOLVED_AFTER_SLA');
CREATE TYPE tel_source AS ENUM ('browser','edge','trace_import','hardware');

CREATE TABLE users        (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role user_role NOT NULL, department TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE departments  (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE routes       (id TEXT PRIMARY KEY, route_code TEXT UNIQUE, route_name TEXT, start_point TEXT,
  end_point TEXT, distance_km NUMERIC, waypoints JSONB, importance TEXT);
CREATE TABLE buses        (id TEXT PRIMARY KEY, bus_code TEXT UNIQUE, registration_number TEXT,
  route_id TEXT REFERENCES routes, status TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  speed NUMERIC, heading NUMERIC, last_telemetry_at TIMESTAMPTZ, telemetry_source tel_source, active BOOL DEFAULT true);
CREATE TABLE devices      (id TEXT PRIMARY KEY, device_code TEXT UNIQUE, bus_id TEXT REFERENCES buses,
  kind TEXT, camera_status TEXT, gps_status TEXT, ai_unit_status TEXT, connection_status TEXT,
  last_heartbeat_at TIMESTAMPTZ, software_version TEXT, model_version TEXT, active BOOL DEFAULT true);

CREATE TABLE telemetry    (id TEXT PRIMARY KEY, event_uuid TEXT UNIQUE, bus_id TEXT, device_id TEXT,
  route_id TEXT, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
  speed NUMERIC, heading NUMERIC, accuracy_m NUMERIC, source tel_source NOT NULL,
  ts TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX telemetry_ts   ON telemetry (ts DESC);
CREATE INDEX telemetry_geo  ON telemetry USING gist (ll_to_earth(latitude, longitude)); -- or PostGIS point

CREATE TABLE ingest_events(id TEXT PRIMARY KEY, event_uuid TEXT UNIQUE NOT NULL,
  detection_id TEXT, telemetry_id TEXT, at TIMESTAMPTZ);           -- idempotency ledger

CREATE TABLE detections   (id TEXT PRIMARY KEY, event_uuid TEXT, source_type TEXT, source_id TEXT,
  device_id TEXT, bus_id TEXT, route_id TEXT, job_id TEXT,
  category TEXT NOT NULL, confidence NUMERIC NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  bounding_box JSONB, frame_number INT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  location_name TEXT, evidence_image TEXT, evidence_crop TEXT,
  model_name TEXT NOT NULL, model_version TEXT, inference_ms NUMERIC,
  privacy_status TEXT DEFAULT 'unavailable', validation_state TEXT DEFAULT 'UNREVIEWED',
  incident_id TEXT, ts TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX detections_incident ON detections (incident_id);

CREATE TABLE incidents    (id TEXT PRIMARY KEY, code TEXT UNIQUE, category TEXT NOT NULL,
  status inc_status NOT NULL, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, location_name TEXT,
  route_id TEXT, department TEXT, ticket_id TEXT,
  first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
  observation_count INT, unique_device_count INT, unique_bus_count INT,
  agg_confidence NUMERIC, max_confidence NUMERIC, agg_method TEXT,
  impact_score INT, impact_breakdown JSONB, repair_submitted_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
CREATE TABLE observations (id TEXT PRIMARY KEY, incident_id TEXT REFERENCES incidents,
  detection_id TEXT REFERENCES detections, device_id TEXT, bus_id TEXT, source_type TEXT,
  confidence NUMERIC, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  distance_from_incident_m INT, ts TIMESTAMPTZ);
CREATE TABLE incident_history (id TEXT PRIMARY KEY, incident_id TEXT, previous_status TEXT,
  new_status TEXT, changed_by TEXT, role TEXT, note TEXT, ticket_id TEXT, metadata JSONB, ts TIMESTAMPTZ);

CREATE TABLE tickets      (id TEXT PRIMARY KEY, code TEXT UNIQUE, incident_id TEXT, incident_code TEXT,
  category TEXT, department TEXT, priority TEXT, impact_score INT, status tkt_status,
  assigned_officer_id TEXT REFERENCES users, notes TEXT,
  sla_rule_id TEXT, sla_rule_name TEXT, sla_hours NUMERIC, due_at TIMESTAMPTZ,
  sla_status sla_state, escalation_level INT DEFAULT 0,
  work_started_at TIMESTAMPTZ, repair_submitted_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ,
  created_by TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
CREATE TABLE ticket_history (id TEXT PRIMARY KEY, ticket_id TEXT, previous_status TEXT, new_status TEXT,
  changed_by TEXT, role TEXT, note TEXT, metadata JSONB, ts TIMESTAMPTZ);
CREATE TABLE repair_evidence (id TEXT PRIMARY KEY, ticket_id TEXT, incident_id TEXT,
  kind TEXT CHECK (kind IN ('before','after')), file TEXT, note TEXT, uploaded_by TEXT,
  size_bytes BIGINT, ts TIMESTAMPTZ);
CREATE TABLE verifications (id TEXT PRIMARY KEY, incident_id TEXT, result TEXT CHECK (result IN ('CLEAR','REDETECTED')),
  device_id TEXT, bus_id TEXT, job_id TEXT, confidence NUMERIC, threshold NUMERIC,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, evidence_ref TEXT, ts TIMESTAMPTZ);

CREATE TABLE sla_rules    (id TEXT PRIMARY KEY, name TEXT, category TEXT, min_impact INT DEFAULT 0,
  hours NUMERIC NOT NULL, active BOOL DEFAULT true, created_at TIMESTAMPTZ);
CREATE TABLE escalations  (id TEXT PRIMARY KEY, ticket_id TEXT, incident_id TEXT, reason TEXT,
  previous_level TEXT, new_level TEXT, sla_status TEXT, ts TIMESTAMPTZ);
CREATE TABLE notifications(id TEXT PRIMARY KEY, kind TEXT, severity TEXT, title TEXT, message TEXT,
  entity_type TEXT, entity_id TEXT, for_role TEXT, for_user_id TEXT, department TEXT,
  is_read BOOL DEFAULT false, archived BOOL DEFAULT false, created_at TIMESTAMPTZ);
CREATE TABLE human_feedback (id TEXT PRIMARY KEY, detection_id TEXT, incident_id TEXT,
  decision TEXT, corrected_category TEXT, comment TEXT, reviewer TEXT, reviewer_id TEXT, ts TIMESTAMPTZ);
CREATE TABLE audit_logs   (id TEXT PRIMARY KEY, user_id TEXT, user_email TEXT, role TEXT, action TEXT,
  entity_type TEXT, entity_id TEXT, details TEXT, ip TEXT, ts TIMESTAMPTZ);
CREATE INDEX audit_action ON audit_logs (action, ts DESC);

CREATE TABLE safety_zones (id TEXT PRIMARY KEY, name TEXT, latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION, radius_m INT, zone_type TEXT, priority_weight INT,
  active BOOL DEFAULT true, source TEXT, created_at TIMESTAMPTZ);
CREATE TABLE road_segments(id TEXT PRIMARY KEY, route_id TEXT, route_code TEXT, road_name TEXT,
  a JSONB, b JSONB, length_m INT, importance TEXT);

CREATE TABLE ai_jobs      (id TEXT PRIMARY KEY, filename TEXT, stored_file TEXT, size_bytes BIGINT,
  kind TEXT, source_kind TEXT, engine TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  route_code TEXT, device_id TEXT, bus_id TEXT, scan_radius_m INT,
  status TEXT, error TEXT, results JSONB, frames_processed INT, avg_inference_ms NUMERIC,
  measured_fps NUMERIC, raw_bytes BIGINT, evidence_bytes BIGINT, requested_by TEXT,
  published BOOL, published_at TIMESTAMPTZ, published_counts JSONB,
  created_at TIMESTAMPTZ, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ);
CREATE TABLE ai_models    (id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, version TEXT, task TEXT,
  classes JSONB, status TEXT, runtime TEXT, methodology TEXT);
CREATE TABLE integrations (id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, description TEXT,
  status TEXT, enabled BOOL, config JSONB, last_test_at TIMESTAMPTZ, last_test_result JSONB);
CREATE TABLE settings     (id TEXT PRIMARY KEY, key TEXT UNIQUE, value JSONB, updated_at TIMESTAMPTZ);

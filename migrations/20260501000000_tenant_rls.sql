-- Tenant baseline schema + row-level security (issue #519).
-- Creates the base tables the app-level migrations depend on and enables
-- Row Level Security so every tenant only ever sees its own rows.
--
-- Tenancy model: each table carries a nullable `tenant_id`. Rows with a NULL
-- `tenant_id` are public/global (shared reference data). A non-NULL
-- `tenant_id` restricts reads/writes to the tenant whose id is supplied via
-- `current_setting('helphone.tenant_id')`. Superusers and the app role bypass
-- RLS entirely (allowed).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS requests (
    id           BIGSERIAL PRIMARY KEY,
    request_uid  UUID NOT NULL DEFAULT gen_random_uuid(),
    address      TEXT,
    geo_lat      DOUBLE PRECISION,
    geo_lng      DOUBLE PRECISION,
    urgency      TEXT,
    title        TEXT,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id    TEXT
);

CREATE TABLE IF NOT EXISTS responders (
    id          BIGSERIAL PRIMARY KEY,
    request_id  BIGINT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    wallet      TEXT,
    arrived     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id   TEXT
);

CREATE TABLE IF NOT EXISTS expert_verifications (
    id           BIGSERIAL PRIMARY KEY,
    request_id   BIGINT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    wallet       TEXT NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id    TEXT
);

CREATE TABLE IF NOT EXISTS contract_events (
    id           BIGSERIAL PRIMARY KEY,
    topic        TEXT NOT NULL,
    contract_id  TEXT,
    ledger       BIGINT,
    payload      JSONB,
    emitted_at   TIMESTAMPTZ,
    tenant_id    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on every tenant-scoped table.
ALTER TABLE requests            ENABLE ROW LEVEL SECURITY;
ALTER TABLE responders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE expert_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_events     ENABLE ROW LEVEL SECURITY;

-- Per-table isolation policy. Uses the tenant id from the session settings;
-- when unset, only public (tenant_id IS NULL) rows are visible.
CREATE POLICY tenant_isolation ON requests
    USING (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true))
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true));

CREATE POLICY tenant_isolation ON responders
    USING (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true))
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true));

CREATE POLICY tenant_isolation ON expert_verifications
    USING (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true))
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true));

CREATE POLICY tenant_isolation ON contract_events
    USING (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true))
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('helphone.tenant_id', true));
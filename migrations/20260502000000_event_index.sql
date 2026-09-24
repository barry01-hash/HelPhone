-- Index contract_events access paths (issue #519) so the Soroban indexer's
-- watcher/archival and state-replay stay fast as the table grows.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so
-- the migrator detects the CONCURRENTLY token and applies this file outside
-- a transaction (single session, one statement at a time). See
-- server/db/migrator.ts.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_topic_time
    ON contract_events (topic, emitted_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_tenant_time
    ON contract_events (tenant_id, emitted_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_ledger
    ON contract_events (ledger);
-- Event Index Migration
-- Creates the event_index table for off-chain Soroban event caching

CREATE TABLE IF NOT EXISTS event_index (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    contract_id VARCHAR(100) NOT NULL,
    ledger_seq BIGINT NOT NULL,
    tx_hash VARCHAR(100) NOT NULL,
    event_index INT NOT NULL,
    topics JSONB NOT NULL,
    data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_event_index_type ON event_index(event_type);
CREATE INDEX IF NOT EXISTS idx_event_index_contract ON event_index(contract_id);
CREATE INDEX IF NOT EXISTS idx_event_index_ledger ON event_index(ledger_seq);
CREATE INDEX IF NOT EXISTS idx_event_index_created ON event_index(created_at);
CREATE INDEX IF NOT EXISTS idx_event_index_tx ON event_index(tx_hash);

-- Composite index for paginated queries
CREATE INDEX IF NOT EXISTS idx_event_index_type_ledger ON event_index(event_type, ledger_seq DESC);

-- Cursor table for tracking indexer progress
CREATE TABLE IF NOT EXISTS indexer_cursor (
    id INT PRIMARY KEY DEFAULT 1,
    last_ledger BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO indexer_cursor (id, last_ledger) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

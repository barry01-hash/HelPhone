/**
 * Indexer Daemon
 *
 * Background service that polls Soroban RPC for contract events
 * and stores them in PostgreSQL for fast querying.
 */
import * as StellarSdk from '@stellar/stellar-sdk';

export interface IndexerConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  pollIntervalMs: number;
  dbPool: any; // PostgreSQL pool
}

export interface IndexedEvent {
  eventType: string;
  contractId: string;
  ledgerSeq: number;
  txHash: string;
  eventIndex: number;
  topics: any[];
  data: any;
}

/**
 * Parse XDR event topics into human-readable format.
 */
export function parseEventTopics(topics: any[]): string[] {
  return topics.map(topic => {
    if (typeof topic === 'string') return topic;
    if (topic?.toString) return topic.toString();
    return JSON.stringify(topic);
  });
}

/**
 * Decode event data from XDR.
 */
export function decodeEventData(data: any): any {
  if (!data) return null;
  if (typeof data === 'object' && data._switch) {
    // Soroban SCVal
    return data._value;
  }
  return data;
}

/**
 * Fetch events from Soroban RPC starting from a given ledger.
 */
export async function fetchEvents(
  server: StellarSdk.SorobanRpc.Server,
  contractId: string,
  fromLedger: number,
  limit: number = 100
): Promise<any[]> {
  try {
    const response = await server.getEvents({
      startLedger: fromLedger,
      filters: [{
        type: 'contract',
        contractIds: [contractId],
      }],
      limit,
      sortOrder: 'asc',
    });

    return response.events || [];
  } catch (error) {
    console.error('Failed to fetch events:', error);
    return [];
  }
}

/**
 * Store an indexed event in the database.
 */
export async function storeEvent(
  dbPool: any,
  event: IndexedEvent
): Promise<void> {
  const query = `
    INSERT INTO event_index (event_type, contract_id, ledger_seq, tx_hash, event_index, topics, data)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `;

  await dbPool.query(query, [
    event.eventType,
    event.contractId,
    event.ledgerSeq,
    event.txHash,
    event.eventIndex,
    JSON.stringify(event.topics),
    JSON.stringify(event.data),
  ]);
}

/**
 * Get the last indexed ledger from the cursor table.
 */
export async function getLastIndexedLedger(dbPool: any): Promise<number> {
  const result = await dbPool.query(
    'SELECT last_ledger FROM indexer_cursor WHERE id = 1'
  );
  return result.rows[0]?.last_ledger || 0;
}

/**
 * Update the indexer cursor to the latest processed ledger.
 */
export async function updateCursor(
  dbPool: any,
  ledger: number
): Promise<void> {
  await dbPool.query(
    'UPDATE indexer_cursor SET last_ledger = $1, updated_at = NOW() WHERE id = 1',
    [ledger]
  );
}

/**
 * Main indexer loop. Call this to start the daemon.
 */
export async function startIndexer(config: IndexerConfig): Promise<void> {
  const server = new StellarSdk.SorobanRpc.Server(config.rpcUrl);
  const { dbPool, contractId, pollIntervalMs } = config;

  console.log(`[Indexer] Starting indexer daemon for contract ${contractId}`);

  while (true) {
    try {
      const lastLedger = await getLastIndexedLedger(dbPool);
      const events = await fetchEvents(server, contractId, lastLedger + 1);

      if (events.length > 0) {
        console.log(`[Indexer] Processing ${events.length} events from ledger ${lastLedger + 1}`);

        for (const event of events) {
          const indexedEvent: IndexedEvent = {
            eventType: parseEventTopics(event.topics)[0] || 'unknown',
            contractId: event.contractId,
            ledgerSeq: event.ledgerSequence,
            txHash: event.transactionHash,
            eventIndex: event.eventIndex,
            topics: parseEventTopics(event.topics),
            data: decodeEventData(event.data),
          };

          await storeEvent(dbPool, indexedEvent);
        }

        const lastEventLedger = events[events.length - 1].ledgerSequence;
        await updateCursor(dbPool, lastEventLedger);
        console.log(`[Indexer] Cursor updated to ledger ${lastEventLedger}`);
      }
    } catch (error) {
      console.error('[Indexer] Error in indexer loop:', error);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

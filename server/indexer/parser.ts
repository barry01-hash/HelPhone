/**
 * Event Parser
 *
 * Decodes XDR event topics and data into structured records
 * for storage in the PostgreSQL event_index table.
 */

/** Parsed event types from the HelPhone contract */
export type EventType = 'created' | 'accepted' | 'arrived' | 'resolved' | 'unknown';

/** Structured event record after parsing */
export interface ParsedEvent {
  eventType: EventType;
  requestId?: string;
  responderAddress?: string;
  callerAddress?: string;
  timestamp?: number;
  latitude?: number;
  longitude?: number;
  raw: {
    topics: string[];
    data: any;
  };
}

/**
 * Map contract event topic to a typed event name.
 */
export function classifyEvent(topics: string[]): EventType {
  const topic = topics[0]?.toLowerCase() || '';

  if (topic.includes('request_created') || topic.includes('emergency_created')) {
    return 'created';
  }
  if (topic.includes('request_accepted') || topic.includes('responder_joined')) {
    return 'accepted';
  }
  if (topic.includes('responder_arrived') || topic.includes('on_scene')) {
    return 'arrived';
  }
  if (topic.includes('request_resolved') || topic.includes('emergency_resolved')) {
    return 'resolved';
  }

  return 'unknown';
}

/**
 * Parse event data into a structured record.
 */
export function parseEvent(topics: string[], data: any): ParsedEvent {
  const eventType = classifyEvent(topics);

  const parsed: ParsedEvent = {
    eventType,
    raw: { topics, data },
  };

  // Extract common fields from topics (indices depend on contract design)
  if (topics.length > 1) parsed.requestId = topics[1];
  if (topics.length > 2) parsed.responderAddress = topics[2];
  if (topics.length > 3) parsed.callerAddress = topics[3];

  // Extract fields from data object
  if (data && typeof data === 'object') {
    if (data.timestamp) parsed.timestamp = Number(data.timestamp);
    if (data.latitude) parsed.latitude = Number(data.latitude);
    if (data.longitude) parsed.longitude = Number(data.longitude);
  }

  return parsed;
}

/**
 * Batch parse multiple events.
 */
export function parseEvents(
  events: Array<{ topics: string[]; data: any }>
): ParsedEvent[] {
  return events.map(e => parseEvent(e.topics, e.data));
}

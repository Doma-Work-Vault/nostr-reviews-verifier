import type { Event } from 'nostr-tools';
import { structuredLogger } from './logger';
import { KIND_CONTRACT_STATUS } from './v1-legacy-nostr-status';

export interface NostrQueryPool {
	querySync(relays: string[], filter: Record<string, unknown>): Promise<Event[]>;
}

/**
 * Fetch Kind 31006 status events for a payment contract (by Kind 30006 event id).
 */
export async function fetchContractStatusEvents(
	pool: NostrQueryPool,
	relays: string[],
	contractEventId: string
): Promise<Event[]> {
	const trimmed = contractEventId.trim();
	if (!trimmed || relays.length === 0) {
		return [];
	}

	try {
		return await pool.querySync(relays, {
			kinds: [KIND_CONTRACT_STATUS],
			'#e': [trimmed],
			limit: 100
		});
	} catch (error) {
		structuredLogger.warn('Failed to query Kind 31006 for v1 effective status', {
			contractEventId: trimmed,
			error: error instanceof Error ? error.message : 'unknown'
		});
		return [];
	}
}

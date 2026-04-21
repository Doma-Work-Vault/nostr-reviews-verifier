import { SimplePool, type Event } from 'nostr-tools';

export interface ReviewNostrPublisher {
	publish(event: Event): Promise<void>;
}

export class RelayReviewNostrPublisher implements ReviewNostrPublisher {
	private readonly pool: SimplePool;

	constructor(
		private readonly relays: string[],
		private readonly timeoutMs: number
	) {
		this.pool = new SimplePool({
			enableReconnect: false,
			enablePing: false
		});
	}

	async publish(event: Event): Promise<void> {
		if (this.relays.length === 0) {
			throw new Error('publisher_unavailable');
		}

		try {
			const attempts = this.pool.publish(this.relays, event, {
				maxWait: this.timeoutMs
			});
			await Promise.any(attempts);
		} catch {
			throw new Error('attestation_publish_failed');
		}
	}

	destroy(): void {
		this.pool.destroy();
	}
}

export class MockReviewNostrPublisher implements ReviewNostrPublisher {
	public readonly publishedEvents: Event[] = [];

	constructor(private readonly shouldFail = false) {}

	async publish(event: Event): Promise<void> {
		if (this.shouldFail) {
			throw new Error('attestation_publish_failed');
		}

		this.publishedEvents.push(event);
	}
}

export function parseNostrRelaysFromEnv(json?: string): string[] {
	if (!json || !json.trim()) {
		return [];
	}

	const parsed = JSON.parse(json) as unknown;
	if (!Array.isArray(parsed) || parsed.some((relay) => typeof relay !== 'string' || !relay.trim())) {
		throw new Error('Invalid review attestation relay registry');
	}

	return parsed.map((relay) => relay.trim());
}

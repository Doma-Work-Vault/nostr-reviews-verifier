import { describe, it, expect } from 'vitest';
import { CloudflareReviewStateClient, InMemoryReviewStateClient } from '../src/state';

describe('CloudflareReviewStateClient circuit breaker', () => {
	function createMockNamespace(innerState: InMemoryReviewStateClient) {
		const stateClient = new CloudflareReviewStateClient({
			idFromName: () => ({ toString: () => 'mock-do-id' } as DurableObjectId),
			get: (): DurableObjectStub => ({
				fetch: async (_url: string | Request, _init?: RequestInit) => {
					// Simulate the DO processing the request internally
					const url = new URL(typeof _url === 'string' ? _url : (_url as Request).url);
					const body = JSON.parse(
						typeof _init?.body === 'string' ? _init.body : '{}'
					) as Record<string, unknown>;

					if (url.pathname === '/ratelimit/check') {
						const result = await innerState.checkRateLimit(
							body.bucketKey as string,
							body.limit as number,
							body.windowSeconds as number,
							body.now as number
						);
						return new Response(JSON.stringify(result), { status: 200 });
					}
					if (url.pathname === '/slots/get') {
						const result = await innerState.getIssuedSlot(body.slotHash as string);
						return new Response(JSON.stringify(result), { status: 200 });
					}
					if (url.pathname === '/slots/claim') {
						const result = await innerState.claimIssuedSlot(body as any);
						return new Response(JSON.stringify(result), { status: 200 });
					}
					return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
				}
			} as unknown as DurableObjectStub)
		});
		return stateClient;
	}

	it('starts with circuit breaker closed', () => {
		const innerState = new InMemoryReviewStateClient();
		const client = createMockNamespace(innerState);
		expect(client.circuitBreakerOpen).toBe(false);
	});

	it('allows requests when circuit breaker is closed', async () => {
		const innerState = new InMemoryReviewStateClient();
		const client = createMockNamespace(innerState);

		const result = await client.checkRateLimit('test:ip:abc', 10, 600, Date.now());
		expect(result.allowed).toBe(true);
	});

	it('can be manually reset', () => {
		const innerState = new InMemoryReviewStateClient();
		const client = createMockNamespace(innerState);

		client.resetCircuitBreaker();
		expect(client.circuitBreakerOpen).toBe(false);
	});
});

describe('InMemoryReviewStateClient', () => {
	it('rate limits correctly', async () => {
		const client = new InMemoryReviewStateClient();
		const now = Date.now();

		const first = await client.checkRateLimit('test-key', 2, 600, now);
		expect(first.allowed).toBe(true);

		const second = await client.checkRateLimit('test-key', 2, 600, now);
		expect(second.allowed).toBe(true);

		const third = await client.checkRateLimit('test-key', 2, 600, now);
		expect(third.allowed).toBe(false);
	});

	it('claims slots atomically', async () => {
		const client = new InMemoryReviewStateClient();
		const record = {
			slotHash: 'a'.repeat(64),
			reviewDraftHash: 'b'.repeat(64),
			reviewEventId: 'c'.repeat(64),
			attestationEventId: 'd'.repeat(64),
			issuedAt: Date.now()
		};

		const first = await client.claimIssuedSlot(record);
		expect(first.created).toBe(true);

		const second = await client.claimIssuedSlot(record);
		expect(second.created).toBe(false);
		expect(second.existing).not.toBeNull();
	});
});

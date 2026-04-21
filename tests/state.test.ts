import { describe, expect, it, vi } from 'vitest';
import { InMemoryReviewStateClient, CloudflareReviewStateClient, type ReviewStateNamespace } from '../src/state';

describe('InMemoryReviewStateClient unit tests', () => {
	it('enforces rate limits', async () => {
		const client = new InMemoryReviewStateClient();
		const bucket = 'user-1';
		const limit = 2;
		const windowSeconds = 60;
		const now = 1000000;

		// First request allowed
		const res1 = await client.checkRateLimit(bucket, limit, windowSeconds, now);
		expect(res1.allowed).toBe(true);

		// Second request allowed
		const res2 = await client.checkRateLimit(bucket, limit, windowSeconds, now + 1000);
		expect(res2.allowed).toBe(true);

		// Third request blocked
		const res3 = await client.checkRateLimit(bucket, limit, windowSeconds, now + 2000);
		expect(res3.allowed).toBe(false);
		expect(res3.retryAfterSeconds).toBeGreaterThan(0);
	});

	it('prunes expired rate limits', async () => {
		const client = new InMemoryReviewStateClient();
		const bucket = 'user-prune';
		const limit = 1;
		const windowSeconds = 1;
		const now = 1000;

		// First request
		await client.checkRateLimit(bucket, limit, windowSeconds, now);
		
		// Wait for expiry
		const nextNow = now + 2000; // 2 seconds later
		const res2 = await client.checkRateLimit(bucket, limit, windowSeconds, nextNow);
		expect(res2.allowed).toBe(true);
		
		// Verify internal state pruning (indirectly)
		// We can't easily check private state but we can check if it resets correctly
		const res3 = await client.checkRateLimit(bucket, limit, windowSeconds, nextNow);
		expect(res3.allowed).toBe(false); // Second request in new window should be blocked
	});

	it('handles multiple buckets independently', async () => {
		const client = new InMemoryReviewStateClient();
		const limit = 1;
		const window = 60;
		const now = 10000;

		await client.checkRateLimit('a', limit, window, now);
		expect((await client.checkRateLimit('a', limit, window, now)).allowed).toBe(false);
		expect((await client.checkRateLimit('b', limit, window, now)).allowed).toBe(true);
	});

	it('claims and retrieves issued slots', async () => {
		const client = new InMemoryReviewStateClient();
		const record = {
			slotHash: 'a'.repeat(64),
			reviewDraftHash: 'hash-1',
			reviewEventId: 're-1',
			attestationEventId: 'ae-1',
			issuedAt: 12345
		};

		const claim1 = await client.claimIssuedSlot(record);
		expect(claim1.created).toBe(true);
		expect(claim1.existing).toBeNull();

		const retrieved = await client.getIssuedSlot(record.slotHash);
		expect(retrieved).toMatchObject(record);

		const claim2 = await client.claimIssuedSlot({ ...record, reviewEventId: 'different' });
		expect(claim2.created).toBe(false);
		expect(claim2.existing).toMatchObject(record);
	});
});

describe('CloudflareReviewStateClient unit tests', () => {
	const createMockNamespace = (mockFetch: any): ReviewStateNamespace => ({
		idFromName: (name: string) => name as any,
		get: (id: any) => ({
			fetch: mockFetch
		}) as any
	});

	it('delegates checkRateLimit to Durable Object', async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			allowed: true,
			retryAfterSeconds: 10
		})));
		const client = new CloudflareReviewStateClient(createMockNamespace(mockFetch));
		
		const result = await client.checkRateLimit('key', 5, 60, 1000);
		
		expect(result).toEqual({ allowed: true, retryAfterSeconds: 10 });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining('/ratelimit/check'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ bucketKey: 'key', limit: 5, windowSeconds: 60, now: 1000 })
			})
		);
	});

	it('delegates getIssuedSlot to Durable Object', async () => {
		const record = {
			slotHash: 'a'.repeat(64),
			reviewDraftHash: 'h',
			reviewEventId: 're',
			attestationEventId: 'ae',
			issuedAt: 123
		};
		const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(record)));
		const client = new CloudflareReviewStateClient(createMockNamespace(mockFetch));
		
		const result = await client.getIssuedSlot(record.slotHash);
		expect(result).toEqual(record);
	});

	it('delegates claimIssuedSlot to Durable Object', async () => {
		const record = {
			slotHash: 'a'.repeat(64),
			reviewDraftHash: 'h',
			reviewEventId: 're',
			attestationEventId: 'ae',
			issuedAt: 123
		};
		const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			created: true,
			existing: null
		})));
		const client = new CloudflareReviewStateClient(createMockNamespace(mockFetch));
		
		const result = await client.claimIssuedSlot(record);
		expect(result.created).toBe(true);
	});

	it('throws error when Durable Object fetch fails', async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response('Error', { status: 500 }));
		const client = new CloudflareReviewStateClient(createMockNamespace(mockFetch));
		
		await expect(client.getIssuedSlot('a'.repeat(64))).rejects.toThrow('Review state request failed: 500');
	});
});

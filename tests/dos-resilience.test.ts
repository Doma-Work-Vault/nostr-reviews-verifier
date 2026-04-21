import { describe, expect, it } from 'vitest';
import { createReviewsAttestationApp } from '../src/app';
import { createInMemoryReviewStateClient, type ReviewStateNamespace } from '../src/state';

function createNamespace(state = createInMemoryReviewStateClient()): ReviewStateNamespace {
	return {
		idFromName(name: string) {
			return name as unknown as DurableObjectId;
		},
		get() {
			return {
				async fetch(input: RequestInfo | URL, init?: RequestInit) {
					const url = new URL(
						typeof input === 'string' || input instanceof URL ? String(input) : input.url
					);
					const body = init?.body ? JSON.parse(String(init.body)) : {};
					switch (url.pathname) {
						case '/ratelimit/check':
							return new Response(JSON.stringify(await state.checkRateLimit(body.bucketKey, body.limit, body.windowSeconds, body.now)));
						default:
							return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
					}
				}
			} as DurableObjectStub;
		}
	};
}

describe('DoS and Payload Resilience', () => {
	it('rejects malformed JSON payloads gracefully', async () => {
		const app = createReviewsAttestationApp();
		const env = { REVIEW_STATE: createNamespace() } as any;

		const response = await app.request(
			'/review-attestations/challenge',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{ "invalid": json '
			},
			env
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toMatchObject({ code: 'request_invalid' });
	});

	it('rejects oversized bucket keys in rate limits', async () => {
		const app = createReviewsAttestationApp();
		const env = { REVIEW_STATE: createNamespace() } as any;

		const response = await app.request(
			'/review-attestations/challenge',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					subjectType: 'task',
					subjectId: 'a'.repeat(10000), // Very large ID
					reviewDraftHash: 'a'.repeat(64),
                    settlementType: 'escrow',
                    settlementId: 's1',
                    chain: 'rsk',
                    asset: 'rbtc',
                    contractAddress: '0x123',
                    reviewerNpub: 'n1',
                    revieweeNpub: 'n2',
                    reviewerWallet: 'w1',
                    revieweeWallet: 'w2'
				})
			},
			env
		);

		// Should fail validation (Zod schema should have limits)
		expect(response.status).toBe(400);
	});

	it('rejects payloads exceeding the 1MB body limit', async () => {
		const app = createReviewsAttestationApp();
		const env = { REVIEW_STATE: createNamespace() } as any;

		// Create a large dummy string (~1.1 MB)
		const largeString = 'a'.repeat(1024 * 1024 + 100);

		const response = await app.request(
			'/review-attestations/challenge',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					subjectType: 'task',
					subjectId: 't1',
					reviewDraftHash: 'a'.repeat(64),
					settlementType: 'escrow',
					settlementId: 's1',
					chain: 'rsk',
					asset: 'rbtc',
					contractAddress: '0x123',
					reviewerNpub: 'n1',
					revieweeNpub: 'n2',
					reviewerWallet: 'w1',
					revieweeWallet: 'w2',
					data: largeString
				})
			},
			env
		);

		expect(response.status).toBe(413);
		const body = await response.json();
		expect(body).toMatchObject({ code: 'request_invalid', message: 'Payload too large' });
	});
});

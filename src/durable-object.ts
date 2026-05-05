import type { ReviewIssuedSlotRecord, ReviewIssuedReplySlotRecord } from './state';
import { z } from 'zod';

interface RateLimitRecord {
	count: number;
	windowStart: number;
	expiresAt: number;
}

interface RateLimitExpiryRecord {
	bucketKey: string;
	expiresAt: number;
}

const RATE_LIMIT_BUCKET_PREFIX = 'ratelimit:';
const RATE_LIMIT_EXPIRY_PREFIX = 'ratelimit-expiry:';
const RATE_LIMIT_PRUNE_BATCH_SIZE = 32;

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json'
		}
	});
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

const slotHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const rateLimitRequestSchema = z
	.object({
		bucketKey: z.string().min(1).max(256),
		limit: z.number().int().positive(),
		windowSeconds: z.number().int().positive(),
		now: z.number().int().nonnegative()
	})
	.strict();
const slotGetRequestSchema = z
	.object({
		slotHash: slotHashSchema
	})
	.strict();
const slotClaimRequestSchema = z
	.object({
		slotHash: slotHashSchema,
		reviewDraftHash: z.string().min(1),
		reviewEventId: z.string().min(1),
		attestationEventId: z.string().min(1),
		issuedAt: z.number().int().nonnegative()
	})
	.strict();

function getRateLimitBucketStorageKey(bucketKey: string): string {
	return `${RATE_LIMIT_BUCKET_PREFIX}${bucketKey}`;
}

function getRateLimitExpiryStorageKey(expiresAt: number, bucketKey: string): string {
	return `${RATE_LIMIT_EXPIRY_PREFIX}${String(expiresAt).padStart(16, '0')}:${bucketKey}`;
}

export class ReviewStateDO {
	constructor(private readonly state: DurableObjectState, private readonly env: unknown) { }

	private async pruneExpiredRateLimits(now: number): Promise<void> {
		const entries = await this.state.storage.list<RateLimitExpiryRecord>({
			prefix: RATE_LIMIT_EXPIRY_PREFIX,
			limit: RATE_LIMIT_PRUNE_BATCH_SIZE
		});
		for (const [key, value] of entries.entries()) {
			if (typeof value?.expiresAt !== 'number' || typeof value?.bucketKey !== 'string') {
				await this.state.storage.delete(key);
				continue;
			}
			if (value.expiresAt > now) {
				break;
			}

			const bucketStorageKey = getRateLimitBucketStorageKey(value.bucketKey);
			const bucketRecord = await this.state.storage.get<RateLimitRecord>(bucketStorageKey);
			if (bucketRecord && bucketRecord.expiresAt === value.expiresAt) {
				await this.state.storage.delete(bucketStorageKey);
			}
			await this.state.storage.delete(key);
		}
	}

	private async getIssuedSlot(slotHash: string): Promise<ReviewIssuedSlotRecord | null> {
		return (await this.state.storage.get<ReviewIssuedSlotRecord>(`issued:${slotHash}`)) ?? null;
	}

	private async claimIssuedSlot(record: ReviewIssuedSlotRecord): Promise<{
		created: boolean;
		existing: ReviewIssuedSlotRecord | null;
	}> {
		return this.state.storage.transaction(async () => {
			const existing = await this.getIssuedSlot(record.slotHash);
			if (existing) {
				return {
					created: false,
					existing: clone(existing)
				};
			}

			await this.state.storage.put(`issued:${record.slotHash}`, record);
			return {
				created: true,
				existing: null
			};
		});
	}


	private async getIssuedReplySlot(parentReviewEventId: string): Promise<ReviewIssuedReplySlotRecord | null> {
		return (await this.state.storage.get<ReviewIssuedReplySlotRecord>(`reply:${parentReviewEventId}`)) ?? null;
	}

	private async claimIssuedReplySlot(record: ReviewIssuedReplySlotRecord): Promise<{
		created: boolean;
		existing: ReviewIssuedReplySlotRecord | null;
	}> {
		return this.state.storage.transaction(async () => {
			const existing = await this.getIssuedReplySlot(record.parentReviewEventId);
			if (existing) {
				return { created: false, existing: clone(existing) };
			}
			await this.state.storage.put(`reply:${record.parentReviewEventId}`, record);
			return { created: true, existing: null };
		});
	}
	
	private async checkRateLimit(
		bucketKey: string,
		limit: number,
		windowSeconds: number,
		now: number
	): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
		const windowMs = windowSeconds * 1000;
		const key = getRateLimitBucketStorageKey(bucketKey);
		return this.state.storage.transaction(async () => {
			await this.pruneExpiredRateLimits(now);
			const existing = await this.state.storage.get<RateLimitRecord>(key);
			if (!existing || now >= existing.expiresAt || now - existing.windowStart >= windowMs) {
				const created: RateLimitRecord = {
					count: 1,
					windowStart: now,
					expiresAt: now + windowMs
				};
				await this.state.storage.put(key, created);
				await this.state.storage.put(
					getRateLimitExpiryStorageKey(created.expiresAt, bucketKey),
					{ bucketKey, expiresAt: created.expiresAt } satisfies RateLimitExpiryRecord
				);
				return { allowed: true, retryAfterSeconds: windowSeconds };
			}

			const next: RateLimitRecord = {
				count: existing.count + 1,
				windowStart: existing.windowStart,
				expiresAt: existing.expiresAt
			};
			await this.state.storage.put(key, next);
			if (next.count > limit) {
				const elapsed = now - existing.windowStart;
				return {
					allowed: false,
					retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000))
				};
			}

			return { allowed: true, retryAfterSeconds: windowSeconds };
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			const issuedSlots = await this.state.storage.list({ prefix: 'issued:' });
			return jsonResponse({
				status: 'ok',
				issuedSlotsCount: [...issuedSlots.entries()].length,
				timestamp: Date.now()
			});
		}

		if (request.method !== 'POST') {
			return jsonResponse({ error: 'method_not_allowed' }, 405);
		}

		const body = (await request.json()) as Record<string, unknown>;

		if (url.pathname === '/ratelimit/check') {
			const input = rateLimitRequestSchema.parse(body);
			const result = await this.checkRateLimit(
				input.bucketKey,
				input.limit,
				input.windowSeconds,
				input.now
			);
			return jsonResponse(result);
		}

		if (url.pathname === '/slots/get') {
			const input = slotGetRequestSchema.parse(body);
			const slot = await this.getIssuedSlot(input.slotHash);
			return jsonResponse(slot ? clone(slot) : null);
		}

		if (url.pathname === '/slots/claim') {
			const record = slotClaimRequestSchema.parse(body) as ReviewIssuedSlotRecord;
			return jsonResponse(await this.claimIssuedSlot(record));
		}

		if (url.pathname === '/reply-slots/get') {
			const input = z.object({ parentReviewEventId: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().parse(body);
			const slot = await this.getIssuedReplySlot(input.parentReviewEventId);
			return jsonResponse(slot ? clone(slot) : null);
		}

		if (url.pathname === '/reply-slots/claim') {
			const input = z.object({
				parentReviewEventId: z.string().regex(/^[a-f0-9]{64}$/i),
				replyDraftHash: z.string().min(1),
				replyEventId: z.string().min(1),
				attestationEventId: z.string().min(1),
				issuedAt: z.number().int().nonnegative()
			}).strict().parse(body) as ReviewIssuedReplySlotRecord;
			return jsonResponse(await this.claimIssuedReplySlot(input));
		}

		return jsonResponse({ error: 'not_found' }, 404);
	}
}

export type ReviewStateDOClass = typeof ReviewStateDO;

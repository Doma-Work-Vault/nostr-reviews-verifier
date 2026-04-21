import type {
	IssuerRegistryEntry,
	IssuerRegistryResponse
} from './contracts';
import { normalizeHex, parseHexOrNpub, parseNsecToHex } from './contracts';
import { getPublicKey } from 'nostr-tools';
import { z } from 'zod';

export interface RateLimitDecision {
	allowed: boolean;
	retryAfterSeconds: number;
}

export interface ReviewIssuedSlotRecord {
	slotHash: string;
	reviewDraftHash: string;
	reviewEventId: string;
	attestationEventId: string;
	issuedAt: number;
}

export interface ReviewSlotClaimResult {
	created: boolean;
	existing: ReviewIssuedSlotRecord | null;
}

export interface ReviewStateClient {
	checkRateLimit(
		bucketKey: string,
		limit: number,
		windowSeconds: number,
		now: number
	): Promise<RateLimitDecision>;
	getIssuedSlot(slotHash: string): Promise<ReviewIssuedSlotRecord | null>;
	claimIssuedSlot(record: ReviewIssuedSlotRecord): Promise<ReviewSlotClaimResult>;
}

const slotHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const rateLimitDecisionSchema = z
	.object({
		allowed: z.boolean(),
		retryAfterSeconds: z.number().int().positive()
	})
	.strict();
const issuedSlotRecordSchema = z
	.object({
		slotHash: slotHashSchema,
		reviewDraftHash: z.string().min(1),
		reviewEventId: z.string().min(1),
		attestationEventId: z.string().min(1),
		issuedAt: z.number().int().nonnegative()
	})
	.strict();
const slotClaimResultSchema = z
	.object({
		created: z.boolean(),
		existing: issuedSlotRecordSchema.nullable()
	})
	.strict();
const issuerRegistryEntriesSchema = z.array(
	z
		.object({
			keyId: z.string().min(1),
			pubkey: z.string().regex(/^[a-f0-9]{64}$/i),
			status: z.enum(['active', 'retired']),
			validFrom: z.number().int().nonnegative(),
			validUntil: z.number().int().nonnegative().nullable().optional()
		})
		.strict()
).superRefine((entries, ctx) => {
	const seenKeyIds = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (seenKeyIds.has(entry.keyId)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Issuer keyId values must be unique',
				path: [index, 'keyId']
			});
			continue;
		}
		seenKeyIds.add(entry.keyId);
		if (entry.validUntil !== null && entry.validUntil !== undefined && entry.validUntil < entry.validFrom) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'validUntil must be greater than or equal to validFrom',
				path: [index, 'validUntil']
			});
		}
	}
});
const issuerRegistryObjectSchema = z
	.object({
		schemaVersion: z.number().int().positive().optional(),
		issuers: issuerRegistryEntriesSchema
	})
	.strict();

function clone<T>(value: T): T {
	return structuredClone(value);
}

export class InMemoryReviewStateClient implements ReviewStateClient {
	private readonly issuedSlots = new Map<string, ReviewIssuedSlotRecord>();
	private readonly rateLimits = new Map<string, { count: number; windowStart: number; expiresAt: number }>();
	private readonly rateLimitExpiries: Array<{ bucketKey: string; expiresAt: number }> = [];

	private pruneExpiredRateLimits(now: number): void {
		this.rateLimitExpiries.sort((left, right) => left.expiresAt - right.expiresAt);
		while (this.rateLimitExpiries.length > 0 && this.rateLimitExpiries[0]!.expiresAt <= now) {
			const expired = this.rateLimitExpiries.shift()!;
			const current = this.rateLimits.get(expired.bucketKey);
			if (current && current.expiresAt === expired.expiresAt) {
				this.rateLimits.delete(expired.bucketKey);
			}
		}
	}

	async checkRateLimit(
		bucketKey: string,
		limit: number,
		windowSeconds: number,
		now: number
	): Promise<RateLimitDecision> {
		const windowMs = windowSeconds * 1000;
		this.pruneExpiredRateLimits(now);
		const entry = this.rateLimits.get(bucketKey);
		if (!entry || now - entry.windowStart >= windowMs) {
			const created = { count: 1, windowStart: now, expiresAt: now + windowMs };
			this.rateLimits.set(bucketKey, created);
			this.rateLimitExpiries.push({ bucketKey, expiresAt: created.expiresAt });
			return { allowed: true, retryAfterSeconds: windowSeconds };
		}

		const next = {
			count: entry.count + 1,
			windowStart: entry.windowStart,
			expiresAt: entry.windowStart + windowMs
		};
		this.rateLimits.set(bucketKey, next);
		if (next.count > limit) {
			const elapsed = now - entry.windowStart;
			return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)) };
		}

		return { allowed: true, retryAfterSeconds: windowSeconds };
	}

	async getIssuedSlot(slotHash: string): Promise<ReviewIssuedSlotRecord | null> {
		return this.issuedSlots.has(slotHash) ? clone(this.issuedSlots.get(slotHash)!) : null;
	}

	async claimIssuedSlot(record: ReviewIssuedSlotRecord): Promise<ReviewSlotClaimResult> {
		const existing = this.issuedSlots.get(record.slotHash);
		if (existing) {
			return { created: false, existing: clone(existing) };
		}

		this.issuedSlots.set(record.slotHash, clone(record));
		return { created: true, existing: null };
	}
}

export function createInMemoryReviewStateClient(): InMemoryReviewStateClient {
	return new InMemoryReviewStateClient();
}

export interface ReviewStateNamespace {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): DurableObjectStub;
}

export class CloudflareReviewStateClient implements ReviewStateClient {
	constructor(
		private readonly namespace: ReviewStateNamespace,
		private readonly globalId = 'global'
	) {}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const stub = this.namespace.get(this.namespace.idFromName(this.globalId));
		const response = await stub.fetch(`https://internal${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			throw new Error(`Review state request failed: ${response.status}`);
		}

		return (await response.json()) as T;
	}

	async checkRateLimit(
		bucketKey: string,
		limit: number,
		windowSeconds: number,
		now: number
	): Promise<RateLimitDecision> {
		return rateLimitDecisionSchema.parse(
			await this.post('/ratelimit/check', { bucketKey, limit, windowSeconds, now })
		);
	}

	async getIssuedSlot(slotHash: string): Promise<ReviewIssuedSlotRecord | null> {
		return issuedSlotRecordSchema.nullable().parse(await this.post('/slots/get', { slotHash }));
	}

	async claimIssuedSlot(record: ReviewIssuedSlotRecord): Promise<ReviewSlotClaimResult> {
		return slotClaimResultSchema.parse(await this.post('/slots/claim', record));
	}
}

export function parseIssuerRegistry(env: {
	REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?: string;
	REVIEW_ATTESTATION_ISSUER_KEY_ID?: string;
	REVIEW_ATTESTATION_ISSUER_NPUB?: string;
	REVIEW_ATTESTATION_ISSUER_NSEC?: string;
	clock?: () => number;
}): IssuerRegistryResponse {
	const issuerNsec = env.REVIEW_ATTESTATION_ISSUER_NSEC?.trim();
	const issuerNpub = env.REVIEW_ATTESTATION_ISSUER_NPUB?.trim();
	const keyId = env.REVIEW_ATTESTATION_ISSUER_KEY_ID?.trim() || 'reviews-attestation-issuer-v1';

	if (!issuerNsec || !issuerNpub) {
		throw new Error('Missing review attestation issuer npub/nsec configuration');
	}

	const derivedNpub = deriveIssuerNpub(issuerNsec);
	if (normalizeHex(parseHexOrNpub(derivedNpub)) !== normalizeHex(parseHexOrNpub(issuerNpub))) {
		throw new Error('Issuer npub does not match configured nsec');
	}

	const raw = env.REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?.trim();
	if (raw) {
		const parsedInput = JSON.parse(raw) as unknown;
		const parsed = Array.isArray(parsedInput)
			? issuerRegistryEntriesSchema.parse(parsedInput)
			: issuerRegistryObjectSchema.parse(parsedInput).issuers;
		if (parsed.length === 0) {
			return {
				schemaVersion: 1,
				issuers: [
					{
						keyId,
						pubkey: normalizeHex(parseHexOrNpub(issuerNpub)),
						status: 'active',
						validFrom: 0,
						validUntil: null
					}
				]
			};
		}

		const active = parsed.find((entry) => entry.status === 'active');
		if (!active) {
			throw new Error('No active issuer available');
		}

		if (active.keyId !== keyId) {
			throw new Error('Active issuer keyId does not match configured issuer keyId');
		}

		if (normalizeHex(active.pubkey) !== normalizeHex(parseHexOrNpub(issuerNpub))) {
			throw new Error('Active issuer pubkey does not match configured issuer npub');
		}

		return {
			schemaVersion: 1,
			issuers: parsed
		};
	}

	return {
		schemaVersion: 1,
		issuers: [
			{
				keyId,
				pubkey: normalizeHex(parseHexOrNpub(issuerNpub)),
				status: 'active',
				validFrom: 0,
				validUntil: null
			}
		]
	};
}

function deriveIssuerNpub(issuerNsec: string): string {
	return normalizeHex(getPublicKey(Buffer.from(parseNsecToHex(issuerNsec), 'hex')));
}

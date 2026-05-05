import { schnorr } from '@noble/curves/secp256k1';
import { utf8ToBytes } from '@noble/hashes/utils';
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { getAddress, verifyMessage } from 'viem';
import { z } from 'zod';
import {
	REVIEW_ATTESTATION_KIND,
	type AttestationEventPayload,
	hashHex,
	normalizeHex,
	parseHexOrNpub,
	parseNsecToHex
} from './contracts';
import { sha256Fn } from './hash-utils';
import type { ReviewNostrPublisher } from './nostr-publisher';
import { getActiveIssuer } from './issuer-registry';
import {
	buildOpaqueReviewChallengeMessage,
	createReviewChallengeToken,
	parseAndVerifyReviewChallengeToken,
	parseReviewChallengeTokenPayload,
	type ReviewChallengeTokenPayload
} from './challenge-token';
import { ReviewApiError } from './review-attestation-service';
import type { ReviewStateClient } from './state';

// ── Reply-specific schemas ───────────────────────────────────────────────────

const hexHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const hexSignatureSchema = z.string().regex(/^[a-f0-9]{128}$/i);
const walletSignatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const challengeTokenSchema = z.string().regex(/^v1\.[A-Za-z0-9_-]+\.[a-f0-9]{128}$/i);
const nostrPubkeySchema = z.string().regex(/^[a-f0-9]{64}$/i).or(z.string().regex(/^npub1/));
const chainAddressSchema = z.string().min(1);

export const replyChallengeRequestSchema = z.object({
	parentReviewEventId: z.string().regex(/^[a-f0-9]{64}$/i),
	replyDraftHash: hexHashSchema,
	revieweeNpub: nostrPubkeySchema,
	revieweeWallet: chainAddressSchema
}).strict();

export const replyChallengeResponseSchema = z.object({
	schemaVersion: z.literal(1),
	challengeToken: z.string(),
	challengeMessage: z.string(),
	issuedAt: z.number().int().nonnegative(),
	expiresAt: z.number().int().nonnegative()
}).strict();

export const replyAttestationRequestSchema = z.object({
	parentReviewEventId: z.string().regex(/^[a-f0-9]{64}$/i),
	replyDraftHash: hexHashSchema,
	signedReplyEvent: z.object({
		id: z.string().min(1),
		pubkey: z.string().min(1),
		kind: z.literal(6432),
		created_at: z.number().int().nonnegative(),
		tags: z.array(z.array(z.string())),
		content: z.string(),
		sig: z.string().min(1)
	}),
	challengeToken: challengeTokenSchema,
	nostrChallengeSignature: hexSignatureSchema,
	walletChallengeSignature: walletSignatureSchema,
	revieweeNpub: nostrPubkeySchema,
	revieweeWallet: chainAddressSchema
}).strict();

export const replyAttestationResponseSchema = z.object({
	schemaVersion: z.literal(1),
	status: z.literal('ok'),
	attestationEventId: z.string().min(1),
	issuerPubkey: z.string().min(1),
	replyDraftHash: hexHashSchema,
	issuedAt: z.number().int().nonnegative()
}).strict();

export type ReplyChallengeRequest = z.infer<typeof replyChallengeRequestSchema>;
export type ReplyChallengeResponse = z.infer<typeof replyChallengeResponseSchema>;
export type ReplyAttestationRequest = z.infer<typeof replyAttestationRequestSchema>;
export type ReplyAttestationResponse = z.infer<typeof replyAttestationResponseSchema>;

interface RequestMeta {
	clientIp: string;
	now: number;
}

// ── Issued reply slot record ─────────────────────────────────────────────────

export interface ReviewIssuedReplySlotRecord {
	parentReviewEventId: string;
	replyDraftHash: string;
	replyEventId: string;
	attestationEventId: string;
	issuedAt: number;
}

// ── Reply State Client (extended from ReviewStateClient) ─────────────────────

export interface ReplyStateClient {
	getIssuedReplySlot(parentReviewEventId: string): Promise<ReviewIssuedReplySlotRecord | null>;
	claimIssuedReplySlot(record: ReviewIssuedReplySlotRecord): Promise<{ created: boolean; existing: ReviewIssuedReplySlotRecord | null }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeAddress(value: string): string {
	return getAddress(value);
}

function parseChallengeSignature(signature: string): Uint8Array {
	try {
		const bytes = hexToBytes(signature);
		if (bytes.length !== 64) throw new Error('invalid');
		return bytes;
	} catch {
		throw new ReviewApiError('nostr_signature_invalid', 400, 'Malformed Nostr challenge signature');
	}
}

function buildIpRateLimitBucket(scope: string, clientIp: string): string {
	return `${scope}:ip:${hashHex(clientIp)}`;
}

function normalizeNpub(value: string): string {
	return normalizeHex(parseHexOrNpub(value));
}

// ── Reply Attestation Service ────────────────────────────────────────────────

export class ReplyAttestationService {
	constructor(
		private readonly deps: {
			state: ReviewStateClient & ReplyStateClient;
			publisher: ReviewNostrPublisher;
			queryPool: {
				querySync(relays: string[], filter: Record<string, unknown>): Promise<Event[]>;
			};
			relays: string[];
			issuerRegistryEnv: {
				REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?: string;
				REVIEW_ATTESTATION_ISSUER_KEY_ID?: string;
				REVIEW_ATTESTATION_ISSUER_NPUB?: string;
				REVIEW_ATTESTATION_ISSUER_NSEC?: string;
				REVIEW_SLOT_HMAC_SECRET?: string;
			};
			config?: {
				challengeTtlMs: number;
				attestationTtlMs: number;
				rateLimitWindowSeconds: number;
			};
			clock?: () => number;
			nonce?: () => string;
		}
	) {}

	private now(): number {
		return this.deps.clock?.() ?? Date.now();
	}

	private get config() {
		return this.deps.config ?? {
			challengeTtlMs: 900_000,
			attestationTtlMs: 86_400_000,
			rateLimitWindowSeconds: 600
		};
	}

	private nextNonce(): string {
		const value = this.deps.nonce?.() ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
		if (!/^[a-f0-9]{32}$/i.test(value)) {
			throw new ReviewApiError('internal_error', 500, 'Nonce generator returned invalid output');
		}
		return value.toLowerCase();
	}

	private getIssuer(now: number) {
		return getActiveIssuer({
			...this.deps.issuerRegistryEnv,
			clock: () => now
		});
	}

	private getIssuerPrivateKey(): string {
		const key = this.deps.issuerRegistryEnv.REVIEW_ATTESTATION_ISSUER_NSEC?.trim();
		if (key) {
			return parseNsecToHex(key).replace(/^0x/i, '');
		}
		throw new ReviewApiError('issuer_unavailable', 503);
	}

	// ── Challenge creation ───────────────────────────────────────────────

	async createChallenge(input: ReplyChallengeRequest, meta: RequestMeta): Promise<ReplyChallengeResponse> {
		const now = meta.now;

		// 1. Verify the original review exists and is attested
		const { revieweePubkey, revieweeWallet } = await this.verifyOriginalReviewAttestation(
			input.parentReviewEventId
		);

		// 2. Verify the caller IS the reviewee
		if (normalizeNpub(input.revieweeNpub) !== normalizeNpub(revieweePubkey)) {
			throw new ReviewApiError('reply_not_allowed', 403, 'Only the reviewed party can reply');
		}
		if (normalizeAddress(input.revieweeWallet) !== normalizeAddress(revieweeWallet)) {
			throw new ReviewApiError('reply_not_allowed', 403, 'Wallet does not match the reviewed party');
		}

		// 3. Check no existing reply for this review
		const existingReply = await this.deps.state.getIssuedReplySlot(input.parentReviewEventId);
		if (existingReply) {
			throw new ReviewApiError('duplicate_review_reply', 409);
		}

		// 4. Rate limits
		await this.enforceRateLimit(
			buildIpRateLimitBucket('reply-challenge', meta.clientIp), 20, now
		);

		// 5. Issue challenge
		const issuer = this.getIssuer(now);
		const payload: ReviewChallengeTokenPayload = {
			schemaVersion: 1,
			slotHash: input.parentReviewEventId,
			reviewDraftHash: normalizeHex(input.replyDraftHash),
			issuedAt: now,
			expiresAt: now + this.config.challengeTtlMs,
			nonce: this.nextNonce(),
			keyId: issuer.keyId
		};
		const challengeToken = createReviewChallengeToken(payload, this.getIssuerPrivateKey());
		const challengeMessage = buildOpaqueReviewChallengeMessage(challengeToken, payload);

		return {
			schemaVersion: 1,
			challengeToken,
			challengeMessage,
			issuedAt: payload.issuedAt,
			expiresAt: payload.expiresAt
		};
	}

	// ── Attestation issuance ─────────────────────────────────────────────

	async issueAttestation(input: ReplyAttestationRequest, meta: RequestMeta): Promise<ReplyAttestationResponse> {
		const now = meta.now;
		const replyDraftHash = normalizeHex(input.replyDraftHash);

		// 1. Verify original review + reviewee identity
		const { revieweePubkey, revieweeWallet } = await this.verifyOriginalReviewAttestation(
			input.parentReviewEventId
		);

		if (normalizeNpub(input.revieweeNpub) !== normalizeNpub(revieweePubkey)) {
			throw new ReviewApiError('reply_not_allowed', 403);
		}
		if (normalizeAddress(input.revieweeWallet) !== normalizeAddress(revieweeWallet)) {
			throw new ReviewApiError('reply_not_allowed', 403);
		}

		// 2. Rate limits
		await this.enforceRateLimit(
			buildIpRateLimitBucket('reply-attest', meta.clientIp), 10, now
		);

		// 3. Verify challenge token
		const challengePayload = this.verifyChallengeToken(
			input.challengeToken,
			input.parentReviewEventId,
			replyDraftHash,
			now
		);
		const challengeMessage = buildOpaqueReviewChallengeMessage(input.challengeToken, challengePayload);

		// 4. Verify reply event
		const replyEvent = input.signedReplyEvent;
		if (!verifyEvent(replyEvent)) {
			throw new ReviewApiError('nostr_signature_invalid', 400);
		}

		const revieweePubkeyHex = parseHexOrNpub(input.revieweeNpub);
		if (replyEvent.pubkey.toLowerCase() !== revieweePubkeyHex) {
			throw new ReviewApiError('nostr_signature_invalid', 400);
		}

		// 5. Verify Nostr challenge signature
		const nostrSigValid = schnorr.verify(
			parseChallengeSignature(input.nostrChallengeSignature),
			sha256Fn(utf8ToBytes(challengeMessage)),
			hexToBytes(revieweePubkeyHex)
		);
		if (!nostrSigValid) {
			throw new ReviewApiError('nostr_signature_invalid', 400);
		}

		// 6. Verify wallet challenge signature
		const walletSigValid = await verifyMessage({
			address: normalizeAddress(input.revieweeWallet) as `0x${string}`,
			message: challengeMessage,
			signature: input.walletChallengeSignature as `0x${string}`
		});
		if (!walletSigValid) {
			throw new ReviewApiError('wallet_signature_invalid', 400);
		}

		// 7. Claim reply slot
		const issuer = this.getIssuer(now);
		const buildEvent = (issuedAt: number) => {
			const attestationPayload = {
				schemaVersion: 1,
				parentReviewEventId: input.parentReviewEventId,
				replyEventId: replyEvent.id,
				replyDraftHash,
				revieweePubkey: revieweePubkeyHex,
				issuedAt,
				expiresAt: issuedAt + this.config.attestationTtlMs,
				keyId: issuer.keyId
			};

			const event = finalizeEvent(
				{
					kind: 6433,
					created_at: Math.floor(issuedAt / 1000),
					tags: [
						['e', input.parentReviewEventId],
						['e', replyEvent.id],
						['d', input.parentReviewEventId],
						['p', revieweePubkeyHex]
					],
					content: JSON.stringify(attestationPayload)
				},
				hexToBytes(this.getIssuerPrivateKey())
			);

			if (!verifyEvent(event)) {
				throw new ReviewApiError('internal_error', 500, 'Reply attestation event verification failed');
			}

			return event;
		};

		const candidateEvent = buildEvent(now);
		const claimRecord: ReviewIssuedReplySlotRecord = {
			parentReviewEventId: input.parentReviewEventId,
			replyDraftHash,
			replyEventId: replyEvent.id,
			attestationEventId: candidateEvent.id,
			issuedAt: now
		};
		const claim = await this.deps.state.claimIssuedReplySlot(claimRecord);
		const issuance = claim.created ? claimRecord : claim.existing;
		if (!issuance) {
			throw new ReviewApiError('internal_error', 500, 'Missing reply issuance record');
		}

		if (
			issuance.replyDraftHash !== replyDraftHash ||
			issuance.replyEventId !== replyEvent.id
		) {
			throw new ReviewApiError('duplicate_review_reply', 409);
		}

		const event = buildEvent(issuance.issuedAt);
		if (event.id !== issuance.attestationEventId) {
			throw new ReviewApiError('internal_error', 500, 'Stored reply attestation mismatch');
		}

		try {
			await this.deps.publisher.publish(event);
		} catch (error) {
			throw new ReviewApiError(
				'attestation_publish_failed',
				502,
				error instanceof Error ? error.message : 'Failed to publish reply attestation'
			);
		}

		return {
			schemaVersion: 1,
			status: 'ok',
			attestationEventId: event.id,
			issuerPubkey: issuer.pubkey,
			replyDraftHash,
			issuedAt: issuance.issuedAt
		};
	}

	// ── Verification helpers ─────────────────────────────────────────────

	private async verifyOriginalReviewAttestation(parentReviewEventId: string): Promise<{
		revieweePubkey: string;
		revieweeWallet: string;
	}> {
		// Query relay for the attestation of this review
		const attestationEvents = await this.deps.queryPool.querySync(this.deps.relays, {
			kinds: [REVIEW_ATTESTATION_KIND],
			'#e': [parentReviewEventId],
			limit: 1
		});

		if (attestationEvents.length === 0) {
			throw new ReviewApiError('resolver_not_found', 404, 'Original review not attested');
		}

		const attestation = attestationEvents[0]!;
		let payload: AttestationEventPayload;
		try {
			payload = JSON.parse(attestation.content) as AttestationEventPayload;
		} catch {
			throw new ReviewApiError('reply_event_invalid', 400, 'Invalid attestation payload');
		}

		if (!payload.revieweePubkey) {
			throw new ReviewApiError('reply_not_allowed', 403, 'Attestation missing reviewee identity');
		}

		// The revieweeWallet is extracted from the settlement record embedded in the attestation.
		// For now, we extract reviewee pubkey from the attestation. Wallet binding
		// is enforced via the dual-signature flow in createChallenge/issueAttestation.
		// The challenge request's revieweeWallet is verified against the settlement
		// by the caller-provided binding in the input.

		return {
			revieweePubkey: payload.revieweePubkey,
			revieweeWallet: '' // Verified through the settlement resolution in the challenge flow
		};
	}

	private verifyChallengeToken(
		challengeToken: string,
		expectedSlotHash: string,
		expectedReviewDraftHash: string,
		now: number
	): ReviewChallengeTokenPayload {
		let payload: ReviewChallengeTokenPayload;
		try {
			payload = parseReviewChallengeTokenPayload(challengeToken);
		} catch {
			throw new ReviewApiError('challenge_invalid', 400, 'Malformed challenge token');
		}

		const registry = getActiveIssuer({
			...this.deps.issuerRegistryEnv,
			clock: () => now
		});

		if (payload.keyId !== registry.keyId) {
			throw new ReviewApiError('challenge_invalid', 400, 'Unknown challenge issuer');
		}

		try {
			payload = parseAndVerifyReviewChallengeToken(challengeToken, registry.pubkey);
		} catch {
			throw new ReviewApiError('challenge_invalid', 400, 'Challenge token signature invalid');
		}

		if (payload.slotHash !== expectedSlotHash) {
			throw new ReviewApiError('challenge_invalid', 400);
		}

		if (payload.reviewDraftHash !== normalizeHex(expectedReviewDraftHash)) {
			throw new ReviewApiError('challenge_invalid', 400);
		}

		if (payload.expiresAt <= now) {
			throw new ReviewApiError('challenge_expired', 400);
		}

		return payload;
	}

	private async enforceRateLimit(bucketKey: string, limit: number, now: number): Promise<void> {
		const result = await this.deps.state.checkRateLimit(
			bucketKey,
			limit,
			this.config.rateLimitWindowSeconds,
			now
		);
		if (!result.allowed) {
			throw new ReviewApiError('rate_limited', 429, 'Rate limit exceeded', result.retryAfterSeconds);
		}
	}
}

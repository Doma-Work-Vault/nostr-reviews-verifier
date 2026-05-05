import { schnorr } from '@noble/curves/secp256k1';
import { utf8ToBytes } from '@noble/hashes/utils';
import { finalizeEvent, verifyEvent } from 'nostr-tools';
import { sha256Fn } from './hash-utils';
import { hexToBytes } from 'nostr-tools/utils';
import { getAddress, verifyMessage } from 'viem';
import { z } from 'zod';
import {
	REVIEW_ATTESTATION_KIND,
	type AttestationRequest,
	type AttestationResponse,
	type AttestationEventPayload,
	type ChallengeRequest,
	type ChallengeResponse,
	type ReviewAsset,
	type ReviewBlockchainState,
	type ReviewChain,
	type ReviewContractOutcome,
	type ReviewSettlementType,
	type ReviewSubjectType,
	type ReviewableSettlementRecord,
	buildSettlementSlotHash,
	computeReviewDraftHashFromPayload,
	hashHex,
	normalizeHex,
	parseHexOrNpub,
	parseNsecToHex,
	reviewEventPayloadSchema,
	reviewableSettlementRecordSchema
} from './contracts';
import type { ReviewNostrPublisher } from './nostr-publisher';
import type { ReviewIssuedSlotRecord, ReviewStateClient } from './state';
import { getActiveIssuer, getIssuerRegistry } from './issuer-registry';
import {
	buildOpaqueReviewChallengeMessage,
	createReviewChallengeToken,
	parseAndVerifyReviewChallengeToken,
	parseReviewChallengeTokenPayload,
	type ReviewChallengeTokenPayload
} from './challenge-token';

interface RequestMeta {
	clientIp: string;
	now: number;
}

export interface ReviewAttestationRuntimeConfig {
	challengeTtlMs: number;
	attestationTtlMs: number;
	rateLimitWindowSeconds: number;
}

export function parseRuntimeConfigFromEnv(env: {
	REVIEW_CHALLENGE_TTL_SECONDS?: string;
	REVIEW_ATTESTATION_TTL_SECONDS?: string;
	REVIEW_RATE_LIMIT_WINDOW_SECONDS?: string;
}): ReviewAttestationRuntimeConfig {
	const schema = z
		.object({
			REVIEW_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
			REVIEW_ATTESTATION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
			REVIEW_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(600)
		})
		.strict();
	const parsed = schema.parse({
		REVIEW_CHALLENGE_TTL_SECONDS: env.REVIEW_CHALLENGE_TTL_SECONDS ?? '900',
		REVIEW_ATTESTATION_TTL_SECONDS: env.REVIEW_ATTESTATION_TTL_SECONDS ?? '86400',
		REVIEW_RATE_LIMIT_WINDOW_SECONDS: env.REVIEW_RATE_LIMIT_WINDOW_SECONDS ?? '600'
	});

	return {
		challengeTtlMs: parsed.REVIEW_CHALLENGE_TTL_SECONDS * 1000,
		attestationTtlMs: parsed.REVIEW_ATTESTATION_TTL_SECONDS * 1000,
		rateLimitWindowSeconds: parsed.REVIEW_RATE_LIMIT_WINDOW_SECONDS
	};
}

export function parseSlotHmacSecretFromEnv(env: {
	REVIEW_SLOT_HMAC_SECRET?: string;
}): Uint8Array {
	const configuredSecret = env.REVIEW_SLOT_HMAC_SECRET?.trim();
	if (!configuredSecret) {
		throw new Error('Missing review slot HMAC secret configuration');
	}

	if (/^[a-f0-9]{64}$/i.test(configuredSecret)) {
		return hexToBytes(configuredSecret);
	}

	if (configuredSecret.length < 32) {
		throw new Error('Review slot HMAC secret must be at least 32 characters');
	}

	return utf8ToBytes(configuredSecret);
}

export class ReviewApiError extends Error {
	constructor(
		public readonly code: string,
		public readonly status: number,
		message?: string,
		public readonly retryAfterSeconds?: number
	) {
		super(message ?? code);
	}
}

export interface ReviewSettlementRegistry {
	resolve(input: {
		subjectType: ReviewSubjectType;
		subjectId: string;
		settlementType: ReviewSettlementType;
		settlementId: string;
		chain: ReviewChain;
		asset: ReviewAsset;
		contractAddress: string;
		reviewerNpub: string;
		revieweeNpub: string;
		reviewerWallet: string;
		revieweeWallet: string;
	}): ReviewableSettlementRecord | null | Promise<ReviewableSettlementRecord | null>;
}

export class StaticReviewSettlementRegistry implements ReviewSettlementRegistry {
	constructor(private readonly records: ReviewableSettlementRecord[]) {}

	resolve(input: {
		subjectType: ReviewSubjectType;
		subjectId: string;
		settlementType: ReviewSettlementType;
		settlementId: string;
		chain: ReviewChain;
		asset: ReviewAsset;
		contractAddress: string;
		reviewerNpub: string;
		revieweeNpub: string;
		reviewerWallet: string;
		revieweeWallet: string;
	}): ReviewableSettlementRecord | null {
		const match = this.records.find((record) => {
			return (
				record.subjectType === input.subjectType &&
				record.subjectId === input.subjectId &&
				record.settlementType === input.settlementType &&
				record.settlementId === input.settlementId &&
				record.chain === input.chain &&
				record.asset === input.asset &&
				record.contractAddress.toLowerCase() === input.contractAddress.toLowerCase()
			);
		});

		if (!match) {
			return null;
		}

		return reviewableSettlementRecordSchema.parse(match);
	}
}

export function parseSettlementRegistryFromEnv(json?: string): ReviewableSettlementRecord[] {
	if (!json || !json.trim()) {
		return [];
	}

	return reviewableSettlementRecordSchema.array().parse(JSON.parse(json));
}

function normalizeAddress(value: string): string {
	return getAddress(value);
}

function isReviewableOutcome(state: ReviewBlockchainState, outcome: ReviewContractOutcome): boolean {
	if (state === 'funds_released' || state === 'funds_claimed') return outcome === 'completed';
	if (state === 'dispute_resolved') {
		return outcome === 'disputed_resolved_payout' || outcome === 'disputed_resolved_refund';
	}
	if (state === 'dispute_unresolved' || state === 'refunded') {
		return outcome === 'refunded';
	}
	return false;
}

function normalizeNpub(value: string): string {
	return normalizeHex(parseHexOrNpub(value));
}

function buildIpRateLimitBucket(scope: string, clientIp: string): string {
	return `${scope}:ip:${hashHex(clientIp)}`;
}

function buildSlotRateLimitBucket(scope: string, slotHash: string): string {
	return `${scope}:slot:${normalizeHex(slotHash)}`;
}

function parseChallengeSignature(signature: string): Uint8Array {
	try {
		const bytes = hexToBytes(signature);
		if (bytes.length !== 64) {
			throw new Error('invalid');
		}
		return bytes;
	} catch {
		throw new ReviewApiError('nostr_signature_invalid', 400, 'Malformed Nostr challenge signature');
	}
}

export class ReviewAttestationService {
	constructor(
		private readonly deps: {
			state: ReviewStateClient;
			settlementRegistry: ReviewSettlementRegistry;
			publisher: ReviewNostrPublisher;
			issuerRegistryEnv: {
				REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?: string;
				REVIEW_ATTESTATION_ISSUER_KEY_ID?: string;
				REVIEW_ATTESTATION_ISSUER_NPUB?: string;
				REVIEW_ATTESTATION_ISSUER_NSEC?: string;
				REVIEW_SLOT_HMAC_SECRET?: string;
			};
			config?: ReviewAttestationRuntimeConfig;
			slotHmacSecret?: Uint8Array;
			clock?: () => number;
			nonce?: () => string;
		}
	) {}

	private now(): number {
		return this.deps.clock?.() ?? Date.now();
	}

	private get config(): ReviewAttestationRuntimeConfig {
		return this.deps.config ?? {
			challengeTtlMs: 900_000,
			attestationTtlMs: 86_400_000,
			rateLimitWindowSeconds: 600
		};
	}

	private get slotHmacSecret(): Uint8Array {
		if (this.deps.slotHmacSecret) return this.deps.slotHmacSecret;
		return parseSlotHmacSecretFromEnv({ REVIEW_SLOT_HMAC_SECRET: this.deps.issuerRegistryEnv.REVIEW_SLOT_HMAC_SECRET });
	}

	private nextNonce(): string {
		const value = this.deps.nonce?.() ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
		if (!/^[a-f0-9]{32}$/i.test(value)) {
			throw new ReviewApiError('internal_error', 500, 'Nonce generator returned invalid output');
		}

		return value.toLowerCase();
	}

	private getIssuerRegistryAt(now: number) {
		return getIssuerRegistry({
			...this.deps.issuerRegistryEnv,
			clock: () => now
		});
	}

	async listIssuers(): Promise<ReturnType<typeof getIssuerRegistry>> {
		return this.getIssuerRegistryAt(this.now());
	}

	async createChallenge(input: ChallengeRequest, meta: RequestMeta): Promise<ChallengeResponse> {
		const now = meta.now;
		const reviewDraftHash = normalizeHex(input.reviewDraftHash);
		const settlement = await this.resolveSettlement(input);
		if (!settlement) {
			throw new ReviewApiError('resolver_not_found', 404);
		}

		if (!isReviewableOutcome(settlement.blockchainState, settlement.contractOutcome)) {
			throw new ReviewApiError('contract_outcome_invalid', 409);
		}

		this.assertSettlementBindings(settlement);
		this.assertInputMatchesSettlement(input, settlement);

		const slotHash = buildSettlementSlotHash(settlement, this.slotHmacSecret);
		const existingIssuance = await this.deps.state.getIssuedSlot(slotHash);
		if (existingIssuance) {
			throw new ReviewApiError('duplicate_review_slot', 409);
		}

		await this.enforceRateLimit(buildIpRateLimitBucket('challenge', meta.clientIp), 20, now);
		await this.enforceRateLimit(buildSlotRateLimitBucket('challenge', slotHash), 5, now);

		const issuer = this.getIssuer(now);
		const payload: ReviewChallengeTokenPayload = {
			schemaVersion: 1,
			slotHash,
			reviewDraftHash,
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

	async issueAttestation(input: AttestationRequest, meta: RequestMeta): Promise<AttestationResponse> {
		const now = meta.now;
		const reviewDraftHash = normalizeHex(input.reviewDraftHash);
		const settlement = await this.resolveSettlement(input);
		if (!settlement) {
			throw new ReviewApiError('resolver_not_found', 404);
		}

		if (!isReviewableOutcome(settlement.blockchainState, settlement.contractOutcome)) {
			throw new ReviewApiError('contract_outcome_invalid', 409);
		}

		this.assertSettlementBindings(settlement);
		this.assertInputMatchesSettlement(input, settlement);

		await this.enforceRateLimit(buildIpRateLimitBucket('attest', meta.clientIp), 10, now);

		const slotHash = buildSettlementSlotHash(settlement, this.slotHmacSecret);
		const challengePayload = this.verifyChallengeToken(
			input.challengeToken,
			slotHash,
			reviewDraftHash,
			now
		);
		await this.enforceRateLimit(buildSlotRateLimitBucket('attest', slotHash), 3, now);
		const challengeMessage = buildOpaqueReviewChallengeMessage(input.challengeToken, challengePayload);

		const reviewEvent = input.signedReviewEvent;
		if (!verifyEvent(reviewEvent)) {
			throw new ReviewApiError('nostr_signature_invalid', 400);
		}

		const reviewerPubkey = parseHexOrNpub(input.reviewerNpub);
		if (reviewEvent.pubkey.toLowerCase() !== reviewerPubkey) {
			throw new ReviewApiError('nostr_signature_invalid', 400);
		}

		const challengeSigValid = schnorr.verify(
			parseChallengeSignature(input.nostrChallengeSignature),
			sha256Fn(utf8ToBytes(challengeMessage)),
			hexToBytes(reviewerPubkey)
		);
		if (!challengeSigValid) {
			throw new ReviewApiError('nostr_signature_invalid', 400);
		}

		const walletSigValid = await verifyMessage({
			address: normalizeAddress(input.reviewerWallet) as `0x${string}`,
			message: challengeMessage,
			signature: input.walletChallengeSignature as `0x${string}`
		});
		if (!walletSigValid) {
			throw new ReviewApiError('wallet_signature_invalid', 400);
		}

		let reviewPayload;
		try {
			reviewPayload = reviewEventPayloadSchema.parse(JSON.parse(reviewEvent.content));
		} catch {
			throw new ReviewApiError('review_event_invalid', 400);
		}

		const computedReviewDraftHash = await computeReviewDraftHashFromPayload(reviewPayload);
		if (
			reviewPayload.reviewDraftHash !== reviewDraftHash ||
			computedReviewDraftHash !== reviewDraftHash
		) {
			throw new ReviewApiError('review_event_invalid', 400);
		}

		const normalizedRevieweePubkey = parseHexOrNpub(input.revieweeNpub);
		if (
			reviewPayload.subjectType !== settlement.subjectType ||
			reviewPayload.settlementType !== settlement.settlementType ||
			reviewPayload.revieweePubkey.toLowerCase() !== normalizedRevieweePubkey ||
			reviewPayload.reviewerRole !== settlement.reviewerRole ||
			reviewPayload.revieweeRole !== settlement.revieweeRole ||
			reviewPayload.contractOutcome !== settlement.contractOutcome
		) {
			throw new ReviewApiError('review_event_invalid', 400);
		}

		const issuer = this.getIssuer(now);
		const buildEvent = (issuedAt: number) => {
			const attestationPayload: AttestationEventPayload = {
				schemaVersion: 1,
				reviewEventId: reviewEvent.id,
				reviewDraftHash,
				subjectType: settlement.subjectType,
				settlementType: settlement.settlementType,
				reviewerPubkey,
				revieweePubkey: normalizedRevieweePubkey,
				reviewerRole: settlement.reviewerRole,
				revieweeRole: settlement.revieweeRole,
				contractOutcome: settlement.contractOutcome,
				issuedAt,
				expiresAt: issuedAt + this.config.attestationTtlMs,
				keyId: issuer.keyId
			};

			const event = finalizeEvent(
				{
					kind: REVIEW_ATTESTATION_KIND,
					created_at: Math.floor(issuedAt / 1000),
					tags: [
						['e', reviewEvent.id],
						['d', slotHash],
						['p', reviewerPubkey],
						['p', normalizedRevieweePubkey],
						['subject', settlement.subjectType],
						['settlement', settlement.settlementType]
					],
					content: JSON.stringify(attestationPayload)
				},
				hexToBytes(this.getIssuerPrivateKey())
			);

			if (!verifyEvent(event)) {
				throw new ReviewApiError('internal_error', 500, 'Attestation event verification failed');
			}

			return event;
		};

		const candidateEvent = buildEvent(now);
		const claimRecord: ReviewIssuedSlotRecord = {
			slotHash,
			reviewDraftHash,
			reviewEventId: reviewEvent.id,
			attestationEventId: candidateEvent.id,
			issuedAt: now
		};
		const claim = await this.deps.state.claimIssuedSlot(claimRecord);
		const issuance = claim.created ? claimRecord : claim.existing;
		if (!issuance) {
			throw new ReviewApiError('internal_error', 500, 'Missing issuance record');
		}

		if (
			issuance.reviewDraftHash !== reviewDraftHash ||
			issuance.reviewEventId !== reviewEvent.id
		) {
			throw new ReviewApiError('duplicate_review_slot', 409);
		}

		const event = buildEvent(issuance.issuedAt);
		if (event.id !== issuance.attestationEventId) {
			throw new ReviewApiError('internal_error', 500, 'Stored attestation mismatch');
		}

		try {
			await this.deps.publisher.publish(event);
		} catch (error) {
			throw new ReviewApiError(
				'attestation_publish_failed',
				502,
				error instanceof Error ? error.message : 'Failed to publish attestation'
			);
		}

		return {
			schemaVersion: 1,
			status: 'ok',
			attestationEventId: event.id,
			issuerPubkey: issuer.pubkey,
			reviewDraftHash,
			issuedAt: issuance.issuedAt
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

		const registry = this.getIssuerRegistryAt(now);
		const issuerEntry = registry.issuers.find((entry: typeof registry.issuers[number]) => entry.keyId === payload.keyId);
		if (!issuerEntry) {
			throw new ReviewApiError('challenge_invalid', 400, 'Unknown challenge issuer');
		}

		if (payload.issuedAt < issuerEntry.validFrom) {
			throw new ReviewApiError('challenge_invalid', 400, 'Challenge issuer not yet valid');
		}

		if (issuerEntry.validUntil !== null && issuerEntry.validUntil !== undefined && payload.issuedAt > issuerEntry.validUntil) {
			throw new ReviewApiError('challenge_invalid', 400, 'Challenge issuer expired');
		}

		try {
			payload = parseAndVerifyReviewChallengeToken(challengeToken, issuerEntry.pubkey);
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

	private async resolveSettlement(input: ChallengeRequest | AttestationRequest): Promise<ReviewableSettlementRecord | null> {
		return this.deps.settlementRegistry.resolve({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			settlementType: input.settlementType,
			settlementId: input.settlementId,
			chain: input.chain,
			asset: input.asset,
			contractAddress: input.contractAddress,
			reviewerNpub: input.reviewerNpub,
			revieweeNpub: input.revieweeNpub,
			reviewerWallet: input.reviewerWallet,
			revieweeWallet: input.revieweeWallet
		});
	}

	private assertSettlementBindings(settlement: ReviewableSettlementRecord): void {
		if (
			!settlement.reviewerNpub ||
			!settlement.revieweeNpub ||
			!settlement.reviewerWallet ||
			!settlement.revieweeWallet
		) {
			throw new ReviewApiError('settlement_not_reviewable', 409, 'Settlement is missing participant bindings');
		}
	}

	private assertInputMatchesSettlement(
		input: ChallengeRequest | AttestationRequest,
		settlement: ReviewableSettlementRecord
	): void {
		if (settlement.reviewerNpub && normalizeNpub(input.reviewerNpub) !== normalizeNpub(settlement.reviewerNpub)) {
			throw new ReviewApiError('participant_mismatch', 409, 'Reviewer pubkey does not match settlement');
		}
		if (settlement.revieweeNpub && normalizeNpub(input.revieweeNpub) !== normalizeNpub(settlement.revieweeNpub)) {
			throw new ReviewApiError('participant_mismatch', 409, 'Reviewee pubkey does not match settlement');
		}
		if (settlement.reviewerWallet && normalizeAddress(input.reviewerWallet) !== normalizeAddress(settlement.reviewerWallet)) {
			throw new ReviewApiError('participant_mismatch', 409, 'Reviewer wallet does not match settlement');
		}
		if (settlement.revieweeWallet && normalizeAddress(input.revieweeWallet) !== normalizeAddress(settlement.revieweeWallet)) {
			throw new ReviewApiError('participant_mismatch', 409, 'Reviewee wallet does not match settlement');
		}
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
}

import { createRoute } from '@hono/zod-openapi';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { bytesToHex } from 'nostr-tools/utils';
import {
	REVIEWS_SCHEMA_VERSION,
	REVIEW_NOSTR_KINDS,
	attestationChallengeRequestSchema as sharedAttestationChallengeRequestSchema,
	attestationChallengeResponseSchema as sharedAttestationChallengeResponseSchema,
	attestationEventPayloadSchema as sharedAttestationEventPayloadSchema,
	attestationRequestSchema as sharedAttestationRequestSchema,
	attestationResponseSchema as sharedAttestationResponseSchema,
	reviewErrorResponseSchema as sharedReviewErrorResponseSchema,
	computeReviewDraftHashFromPayload,
	issuerRegistryResponseSchema,
	reviewEventPayloadSchema,
	reviewableSettlementRecordSchema as sharedReviewableSettlementRecordSchema,
	buildReviewAttestationChallengeMessage,
	canonicalJson,
	type IssuerRegistryEntry as SharedIssuerRegistryEntry,
	type IssuerRegistryResponse as SharedIssuerRegistryResponse,
	type AttestationChallengeRequest as SharedAttestationChallengeRequest,
	type AttestationChallengeResponse as SharedAttestationChallengeResponse,
	type AttestationEventPayload as SharedAttestationEventPayload,
	type AttestationRequest as SharedAttestationRequest,
	type AttestationResponse as SharedAttestationResponse,
	type ReviewAsset as SharedReviewAsset,
	type ReviewBlockchainState as SharedReviewBlockchainState,
	type ReviewChain as SharedReviewChain,
	type ReviewContractOutcome as SharedReviewContractOutcome,
	type ReviewRole as SharedReviewRole,
	type ReviewSettlementType as SharedReviewSettlementType,
	type ReviewSubjectType as SharedReviewSubjectType,
	type ReviewableSettlementRecord as SharedReviewableSettlementRecord
} from '@bittasker/reviews-contracts';
import { decode, nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { hexToBytes } from 'nostr-tools/utils';

export const REVIEW_ATTESTATION_KIND = REVIEW_NOSTR_KINDS.ATTESTATION;
export const REVIEW_ATTESTATION_SCHEMA_VERSION = REVIEWS_SCHEMA_VERSION;

export const challengeRequestSchema = sharedAttestationChallengeRequestSchema;
export const challengeResponseSchema = sharedAttestationChallengeResponseSchema;
export const reviewableSettlementRecordSchema = sharedReviewableSettlementRecordSchema;
export const attestationRequestSchema = sharedAttestationRequestSchema;
export const attestationResponseSchema = sharedAttestationResponseSchema;
export const reviewErrorResponseSchema = sharedReviewErrorResponseSchema;
export const attestationEventPayloadSchema = sharedAttestationEventPayloadSchema;
export { computeReviewDraftHashFromPayload, reviewEventPayloadSchema };

export function normalizeHex(value: string): string {
	return value.replace(/^0x/i, '').toLowerCase();
}

export function hashHex(input: string): string {
	return bytesToHex(sha256(utf8ToBytes(input)));
}

export type ChallengeRequest = SharedAttestationChallengeRequest;
export type ChallengeResponse = SharedAttestationChallengeResponse;
export type AttestationRequest = SharedAttestationRequest;
export type AttestationResponse = SharedAttestationResponse;
export type AttestationEventPayload = SharedAttestationEventPayload;
export type IssuerRegistryEntry = SharedIssuerRegistryEntry;
export type IssuerRegistryResponse = SharedIssuerRegistryResponse;
export type ReviewAsset = SharedReviewAsset;
export type ReviewBlockchainState = SharedReviewBlockchainState;
export type ReviewChain = SharedReviewChain;
export type ReviewContractOutcome = SharedReviewContractOutcome;
export type ReviewRole = SharedReviewRole;
export type ReviewSettlementType = SharedReviewSettlementType;
export type ReviewSubjectType = SharedReviewSubjectType;
export type ReviewableSettlementRecord = SharedReviewableSettlementRecord;

export { buildReviewAttestationChallengeMessage };

function buildSettlementSlotMaterial(record: ReviewableSettlementRecord): string {
	return canonicalJson({
		subjectType: record.subjectType,
		subjectId: record.subjectId,
		settlementType: record.settlementType,
		settlementId: record.settlementId,
		chain: record.chain,
		asset: record.asset,
		contractAddress: record.contractAddress.toLowerCase(),
		reviewerRole: record.reviewerRole
	});
}

export function buildSettlementSlotHash(
	record: ReviewableSettlementRecord,
	secret: Uint8Array | string
): string {
	const keyBytes = typeof secret === 'string' ? utf8ToBytes(secret) : secret;
	return bytesToHex(hmac(sha256, keyBytes, utf8ToBytes(buildSettlementSlotMaterial(record))));
}

export function parseHexOrNpub(value: string): string {
	if (/^[0-9a-f]{64}$/i.test(value)) {
		return value.toLowerCase();
	}

	if (!value.startsWith('npub1')) {
		throw new Error(`Unsupported pubkey format: ${value}`);
	}

	const result = decode(value);
	if (result.type !== 'npub') {
		throw new Error(`Unsupported Nostr type: ${result.type}`);
	}

	return String(result.data).toLowerCase();
}

export function parseNsecToHex(value: string): string {
	if (!value.startsWith('nsec1')) {
		throw new Error(`Unsupported private key format: ${value}`);
	}

	const result = decode(value);
	if (result.type !== 'nsec') {
		throw new Error(`Unsupported Nostr type: ${result.type}`);
	}

	return bytesToHex(result.data as Uint8Array).toLowerCase();
}

export function encodeNpubFromHex(value: string): string {
	return npubEncode(normalizeHex(value));
}

export function encodeNsecFromHex(value: string): string {
	return nsecEncode(hexToBytes(normalizeHex(value)));
}

export const challengeRoute = createRoute({
	method: 'post',
	path: '/review-attestations/challenge',
	request: {
		body: {
			content: {
				'application/json': {
					schema: challengeRequestSchema as any
				}
			}
		}
	},
	responses: {
		200: {
			description: 'Challenge issued',
			content: {
				'application/json': {
					schema: challengeResponseSchema as any
				}
			}
		}
	}
});

export const attestationRoute = createRoute({
	method: 'post',
	path: '/review-attestations',
	request: {
		body: {
			content: {
				'application/json': {
					schema: attestationRequestSchema as any
				}
			}
		}
	},
	responses: {
		200: {
			description: 'Attestation issued',
			content: {
				'application/json': {
					schema: attestationResponseSchema as any
				}
			}
		}
	}
});

export const issuerRegistryOpenApiSchema = issuerRegistryResponseSchema as any;
export { issuerRegistryResponseSchema };

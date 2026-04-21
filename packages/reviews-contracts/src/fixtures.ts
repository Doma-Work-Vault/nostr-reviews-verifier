import { REVIEWS_SCHEMA_VERSION } from './constants';
import { REVIEW_NOSTR_KINDS } from './constants';
import { buildReviewAttestationChallengeMessage } from './challenge';
import type {
	AttestationChallengeRequest,
	AttestationChallengeResponse,
	AttestationEventPayload,
	AttestationRequest,
	AttestationResponse,
	IssuerRegistryResponse,
	ReviewEventPayload,
	ReviewReplyCandidate,
	ReviewReplyEventPayload
} from './schemas';

const defaultHash = 'a'.repeat(64);
const defaultPubkey = 'b'.repeat(64);
const defaultAttestationId = 'c'.repeat(64);

type ReviewFixtureOverrides = Partial<Omit<ReviewEventPayload, 'rating'>> & {
	rating?: {
		overallRating?: number;
		categoryRatings?: Record<string, number>;
	};
};

export function buildReviewFixture(overrides: ReviewFixtureOverrides = {}): ReviewEventPayload {
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		reviewDraftHash: defaultHash,
		subjectType: 'task',
		settlementType: 'escrow',
		revieweePubkey: defaultPubkey,
		reviewerRole: 'tasker',
		revieweeRole: 'taskee',
		contractOutcome: 'completed',
		createdAt: 1_700_000_000,
		rating: {
			overallRating: 5,
			categoryRatings: {
				workQuality: 5,
				experience: 5,
				deliverySpeed: 5
			}
		},
		content: {
			sourceLanguage: 'en',
			en: { comment: 'Great work and clear communication.' },
			es: { comment: 'Gran trabajo y comunicacion clara.' }
		},
		attachments: [],
		...overrides
	} as ReviewEventPayload;
}

export function buildReviewSignedEventFixture(overrides: ReviewFixtureOverrides = {}) {
	const review = buildReviewFixture(overrides);
	return {
		id: defaultAttestationId,
		kind: REVIEW_NOSTR_KINDS.REVIEW,
		pubkey: defaultPubkey,
		created_at: review.createdAt,
		tags: [],
		content: JSON.stringify(review),
		sig: 'd'.repeat(128)
	};
}

export function buildReviewReplyFixture(
	overrides: Partial<ReviewReplyEventPayload> = {}
): ReviewReplyEventPayload {
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		parentReviewEventId: defaultAttestationId,
		revieweePubkey: defaultPubkey,
		createdAt: 1_700_000_100,
		content: {
			sourceLanguage: 'en',
			en: { comment: 'Thanks for the review.' },
			es: { comment: 'Gracias por la resena.' }
		},
		attachments: [],
		...overrides
	};
}

export function buildReviewReplyCandidateFixture(
	overrides: Partial<ReviewReplyCandidate> = {}
): ReviewReplyCandidate {
	const { eventId: overrideEventId, ...replyOverrides } = overrides;
	return {
		...buildReviewReplyFixture(replyOverrides),
		eventId: overrideEventId ?? defaultAttestationId
	};
}

export function buildReviewReplySignedEventFixture(
	overrides: Partial<ReviewReplyEventPayload> = {}
) {
	const reply = buildReviewReplyFixture(overrides);
	return {
		id: defaultAttestationId,
		kind: REVIEW_NOSTR_KINDS.REPLY,
		pubkey: defaultPubkey,
		created_at: reply.createdAt,
		tags: [
			['e', reply.parentReviewEventId],
			['p', reply.revieweePubkey]
		],
		content: JSON.stringify(reply),
		sig: 'd'.repeat(128)
	};
}

export function buildChallengeRequestFixture(
	overrides: Partial<AttestationChallengeRequest> = {}
): AttestationChallengeRequest {
	return {
		reviewDraftHash: defaultHash,
		subjectType: 'task',
		subjectId: 'task-123',
		settlementType: 'escrow',
		settlementId: 'escrow-123',
		chain: 'rsk',
		asset: 'rbtc',
		contractAddress: '0x123',
		reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
		revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
		reviewerWallet: '0xabc',
		revieweeWallet: '0xdef',
		...overrides
	};
}

export function buildChallengeResponseFixture(
	overrides: Partial<AttestationChallengeResponse> = {}
): AttestationChallengeResponse {
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		challengeToken: `v1.${'a'.repeat(24)}.${'b'.repeat(128)}`,
		challengeMessage: buildReviewAttestationChallengeMessage({
			challengeToken: `v1.${'a'.repeat(24)}.${'b'.repeat(128)}`,
			slotHash: 'c'.repeat(64),
			reviewDraftHash: defaultHash,
			nonce: 'd'.repeat(32),
			issuedAt: 1_700_000_000,
			expiresAt: 1_700_000_300
		}),
		issuedAt: 1_700_000_000,
		expiresAt: 1_700_000_300,
		...overrides
	};
}

export function buildAttestationRequestFixture(
	overrides: Partial<AttestationRequest> = {}
): AttestationRequest {
	const signedReviewEvent = buildReviewSignedEventFixture();
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		reviewDraftHash: defaultHash,
		signedReviewEvent,
		challengeToken: `v1.${'a'.repeat(24)}.${'b'.repeat(128)}`,
		nostrChallengeSignature: 'e'.repeat(128),
		walletChallengeSignature: `0x${'f'.repeat(130)}`,
		subjectType: 'task',
		subjectId: 'task-123',
		settlementType: 'escrow',
		settlementId: 'escrow-123',
		chain: 'rsk',
		asset: 'rbtc',
		contractAddress: '0x123',
		reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
		revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
		reviewerWallet: '0xabc',
		revieweeWallet: '0xdef',
		...overrides
	};
}

export function buildAttestationSignedEventFixture(
	overrides: Partial<AttestationEventPayload> = {}
): {
	id: string;
	kind: number;
	pubkey: string;
	created_at: number;
	tags: string[][];
	content: string;
	sig: string;
} {
	const attestation = buildAttestationEventFixture(overrides);
	return {
		id: defaultAttestationId,
		kind: REVIEW_NOSTR_KINDS.ATTESTATION,
		pubkey: '1'.repeat(64),
		created_at: attestation.issuedAt,
		tags: [
			['e', attestation.reviewEventId],
			['d', attestation.reviewDraftHash]
		],
		content: JSON.stringify(attestation),
		sig: 'd'.repeat(128)
	};
}

export function buildAttestationEventFixture(
	overrides: Partial<AttestationEventPayload> = {}
): AttestationEventPayload {
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		reviewEventId: defaultAttestationId,
		reviewDraftHash: defaultHash,
		subjectType: 'task',
		settlementType: 'escrow',
		reviewerPubkey: '1'.repeat(64),
		revieweePubkey: defaultPubkey,
		reviewerRole: 'tasker',
		revieweeRole: 'taskee',
		contractOutcome: 'completed',
		issuedAt: 1_700_000_010,
		expiresAt: 1_700_000_310,
		keyId: 'issuer-v1',
		...overrides
	};
}

export function buildAttestationResponseFixture(
	overrides: Partial<AttestationResponse> = {}
): AttestationResponse {
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		status: 'ok',
		attestationEventId: defaultAttestationId,
		issuerPubkey: '1'.repeat(64),
		reviewDraftHash: defaultHash,
		issuedAt: 1_700_000_010,
		...overrides
	};
}

export function buildIssuerRegistryFixture(
	overrides: Partial<IssuerRegistryResponse> = {}
): IssuerRegistryResponse {
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		issuers: [
			{
				keyId: 'issuer-v1',
				pubkey: '1'.repeat(64),
				status: 'active',
				validFrom: 1_700_000_000,
				validUntil: 1_900_000_000
			}
		],
		...overrides
	};
}

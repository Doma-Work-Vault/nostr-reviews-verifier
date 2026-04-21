import { describe, expect, it } from 'vitest';
import {
	buildAttestationEventFixture,
	buildAttestationRequestFixture,
	buildAttestationResponseFixture,
	buildAttestationSignedEventFixture,
	buildChallengeResponseFixture,
	buildChallengeRequestFixture,
	buildReviewFixture,
	buildReviewReplyCandidateFixture,
	buildReviewReplyFixture,
	buildReviewReplySignedEventFixture,
	buildReviewSignedEventFixture,
	buildIssuerRegistryFixture
} from '../fixtures';
import {
	attestationEventPayloadSchema,
	attestationSignedEventSchema,
	attestationChallengeRequestSchema,
	attestationChallengeResponseSchema,
	attestationRequestSchema,
	attestationResponseSchema,
	issuerRegistryResponseSchema,
	reviewErrorResponseSchema,
	reviewEventPayloadSchema,
	reviewReplyCandidateSchema,
	reviewReplyEventPayloadSchema,
	reviewSignedEventSchema,
	reviewReplySignedEventSchema
} from '../schemas';
import {
	REVIEW_CHALLENGE_LIMITS,
	buildReviewAttestationChallengeMessage,
	computeReviewDraftHash,
	computeReviewDraftHashFromPayload,
	createCanonicalReviewDraftHashInput,
	isReplyAuthorAllowed,
	isReviewableBlockchainState,
	selectCanonicalReviewReply,
	verifyReviewDraftHash,
	reviewErrorCodeSchema
} from '../index';

describe('reviews contracts package', () => {
	it('validates canonical review payload fixtures', () => {
		expect(() => reviewEventPayloadSchema.parse(buildReviewFixture())).not.toThrow();
		expect(() => reviewReplyEventPayloadSchema.parse(buildReviewReplyFixture())).not.toThrow();
		expect(() =>
			reviewReplyCandidateSchema.parse(buildReviewReplyCandidateFixture())
		).not.toThrow();
		expect(() => reviewSignedEventSchema.parse(buildReviewSignedEventFixture())).not.toThrow();
		expect(() =>
			reviewReplySignedEventSchema.parse(buildReviewReplySignedEventFixture())
		).not.toThrow();
		expect(() => attestationEventPayloadSchema.parse(buildAttestationEventFixture())).not.toThrow();
		expect(() =>
			attestationSignedEventSchema.parse(buildAttestationSignedEventFixture())
		).not.toThrow();
		expect(() => attestationRequestSchema.parse(buildAttestationRequestFixture())).not.toThrow();
		expect(() => attestationResponseSchema.parse(buildAttestationResponseFixture())).not.toThrow();
		expect(() =>
			reviewErrorResponseSchema.parse({
				schemaVersion: 1,
				status: 'error',
				code: 'rate_limited',
				message: 'Retry later',
				retryAfterSeconds: 60
			})
		).not.toThrow();
		expect(() => issuerRegistryResponseSchema.parse(buildIssuerRegistryFixture())).not.toThrow();
	});

	it('builds a deterministic challenge message', () => {
		expect(
			buildReviewAttestationChallengeMessage({
				challengeToken: `v1.${'a'.repeat(24)}.${'b'.repeat(128)}`,
				slotHash: 'c'.repeat(64),
				reviewDraftHash: 'a'.repeat(64),
				nonce: 'd'.repeat(32),
				issuedAt: 1,
				expiresAt: 2
			})
		).toContain(
			'review_draft_hash:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		);
	});

	it('builds a deterministic review hash input', async () => {
		const review = buildReviewFixture({
			reviewDraftHash: '0'.repeat(64)
		});
		const { reviewDraftHash: _ignore, ...forHash } = review;
		const first = createCanonicalReviewDraftHashInput(forHash);
		const second = createCanonicalReviewDraftHashInput(forHash);
		expect(first).toBe(second);
		expect(await computeReviewDraftHash(forHash)).toMatch(/^[a-f0-9]{64}$/);
	});

	it('recomputes the canonical review draft hash from a signed review payload shape', async () => {
		const review = buildReviewFixture({ reviewDraftHash: '0'.repeat(64) });
		const computedHash = await computeReviewDraftHashFromPayload(review);
		const canonicalReview = {
			...review,
			reviewDraftHash: computedHash
		};

		expect(await computeReviewDraftHashFromPayload(canonicalReview)).toBe(computedHash);
	});

	it('fails hash verification when the payload is tampered after hashing', async () => {
		const review = buildReviewFixture({ reviewDraftHash: '0'.repeat(64) });
		const computedHash = await computeReviewDraftHashFromPayload(review);
		const tamperedReview = {
			...review,
			reviewDraftHash: computedHash,
			content: {
				...review.content,
				en: { comment: 'This content changed after hashing.' }
			}
		};

		expect(await verifyReviewDraftHash(tamperedReview)).toBe(false);
	});

	it('rejects challenge schema drift and malformed attestation signatures', () => {
		expect(() =>
			attestationChallengeRequestSchema.parse(buildChallengeRequestFixture())
		).not.toThrow();
		expect(() =>
			attestationChallengeRequestSchema.parse(
				buildChallengeRequestFixture({
					schemaVersion: 1
				})
			)
		).not.toThrow();
		expect(() =>
			attestationRequestSchema.parse(
				buildAttestationRequestFixture({
					walletChallengeSignature: 'not-a-wallet-signature'
				})
			)
		).toThrow();
		expect(() =>
			attestationRequestSchema.parse(
				buildAttestationRequestFixture({
					challengeToken: `v1.${'a'.repeat(REVIEW_CHALLENGE_LIMITS.maxTokenLength)}.${'b'.repeat(128)}`
				})
			)
		).toThrow();
		expect(() =>
			attestationChallengeResponseSchema.parse(
				buildChallengeResponseFixture({
					challengeToken: `v1.${'a'.repeat(REVIEW_CHALLENGE_LIMITS.maxTokenLength)}.${'b'.repeat(128)}`
				})
			)
		).toThrow();
		expect(() => reviewErrorCodeSchema.parse('rate_limited')).not.toThrow();
		expect(() => reviewErrorCodeSchema.parse('attestation_rate_limited')).not.toThrow();
		expect(() => reviewErrorCodeSchema.parse('internal_error')).not.toThrow();
		expect(() =>
			reviewEventPayloadSchema.parse(
				buildReviewFixture({
					rating: {
						overallRating: 5,
						categoryRatings: {
							quality: 5,
							professionalism: 5,
							timeliness: 5
						}
					}
				})
			)
		).toThrow();
	});

	it('selects the earliest valid reply and rejects non-owner replies', () => {
		const winner = selectCanonicalReviewReply([
			buildReviewReplyCandidateFixture({ eventId: 'b'.repeat(64), createdAt: 20 }),
			buildReviewReplyCandidateFixture({ eventId: 'a'.repeat(64), createdAt: 10 }),
			buildReviewReplyCandidateFixture({ eventId: 'c'.repeat(64), createdAt: 10 })
		]);

		expect(winner?.eventId).toBe('a'.repeat(64));
		expect(isReplyAuthorAllowed('abc', 'abc')).toBe(true);
		expect(isReplyAuthorAllowed('abc', 'def')).toBe(false);
		expect(isReviewableBlockchainState('completed')).toBe(false);
		expect(isReviewableBlockchainState('cancelled')).toBe(false);
	});
});

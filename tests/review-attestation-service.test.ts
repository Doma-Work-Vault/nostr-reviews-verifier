import { describe, expect, it } from 'vitest';
import './issuer-registry.mock';
import { privateKeyToAccount } from 'viem/accounts';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { bytesToHex } from 'nostr-tools/utils';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
	REVIEW_NOSTR_KINDS,
	buildReviewFixture,
	computeReviewDraftHashFromPayload,
	type ReviewEventPayload
} from '@bittasker/reviews-contracts';
import {
	buildSettlementSlotHash,
	type ReviewableSettlementRecord
} from '../src/contracts';
import { MockReviewNostrPublisher, type ReviewNostrPublisher } from '../src/nostr-publisher';
import { ReviewApiError, ReviewAttestationService } from '../src/review-attestation-service';
import { createInMemoryReviewStateClient } from '../src/state';
import type { AttestationRequest } from '../src/contracts';

const TEST_RUNTIME_CONFIG = {
	challengeTtlMs: 900_000,
	attestationTtlMs: 86_400_000,
	rateLimitWindowSeconds: 600,
	challengeNpubLimit: 5,
	challengeIpLimit: 20,
	attestationNpubLimit: 3,
	attestationIpLimit: 10
};

function makeSettlement(): ReviewableSettlementRecord {
	return {
		subjectType: 'task',
		subjectId: 'task-123',
		settlementType: 'escrow',
		settlementId: 'escrow-123',
		chain: 'rsk',
		asset: 'rbtc',
		contractAddress: '0x0000000000000000000000000000000000000123',
		contractVersion: '1',
		reviewerRole: 'tasker',
		revieweeRole: 'taskee',
		reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
		revieweeNpub: 'npub1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
		reviewerWallet: '0x0000000000000000000000000000000000000aaa',
		revieweeWallet: '0x0000000000000000000000000000000000000bbb',
		blockchainState: 'funds_released',
		completedAt: 1700000000000,
		reviewableAt: 1700000001000,
		contractOutcome: 'completed',
		status: 'reviewable',
		sourceVisibility: 'public_present',
		sourcePresentation: {
			label: 'Task 123',
			href: 'https://example.com/task/123'
		},
		sourceRefs: {
			escrowId: 'escrow-123'
		}
	};
}

class DeferredPublisher implements ReviewNostrPublisher {
	publishedEvents: Array<{ id: string }> = [];
	started: Promise<void>;
	private readonly publishGate: Promise<void>;
	private resolveStarted!: () => void;
	private resolvePublish!: () => void;

	constructor() {
		this.started = new Promise((resolve) => {
			this.resolveStarted = resolve;
		});
		this.publishGate = new Promise((resolve) => {
			this.resolvePublish = resolve;
		});
	}

	async publish(event: { id: string }): Promise<void> {
		this.resolveStarted();
		await this.publishGate;
		this.publishedEvents.push(event);
	}

	complete(): void {
		this.resolvePublish();
	}
}

class FlakyPublisher implements ReviewNostrPublisher {
	public readonly publishedEvents: Array<{ id: string }> = [];
	private attempts = 0;

	async publish(event: { id: string }): Promise<void> {
		this.attempts += 1;
		if (this.attempts === 1) {
			throw new Error('attestation_publish_failed');
		}

		this.publishedEvents.push(event);
	}
}

async function buildSignedReview(input: {
	reviewerSecret: Uint8Array;
	revieweePubkey: string;
	settlement: ReviewableSettlementRecord;
	overrides?: Partial<ReviewEventPayload>;
}) {
	const basePayload = buildReviewFixture({
		reviewDraftHash: '0'.repeat(64),
		subjectType: input.settlement.subjectType,
		settlementType: input.settlement.settlementType,
		revieweePubkey: input.revieweePubkey,
		reviewerRole: input.settlement.reviewerRole,
		revieweeRole: input.settlement.revieweeRole,
		contractOutcome: input.settlement.contractOutcome,
		createdAt: 1700000000,
		...input.overrides
	});
	const reviewDraftHash = await computeReviewDraftHashFromPayload(basePayload);
	const payload: ReviewEventPayload = {
		...basePayload,
		reviewDraftHash
	};
	const event = finalizeEvent(
		{
			kind: REVIEW_NOSTR_KINDS.REVIEW,
			created_at: payload.createdAt,
			tags: [],
			content: JSON.stringify(payload)
		},
		input.reviewerSecret
	);

	return {
		payload,
		event: event as AttestationRequest['signedReviewEvent']
	};
}

function buildService(options: { shouldFail?: boolean; publisher?: ReviewNostrPublisher; withIssuerConfig?: boolean } = {}) {
	const state = createInMemoryReviewStateClient();
	const settlement = makeSettlement();
	const reviewerPriv = generateSecretKey();
	const reviewerPubkey = getPublicKey(reviewerPriv);
	const revieweePubkey = getPublicKey(generateSecretKey());
	const reviewerWallet = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
	const issuerPriv = '0x' + '22'.repeat(32);
	const slotHmacSecret = new Uint8Array(Buffer.from(issuerPriv.replace(/^0x/, ''), 'hex'));
	const issuerPubkey = getPublicKey(new Uint8Array(Buffer.from(issuerPriv.replace(/^0x/, ''), 'hex')));
	const issuerNpub = npubEncode(issuerPubkey);
	const issuerNsec = nsecEncode(new Uint8Array(Buffer.from(issuerPriv.replace(/^0x/, ''), 'hex')));
	const publisher = options.publisher ?? new MockReviewNostrPublisher(options.shouldFail);
	const service = new ReviewAttestationService({
		state,
		settlementResolver: {
			resolve: () => ({
				...settlement,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address
			})
		},
		publisher,
		config: TEST_RUNTIME_CONFIG,
		slotHmacSecret,
		issuerRegistryEnv:
			options.withIssuerConfig === false
				? {}
				: {
						REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1',
						REVIEW_ATTESTATION_ISSUER_NSEC: issuerNsec,
						REVIEW_ATTESTATION_ISSUER_NPUB: issuerNpub
					},
		clock: () => 1700000000000
	});

	return {
		service,
		reviewerPriv,
		reviewerPubkey,
		revieweePubkey,
		reviewerWallet,
		settlement,
		issuerPubkey,
		slotHmacSecret,
		state,
		publisher
	};
}

describe('ReviewAttestationService', () => {
	it('derives stable slot identifiers with the same secret and different identifiers with another secret', () => {
		const settlement = makeSettlement();
		const firstSecret = new Uint8Array(Buffer.from('11'.repeat(32), 'hex'));
		const secondSecret = new Uint8Array(Buffer.from('22'.repeat(32), 'hex'));

		const first = buildSettlementSlotHash(settlement, firstSecret);
		const second = buildSettlementSlotHash(settlement, firstSecret);
		const rotated = buildSettlementSlotHash(settlement, secondSecret);

		expect(first).toBe(second);
		expect(rotated).not.toBe(first);
	});

	it('issues distinct challenge tokens for repeated requests on the same settlement slot', async () => {
		const { service, reviewerPubkey, revieweePubkey, reviewerWallet, settlement } = buildService();
		const baseRequest = {
			schemaVersion: 1 as const,
			reviewDraftHash: 'a'.repeat(64),
			subjectType: settlement.subjectType,
			subjectId: settlement.subjectId,
			settlementType: settlement.settlementType,
			settlementId: settlement.settlementId,
			chain: settlement.chain,
			asset: settlement.asset,
			contractAddress: settlement.contractAddress,
			reviewerNpub: reviewerPubkey,
			revieweeNpub: revieweePubkey,
			reviewerWallet: reviewerWallet.address,
			revieweeWallet: settlement.revieweeWallet!
		};

		const first = await service.createChallenge(baseRequest, { clientIp: '127.0.0.1', now: 1700000000000 });
		const second = await service.createChallenge(baseRequest, { clientIp: '127.0.0.1', now: 1700000001000 });
		expect(second.challengeToken).not.toBe(first.challengeToken);
		expect(second.challengeMessage).not.toBe(first.challengeMessage);
			expect(first.challengeMessage).toContain(baseRequest.reviewDraftHash);
			expect(second.challengeMessage).toContain(baseRequest.reviewDraftHash);
	});

	it('issues a fresh challenge when the same settlement slot requests a different reviewDraftHash', async () => {
		const { service, reviewerPubkey, revieweePubkey, reviewerWallet, settlement } = buildService();
		const baseRequest = {
			schemaVersion: 1 as const,
			subjectType: settlement.subjectType,
			subjectId: settlement.subjectId,
			settlementType: settlement.settlementType,
			settlementId: settlement.settlementId,
			chain: settlement.chain,
			asset: settlement.asset,
			contractAddress: settlement.contractAddress,
			reviewerNpub: reviewerPubkey,
			revieweeNpub: revieweePubkey,
			reviewerWallet: reviewerWallet.address,
			revieweeWallet: settlement.revieweeWallet!
		};

		const first = await service.createChallenge(
			{ ...baseRequest, reviewDraftHash: 'a'.repeat(64) },
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const second = await service.createChallenge(
			{ ...baseRequest, reviewDraftHash: 'b'.repeat(64) },
			{ clientIp: '127.0.0.1', now: 1700000001000 }
		);

		expect(second.challengeToken).not.toBe(first.challengeToken);
		expect(second.challengeMessage).toContain('b'.repeat(64));
	});

	it('rejects mismatched issuer npub and nsec configuration', async () => {
		const state = createInMemoryReviewStateClient();
		const settlement = makeSettlement();
		const publisher = new MockReviewNostrPublisher();
		const issuerPrivHex = '22'.repeat(32);
		const issuerPubkey = getPublicKey(new Uint8Array(Buffer.from(issuerPrivHex, 'hex')));
		const mismatchedPubkey = getPublicKey(generateSecretKey());
		const service = new ReviewAttestationService({
			state,
			settlementResolver: {
				resolve: () => settlement
			},
			publisher,
			config: TEST_RUNTIME_CONFIG,
			issuerRegistryEnv: {
				REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1',
				REVIEW_ATTESTATION_ISSUER_NSEC: nsecEncode(new Uint8Array(Buffer.from(issuerPrivHex, 'hex'))),
				REVIEW_ATTESTATION_ISSUER_NPUB: npubEncode(issuerPubkey),
				REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON: JSON.stringify([
					{
						keyId: 'reviews-attestation-issuer-v1',
						pubkey: mismatchedPubkey,
						status: 'active',
						validFrom: 0,
						validUntil: null
					}
				])
			},
			clock: () => 1700000000000
		});

		await expect(service.listIssuers()).rejects.toThrow(
			'Issuer npub does not match configured issuer npub'
		);
	});

	it('falls back to configured npub/nsec when issuer registry json is []', async () => {
		const state = createInMemoryReviewStateClient();
		const settlement = makeSettlement();
		const issuerPrivHex = '22'.repeat(32);
		const issuerNsec = nsecEncode(new Uint8Array(Buffer.from(issuerPrivHex, 'hex')));
		const issuerNpub = npubEncode(getPublicKey(new Uint8Array(Buffer.from(issuerPrivHex, 'hex'))));
		const service = new ReviewAttestationService({
			state,
			settlementResolver: {
				resolve: () => settlement
			},
			publisher: new MockReviewNostrPublisher(),
			config: TEST_RUNTIME_CONFIG,
			issuerRegistryEnv: {
				REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1',
				REVIEW_ATTESTATION_ISSUER_NSEC: issuerNsec,
				REVIEW_ATTESTATION_ISSUER_NPUB: issuerNpub,
				REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON: '[]'
			},
			clock: () => 1700000000000
		});

		await expect(service.listIssuers()).resolves.toMatchObject({
			issuers: [
				{
					keyId: 'reviews-attestation-issuer-v1',
					status: 'active',
					validFrom: 0,
					validUntil: null
				}
			]
		});
	});

	it('issues an attestation for a valid review and signatures', async () => {
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement, state, publisher, issuerPubkey, slotHmacSecret } =
			buildService();
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});

		const challenge = await service.createChallenge(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const challengeSig = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(challenge.challengeMessage)), reviewerPriv)
		);

		const result = await service.issueAttestation(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				signedReviewEvent: event,
				challengeToken: challenge.challengeToken,
				nostrChallengeSignature: challengeSig,
				walletChallengeSignature: await reviewerWallet.signMessage({
					message: challenge.challengeMessage
				}),
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);

		expect(result).toMatchObject({
			status: 'ok',
			reviewDraftHash: payload.reviewDraftHash,
			issuerPubkey
		});
		expect((publisher as MockReviewNostrPublisher).publishedEvents).toHaveLength(1);
		expect(JSON.parse((publisher as MockReviewNostrPublisher).publishedEvents[0].content)).toMatchObject({
			reviewEventId: event.id,
			reviewDraftHash: payload.reviewDraftHash
		});
		expect(await state.getIssuedSlot(buildSettlementSlotHash(settlement, slotHmacSecret))).toMatchObject({
			attestationEventId: result.attestationEventId,
			reviewDraftHash: payload.reviewDraftHash,
			reviewEventId: event.id
		});
	});

	it('rejects reviews whose canonical hash does not match the signed payload', async () => {
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement } = buildService();
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});
		const tamperedEvent = {
			...event,
			content: JSON.stringify({
				...payload,
				content: {
					...payload.content,
					en: { comment: 'Tampered after signing' }
				}
			})
		};

		const challenge = await service.createChallenge(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const challengeSig = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(challenge.challengeMessage)), reviewerPriv)
		);

		await expect(
			service.issueAttestation(
				{
					schemaVersion: 1,
					reviewDraftHash: payload.reviewDraftHash,
					signedReviewEvent: tamperedEvent,
					challengeToken: challenge.challengeToken,
					nostrChallengeSignature: challengeSig,
					walletChallengeSignature: await reviewerWallet.signMessage({
						message: challenge.challengeMessage
					}),
					subjectType: settlement.subjectType,
					subjectId: settlement.subjectId,
					settlementType: settlement.settlementType,
					settlementId: settlement.settlementId,
					chain: settlement.chain,
					asset: settlement.asset,
					contractAddress: settlement.contractAddress,
					reviewerNpub: reviewerPubkey,
					revieweeNpub: revieweePubkey,
					reviewerWallet: reviewerWallet.address,
					revieweeWallet: settlement.revieweeWallet!
				},
				{ clientIp: '127.0.0.1', now: 1700000000000 }
			)
		).rejects.toMatchObject({ code: 'review_event_invalid' });
	});

	it('finalizes the reservation before publish so a retry can republish the same attestation', async () => {
		const publisher = new FlakyPublisher();
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement, slotHmacSecret, state } =
			buildService({ publisher });
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});
		const slotHash = buildSettlementSlotHash(settlement, slotHmacSecret);

		const challenge = await service.createChallenge(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const challengeSig = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(challenge.challengeMessage)), reviewerPriv)
		);

		await expect(
			service.issueAttestation(
				{
					schemaVersion: 1,
					reviewDraftHash: payload.reviewDraftHash,
					signedReviewEvent: event,
					challengeToken: challenge.challengeToken,
					nostrChallengeSignature: challengeSig,
					walletChallengeSignature: await reviewerWallet.signMessage({
						message: challenge.challengeMessage
					}),
					subjectType: settlement.subjectType,
					subjectId: settlement.subjectId,
					settlementType: settlement.settlementType,
					settlementId: settlement.settlementId,
					chain: settlement.chain,
					asset: settlement.asset,
					contractAddress: settlement.contractAddress,
					reviewerNpub: reviewerPubkey,
					revieweeNpub: revieweePubkey,
					reviewerWallet: reviewerWallet.address,
					revieweeWallet: settlement.revieweeWallet!
				},
				{ clientIp: '127.0.0.1', now: 1700000000000 }
			)
		).rejects.toMatchObject({ code: 'attestation_publish_failed' });

		expect(await state.getIssuedSlot(slotHash)).toMatchObject({
			reviewDraftHash: payload.reviewDraftHash,
			reviewEventId: event.id
		});

		const retry = await service.issueAttestation(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				signedReviewEvent: event,
				challengeToken: challenge.challengeToken,
				nostrChallengeSignature: challengeSig,
				walletChallengeSignature: await reviewerWallet.signMessage({
					message: challenge.challengeMessage
				}),
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000001000 }
		);

		expect(retry).toMatchObject({
			status: 'ok',
			reviewDraftHash: payload.reviewDraftHash
		});
		expect(publisher.publishedEvents).toHaveLength(1);
		expect(await state.getIssuedSlot(slotHash)).toMatchObject({
			attestationEventId: retry.attestationEventId,
			reviewDraftHash: payload.reviewDraftHash,
			reviewEventId: event.id
		});
	});

	it('replays the same attestation for concurrent identical requests without creating a second slot', async () => {
		const publisher = new DeferredPublisher();
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement, slotHmacSecret, state } =
			buildService({ publisher });
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});
		const slotHash = buildSettlementSlotHash(settlement, slotHmacSecret);

		const challenge = await service.createChallenge(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const challengeSig = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(challenge.challengeMessage)), reviewerPriv)
		);
		const request = {
			schemaVersion: 1 as const,
			reviewDraftHash: payload.reviewDraftHash,
			signedReviewEvent: event,
			challengeToken: challenge.challengeToken,
			nostrChallengeSignature: challengeSig,
			walletChallengeSignature: await reviewerWallet.signMessage({
				message: challenge.challengeMessage
			}),
			subjectType: settlement.subjectType,
			subjectId: settlement.subjectId,
			settlementType: settlement.settlementType,
			settlementId: settlement.settlementId,
			chain: settlement.chain,
			asset: settlement.asset,
			contractAddress: settlement.contractAddress,
			reviewerNpub: reviewerPubkey,
			revieweeNpub: revieweePubkey,
			reviewerWallet: reviewerWallet.address,
			revieweeWallet: settlement.revieweeWallet!
		};

		const firstIssuance = service.issueAttestation(request, { clientIp: '127.0.0.1', now: 1700000000000 });
		await publisher.started;

		const secondIssuance = service.issueAttestation(request, { clientIp: '127.0.0.1', now: 1700000000000 });
		publisher.complete();
		const [firstResult, secondResult] = await Promise.all([firstIssuance, secondIssuance]);
		expect(firstResult.attestationEventId).toBe(secondResult.attestationEventId);
		expect(await state.getIssuedSlot(slotHash)).toMatchObject({
			attestationEventId: firstResult.attestationEventId,
			reviewDraftHash: payload.reviewDraftHash,
			reviewEventId: event.id
		});
	});

	it('rejects a fresh challenge after the slot has already been issued', async () => {
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement } =
			buildService();
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});

		const firstChallenge = await service.createChallenge(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const firstChallengeSig = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(firstChallenge.challengeMessage)), reviewerPriv)
		);
		const firstResult = await service.issueAttestation(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				signedReviewEvent: event,
				challengeToken: firstChallenge.challengeToken,
				nostrChallengeSignature: firstChallengeSig,
				walletChallengeSignature: await reviewerWallet.signMessage({
					message: firstChallenge.challengeMessage
				}),
				subjectType: settlement.subjectType,
				subjectId: settlement.subjectId,
				settlementType: settlement.settlementType,
				settlementId: settlement.settlementId,
				chain: settlement.chain,
				asset: settlement.asset,
				contractAddress: settlement.contractAddress,
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			},
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);

		await expect(
			service.createChallenge(
				{
					schemaVersion: 1,
					reviewDraftHash: payload.reviewDraftHash,
					subjectType: settlement.subjectType,
					subjectId: settlement.subjectId,
					settlementType: settlement.settlementType,
					settlementId: settlement.settlementId,
					chain: settlement.chain,
					asset: settlement.asset,
					contractAddress: settlement.contractAddress,
					reviewerNpub: reviewerPubkey,
					revieweeNpub: revieweePubkey,
					reviewerWallet: reviewerWallet.address,
					revieweeWallet: settlement.revieweeWallet!
				},
				{ clientIp: '127.0.0.1', now: 1700001000000 }
			)
		).rejects.toMatchObject({ code: 'duplicate_review_slot' });
		expect(firstResult.attestationEventId).toBeTruthy();
	});

	it('fails closed when issuer configuration is missing', async () => {
		const { service } = buildService({ withIssuerConfig: false });
		await expect(service.listIssuers()).rejects.toThrow(
			'Missing review attestation issuer npub/nsec configuration'
		);
	});
});

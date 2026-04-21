import { describe, expect, it, vi } from 'vitest';
import './issuer-registry.mock';
import { privateKeyToAccount } from 'viem/accounts';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { bytesToHex } from 'nostr-tools/utils';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
	REVIEW_CHALLENGE_LIMITS,
	REVIEW_NOSTR_KINDS,
	buildReviewFixture,
	computeReviewDraftHashFromPayload
} from '@bittasker/reviews-contracts';
import { createReviewsAttestationApp, type ReviewsAttestationEnv } from '../src/app';
import {
	createReviewChallengeToken,
	parseAndVerifyReviewChallengeToken,
	parseReviewChallengeTokenPayload
} from '../src/challenge-token';
import {
	buildSettlementSlotHash,
	type AttestationRequest,
	type ReviewableSettlementRecord
} from '../src/contracts';
import { MockReviewNostrPublisher, type ReviewNostrPublisher } from '../src/nostr-publisher';
import { ReviewAttestationService } from '../src/review-attestation-service';
import { createInMemoryReviewStateClient, type ReviewStateNamespace } from '../src/state';

const TEST_RUNTIME_CONFIG = {
	challengeTtlMs: 900_000,
	attestationTtlMs: 86_400_000,
	rateLimitWindowSeconds: 600,
	challengeNpubLimit: 5,
	challengeIpLimit: 20,
	attestationNpubLimit: 3,
	attestationIpLimit: 10
};

function makeSettlement(
	reviewerPubkey: string,
	revieweePubkey: string,
	reviewerWallet: string,
	overrides: Partial<ReviewableSettlementRecord> = {}
): ReviewableSettlementRecord {
	return {
		subjectType: 'task',
		subjectId: 'task-456',
		settlementType: 'escrow',
		settlementId: 'escrow-456',
		chain: 'rsk',
		asset: 'rbtc',
		contractAddress: '0x0000000000000000000000000000000000000456',
		contractVersion: '1',
		reviewerRole: 'tasker',
		revieweeRole: 'taskee',
		reviewerNpub: reviewerPubkey,
		revieweeNpub: revieweePubkey,
		reviewerWallet,
		revieweeWallet: '0x0000000000000000000000000000000000000ccc',
		blockchainState: 'funds_released',
		completedAt: 1700000000000,
		reviewableAt: 1700000001000,
		contractOutcome: 'completed',
		status: 'reviewable',
		sourceVisibility: 'public_present',
		sourcePresentation: {
			label: 'Task 456',
			href: 'https://example.com/task/456'
		},
		sourceRefs: {
			escrowId: 'escrow-456'
		},
		...overrides
	};
}

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
							return json(
								await state.checkRateLimit(body.bucketKey, body.limit, body.windowSeconds, body.now)
							);
						case '/slots/get':
							return json(await state.getIssuedSlot(body.slotHash));
						case '/slots/claim':
							return json(await state.claimIssuedSlot(body));
						default:
							return json({ error: 'not_found' }, 404);
					}
				}
			} as DurableObjectStub;
		}
	};
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json'
		}
	});
}

function makeChallengeSecret(challenge: Record<string, unknown>): string {
	const secret =
		(challenge.challengeMessage as string | undefined) ??
		(challenge.challengeToken as string | undefined) ??
		(challenge.token as string | undefined);
	if (!secret) {
		throw new Error('Expected challenge secret field');
	}

	return secret;
}

async function buildSignedReview(input: {
	reviewerSecret: Uint8Array;
	revieweePubkey: string;
	settlement: ReviewableSettlementRecord;
	overrides?: Partial<Parameters<typeof buildReviewFixture>[0]>;
}): Promise<{
	payload: Parameters<typeof buildReviewFixture>[0] & { reviewDraftHash: string };
	event: AttestationRequest['signedReviewEvent'];
}> {
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
	const payload = {
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
		event: event as unknown as AttestationRequest['signedReviewEvent']
	};
}

function buildService(options: {
	settlement?: ReviewableSettlementRecord;
	publisher?: ReviewNostrPublisher;
	issuerRegistryJson?: string;
	issuerValidFrom?: number;
	issuerValidUntil?: number | null;
	clock?: () => number;
} = {}) {
	const state = createInMemoryReviewStateClient();
	const reviewerPriv = generateSecretKey();
	const reviewerPubkey = getPublicKey(reviewerPriv);
	const revieweePubkey = getPublicKey(generateSecretKey());
	const reviewerWallet = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
	const issuerPrivHex = '22'.repeat(32);
	const slotHmacSecret = new Uint8Array(Buffer.from(issuerPrivHex, 'hex'));
	const issuerNsec = nsecEncode(new Uint8Array(Buffer.from(issuerPrivHex, 'hex')));
	const issuerPubkey = getPublicKey(new Uint8Array(Buffer.from(issuerPrivHex, 'hex')));
	const issuerNpub = npubEncode(issuerPubkey);
	const settlement =
		options.settlement ??
		makeSettlement(reviewerPubkey, revieweePubkey, reviewerWallet.address);
	const publisher = options.publisher ?? new MockReviewNostrPublisher();
	const service = new ReviewAttestationService({
		state,
		settlementRegistry: {
			resolve: () => settlement
		},
		publisher,
		config: TEST_RUNTIME_CONFIG,
		slotHmacSecret,
		issuerRegistryEnv: {
			REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1',
			REVIEW_ATTESTATION_ISSUER_NSEC: issuerNsec,
			REVIEW_ATTESTATION_ISSUER_NPUB: issuerNpub,
			REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON:
				options.issuerRegistryJson ??
				JSON.stringify([
					{
						keyId: 'reviews-attestation-issuer-v1',
						pubkey: issuerPubkey,
						status: 'active',
						validFrom: options.issuerValidFrom ?? 0,
						validUntil: options.issuerValidUntil ?? null
					}
				])
		},
		clock: options.clock ?? (() => 1700000000000)
	});

	return {
		service,
		state,
		settlement,
		reviewerPriv,
		reviewerPubkey,
		revieweePubkey,
		reviewerWallet,
		issuerPubkey,
		slotHmacSecret,
		publisher
	};
}

function buildChallengeRequest(params: {
	settlement: ReviewableSettlementRecord;
	reviewDraftHash: string;
	reviewerPubkey: string;
	revieweePubkey: string;
	reviewerWallet: string;
	revieweeWallet: string;
}) {
	return {
		schemaVersion: 1 as const,
		reviewDraftHash: params.reviewDraftHash,
		subjectType: params.settlement.subjectType,
		subjectId: params.settlement.subjectId,
		settlementType: params.settlement.settlementType,
		settlementId: params.settlement.settlementId,
		chain: params.settlement.chain,
		asset: params.settlement.asset,
		contractAddress: params.settlement.contractAddress,
		reviewerNpub: params.reviewerPubkey,
		revieweeNpub: params.revieweePubkey,
		reviewerWallet: params.reviewerWallet,
		revieweeWallet: params.revieweeWallet
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

describe('attestation worker hardening', () => {
	it('purges linkage material from state after a successful attestation', async () => {
		const { service, state, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement, slotHmacSecret } =
			buildService();
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});
		const slotHash = buildSettlementSlotHash(settlement, slotHmacSecret);
		const challenge = await service.createChallenge(
			buildChallengeRequest({
				settlement,
				reviewDraftHash: payload.reviewDraftHash,
				reviewerPubkey,
				revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			}),
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const challengeSecret = makeChallengeSecret(challenge as Record<string, unknown>);
		const challengeSig = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(challengeSecret)), reviewerPriv)
		);

		await service.issueAttestation(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				signedReviewEvent: event,
				challengeToken: challenge.challengeToken,
				nostrChallengeSignature: challengeSig,
				walletChallengeSignature: await reviewerWallet.signMessage({ message: challengeSecret }),
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

		const issued = await state.getIssuedSlot(slotHash);
		expect(issued).toMatchObject({
			slotHash,
			reviewDraftHash: payload.reviewDraftHash,
			reviewEventId: event.id
		});
		expect(JSON.stringify(issued)).not.toContain(reviewerWallet.address);
		expect(JSON.stringify(issued)).not.toContain(reviewerPubkey);
		expect(JSON.stringify(issued)).not.toContain(revieweePubkey);
		expect(JSON.stringify(issued)).not.toContain(settlement.contractAddress);
	});

	it('fails closed when the settlement record omits reviewer identity bindings', async () => {
		const reviewerPriv = generateSecretKey();
		const reviewerPubkey = getPublicKey(reviewerPriv);
		const revieweePubkey = getPublicKey(generateSecretKey());
		const reviewerWallet = privateKeyToAccount(('0x' + '33'.repeat(32)) as `0x${string}`);
		const { service, settlement } = buildService({
			settlement: makeSettlement(reviewerPubkey, revieweePubkey, reviewerWallet.address, {
				reviewerNpub: undefined,
				reviewerWallet: undefined
			})
		});

		await expect(
			service.createChallenge(
				buildChallengeRequest({
					settlement,
					reviewDraftHash: 'a'.repeat(64),
					reviewerPubkey,
					revieweePubkey,
					reviewerWallet: reviewerWallet.address,
					revieweeWallet: settlement.revieweeWallet!
				}),
				{ clientIp: '127.0.0.1', now: 1700000000000 }
			)
		).rejects.toMatchObject({ code: 'settlement_not_reviewable' });
	});

	it('rejects malformed Schnorr signatures as client input', async () => {
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement } =
			buildService();
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});

		const challenge = await service.createChallenge(
			buildChallengeRequest({
				settlement,
				reviewDraftHash: payload.reviewDraftHash,
				reviewerPubkey,
				revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			}),
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const challengeSecret = makeChallengeSecret(challenge as Record<string, unknown>);

		await expect(
			service.issueAttestation(
				{
					schemaVersion: 1,
					reviewDraftHash: payload.reviewDraftHash,
					signedReviewEvent: event,
					challengeToken: challenge.challengeToken,
					nostrChallengeSignature: 'aa',
					walletChallengeSignature: await reviewerWallet.signMessage({ message: challengeSecret }),
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
		).rejects.toMatchObject({ code: 'nostr_signature_invalid' });
	});

	it('rejects oversized and malformed challenge tokens defensively', () => {
		const issuerPrivHex = '22'.repeat(32);
		const issuerPubkey = getPublicKey(new Uint8Array(Buffer.from(issuerPrivHex, 'hex')));
		const oversizedToken = `v1.${'A'.repeat(REVIEW_CHALLENGE_LIMITS.maxTokenPayloadLength + 1)}.${'b'.repeat(128)}`;

		expect(() => parseReviewChallengeTokenPayload(oversizedToken)).toThrow('Malformed challenge token');
		expect(() => parseAndVerifyReviewChallengeToken(oversizedToken, issuerPubkey)).toThrow(
			'Malformed challenge token'
		);

		const malformedTokens = Array.from({ length: 32 }, (_, index) =>
			index % 4 === 0
				? `v1.${'!'.repeat(32)}.${'c'.repeat(128)}`
				: index % 4 === 1
					? `v1.${'A'.repeat(40)}.${'z'.repeat(64)}`
					: index % 4 === 2
						? `v1.${'A'.repeat(40)}.${'c'.repeat(128)}.extra`
						: 'v1..'
		);

		for (const token of malformedTokens) {
			expect(() => parseReviewChallengeTokenPayload(token)).toThrow();
		}

		const validToken = createReviewChallengeToken(
			{
				schemaVersion: 1,
				slotHash: 'a'.repeat(64),
				reviewDraftHash: 'b'.repeat(64),
				issuedAt: 1_700_000_000_000,
				expiresAt: 1_700_000_900_000,
				nonce: 'c'.repeat(32),
				keyId: 'issuer-v1'
			},
			issuerPrivHex
		);
		expect(() => parseAndVerifyReviewChallengeToken(validToken, issuerPubkey)).not.toThrow();
	});

	it('enforces issuer validity windows before minting', async () => {
		const future = 1700000100000;
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement } =
			buildService({
				issuerValidFrom: future,
				clock: () => 1700000000000
			});
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});

		await expect(
			(async () => {
				await service.createChallenge(
					buildChallengeRequest({
						settlement,
						reviewDraftHash: payload.reviewDraftHash,
						reviewerPubkey,
						revieweePubkey,
						reviewerWallet: reviewerWallet.address,
						revieweeWallet: settlement.revieweeWallet!
					}),
					{ clientIp: '127.0.0.1', now: 1700000000000 }
				);
			})()
		).rejects.toThrow(/not yet valid/i);

		const expired = 1700000000000;
		const { service: expiredService } = buildService({
			settlement,
			issuerValidUntil: expired,
			clock: () => 1700000100001
		});
		await expect(
			(async () => {
				await expiredService.createChallenge(
					buildChallengeRequest({
						settlement,
						reviewDraftHash: payload.reviewDraftHash,
						reviewerPubkey,
						revieweePubkey,
						reviewerWallet: reviewerWallet.address,
						revieweeWallet: settlement.revieweeWallet!
					}),
					{ clientIp: '127.0.0.1', now: 1700000100001 }
				);
			})()
		).rejects.toThrow(/expired/i);
	});

	it('honors configured TTLs and rate-limit windows from env', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1700000000000);

		try {
			const reviewerPriv = generateSecretKey();
			const reviewerPubkey = getPublicKey(reviewerPriv);
			const revieweePubkey = getPublicKey(generateSecretKey());
			const reviewerWallet = privateKeyToAccount(('0x' + '44'.repeat(32)) as `0x${string}`);
			const issuerPriv = '0x' + '55'.repeat(32);
			const issuerPubkey = getPublicKey(new Uint8Array(Buffer.from(issuerPriv.replace(/^0x/, ''), 'hex')));
			const issuerNpub = npubEncode(issuerPubkey);
			const issuerNsec = nsecEncode(new Uint8Array(Buffer.from(issuerPriv.replace(/^0x/, ''), 'hex')));
			const slotHmacSecret = new Uint8Array(Buffer.from(issuerPriv.replace(/^0x/, ''), 'hex'));
			const envState = createInMemoryReviewStateClient();
			const publisher = new MockReviewNostrPublisher();
			const env: ReviewsAttestationEnv = {
				REVIEW_STATE: createNamespace(envState),
				REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1',
				REVIEW_ATTESTATION_ISSUER_NSEC: issuerNsec,
				REVIEW_ATTESTATION_ISSUER_NPUB: issuerNpub,
				REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON: JSON.stringify([
					{
						keyId: 'reviews-attestation-issuer-v1',
						pubkey: issuerPubkey,
						status: 'active',
						validFrom: 0,
						validUntil: null
					}
				]),
				REVIEWS_SETTLEMENT_REGISTRY_JSON: JSON.stringify([
					makeSettlement(reviewerPubkey, revieweePubkey, reviewerWallet.address)
				]),
				REVIEW_ATTESTATION_NOSTR_RELAYS_JSON: JSON.stringify(['wss://relay.example']),
				REVIEW_CHALLENGE_TTL_SECONDS: '30',
				REVIEW_ATTESTATION_TTL_SECONDS: '45',
				REVIEW_RATE_LIMIT_WINDOW_SECONDS: '12'
			};
			const app = createReviewsAttestationApp(undefined, { publisher });

			const reviewPayload = buildReviewFixture({
				reviewDraftHash: '0'.repeat(64),
				subjectType: 'task',
				settlementType: 'escrow',
				revieweePubkey,
				reviewerRole: 'tasker',
				revieweeRole: 'taskee',
				contractOutcome: 'completed',
				createdAt: 1700000000000
			});
			const reviewDraftHash = await computeReviewDraftHashFromPayload(reviewPayload);
			const requestBody = {
				reviewDraftHash,
				subjectType: 'task',
				subjectId: 'task-456',
				settlementType: 'escrow',
				settlementId: 'escrow-456',
				chain: 'rsk' as const,
				asset: 'rbtc' as const,
				contractAddress: '0x0000000000000000000000000000000000000456',
				reviewerNpub: reviewerPubkey,
				revieweeNpub: revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: '0x0000000000000000000000000000000000000ccc'
			};

			const challengeResponse = await app.request(
				'/review-attestations/challenge',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(requestBody)
				},
				env
			);
			expect(challengeResponse.status).toBe(200);
			const challenge = (await challengeResponse.json()) as {
				challengeToken: string;
				challengeMessage: string;
				issuedAt: number;
				expiresAt: number;
			};
			expect(challenge.expiresAt - challenge.issuedAt).toBe(30_000);

			for (let i = 0; i < 4; i += 1) {
				const retry = await app.request(
					'/review-attestations/challenge',
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(requestBody)
					},
					env
				);
				expect(retry.status).toBe(200);
			}

			const limited = await app.request(
				'/review-attestations/challenge',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(requestBody)
				},
				env
			);
			expect(limited.status).toBe(429);
			const limitedBody = (await limited.json()) as { code: string; retryAfterSeconds: number };
			expect(limitedBody.code).toBe('rate_limited');
			expect(limitedBody.retryAfterSeconds).toBe(12);

			const reviewEvent = finalizeEvent(
				{
					kind: REVIEW_NOSTR_KINDS.REVIEW,
					created_at: 1700000000,
					tags: [],
					content: JSON.stringify({
						...reviewPayload,
						reviewDraftHash
					})
				},
				reviewerPriv
			);
			const challengeSecret = makeChallengeSecret(challenge);
			const attestationResponse = await app.request(
				'/review-attestations',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						schemaVersion: 1,
						reviewDraftHash,
						signedReviewEvent: reviewEvent,
						challengeToken: challenge.challengeToken,
						nostrChallengeSignature: bytesToHex(
							await schnorr.sign(sha256(utf8ToBytes(challengeSecret)), reviewerPriv)
						),
						walletChallengeSignature: await reviewerWallet.signMessage({
							message: challengeSecret
						}),
						subjectType: 'task',
						subjectId: 'task-456',
						settlementType: 'escrow',
						settlementId: 'escrow-456',
						chain: 'rsk',
						asset: 'rbtc',
						contractAddress: '0x0000000000000000000000000000000000000456',
						reviewerNpub: reviewerPubkey,
						revieweeNpub: revieweePubkey,
						reviewerWallet: reviewerWallet.address,
						revieweeWallet: '0x0000000000000000000000000000000000000ccc'
					})
				},
				env
			);
			expect(attestationResponse.status).toBe(200);
			const attestation = (await attestationResponse.json()) as { attestationEventId: string };
			expect(attestation.attestationEventId).toBeTruthy();
			expect(await envState.getIssuedSlot(buildSettlementSlotHash(makeSettlement(reviewerPubkey, revieweePubkey, reviewerWallet.address), slotHmacSecret))).toMatchObject({
				reviewDraftHash
			});
			expect(publisher.publishedEvents).toHaveLength(1);
			const attestationPayload = JSON.parse(publisher.publishedEvents[0].content) as {
				issuedAt: number;
				expiresAt: number;
			};
			expect(attestationPayload.expiresAt - attestationPayload.issuedAt).toBe(45_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects concurrent duplicate claims for the same slot at the state layer', async () => {
		const state = createInMemoryReviewStateClient();
		const slotHash = 'a'.repeat(64);
		const first = {
			slotHash,
			reviewDraftHash: '1'.repeat(64),
			reviewEventId: 'review-event-1',
			attestationEventId: 'attestation-event-1',
			issuedAt: 1700000000000
		};
		const second = {
			...first,
			attestationEventId: 'attestation-event-2'
		};

		const [firstResult, secondResult] = await Promise.all([
			state.claimIssuedSlot(first),
			state.claimIssuedSlot(second)
		]);

		expect([firstResult.created, secondResult.created].filter(Boolean)).toHaveLength(1);
		expect(await state.getIssuedSlot(slotHash)).toMatchObject(first);
	});

	it('rejects a fresh challenge for a slot once a review has been issued', async () => {
		const { service, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet, settlement } =
			buildService();
		const { payload, event } = await buildSignedReview({
			reviewerSecret: reviewerPriv,
			revieweePubkey,
			settlement
		});

		const challenge = await service.createChallenge(
			buildChallengeRequest({
				settlement,
				reviewDraftHash: payload.reviewDraftHash,
				reviewerPubkey,
				revieweePubkey,
				reviewerWallet: reviewerWallet.address,
				revieweeWallet: settlement.revieweeWallet!
			}),
			{ clientIp: '127.0.0.1', now: 1700000000000 }
		);
		const challengeSecret = makeChallengeSecret(challenge as Record<string, unknown>);
		const challengeSig = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(challengeSecret)), reviewerPriv)
		);

		await service.issueAttestation(
			{
				schemaVersion: 1,
				reviewDraftHash: payload.reviewDraftHash,
				signedReviewEvent: event,
				challengeToken: challenge.challengeToken,
				nostrChallengeSignature: challengeSig,
				walletChallengeSignature: await reviewerWallet.signMessage({ message: challengeSecret }),
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
				buildChallengeRequest({
					settlement,
					reviewDraftHash: 'b'.repeat(64),
					reviewerPubkey,
					revieweePubkey,
					reviewerWallet: reviewerWallet.address,
					revieweeWallet: settlement.revieweeWallet!
				}),
				{ clientIp: '127.0.0.1', now: 1700000001000 }
			)
		).rejects.toMatchObject({ code: 'duplicate_review_slot' });
	});
});

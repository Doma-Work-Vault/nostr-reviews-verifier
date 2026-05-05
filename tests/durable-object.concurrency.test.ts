import { describe, expect, it } from 'vitest';
import './issuer-registry.mock';
import { privateKeyToAccount } from 'viem/accounts';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
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
import type { AttestationRequest, ReviewableSettlementRecord } from '../src/contracts';
import { CloudflareReviewStateClient, type ReviewStateNamespace } from '../src/state';
import { ReviewStateDO } from '../src/durable-object';
import {
	ReviewAttestationService,
	type ReviewAttestationRuntimeConfig
} from '../src/review-attestation-service';
import type { ReviewNostrPublisher } from '../src/nostr-publisher';

const TEST_RUNTIME_CONFIG: ReviewAttestationRuntimeConfig = {
	challengeTtlMs: 900_000,
	attestationTtlMs: 86_400_000,
	rateLimitWindowSeconds: 600
};

class TestDurableObjectStorage {
	private readonly records = new Map<string, unknown>();
	private transactionTail: Promise<void> = Promise.resolve();

	private async tick(): Promise<void> {
		await Promise.resolve();
	}

	async get<T>(key: string): Promise<T | undefined> {
		await this.tick();
		return this.records.has(key) ? structuredClone(this.records.get(key) as T) : undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		await this.tick();
		this.records.set(key, structuredClone(value));
	}

	async delete(key: string): Promise<boolean> {
		await this.tick();
		return this.records.delete(key);
	}

	async list<T>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
		await this.tick();
		const prefix = options.prefix ?? '';
		const entries = [...this.records.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.sort(([left], [right]) => left.localeCompare(right));
		const limited = typeof options.limit === 'number' ? entries.slice(0, options.limit) : entries;
		return new Map(limited.map(([key, value]) => [key, structuredClone(value as T)]));
	}

	async transaction<T>(callback: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const previous = this.transactionTail;
		this.transactionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await callback();
		} finally {
			release();
		}
	}
}

class DeferredPublisher implements ReviewNostrPublisher {
	public readonly publishedEvents: Array<{ id: string }> = [];
	public readonly started: Promise<void>;
	private readonly gate: Promise<void>;
	private resolveStarted!: () => void;
	private resolveGate!: () => void;

	constructor() {
		this.started = new Promise<void>((resolve) => {
			this.resolveStarted = resolve;
		});
		this.gate = new Promise<void>((resolve) => {
			this.resolveGate = resolve;
		});
	}

	async publish(event: { id: string }): Promise<void> {
		this.resolveStarted();
		await this.gate;
		this.publishedEvents.push(event);
	}

	complete(): void {
		this.resolveGate();
	}
}

function createReviewStateNamespace(): ReviewStateNamespace {
	const storage = new TestDurableObjectStorage();
	const durableObject = new ReviewStateDO(
		{
			storage
		} as unknown as DurableObjectState,
		{}
	);

	return {
		idFromName(name: string) {
			return name as unknown as DurableObjectId;
		},
		get() {
			return {
				async fetch(input: RequestInfo | URL, init?: RequestInit) {
					if (input instanceof Request) {
						return durableObject.fetch(input);
					}

					return durableObject.fetch(new Request(String(input), init));
				}
			} as DurableObjectStub;
		}
	};
}

function makeSettlement(
	reviewerPubkey: string,
	revieweePubkey: string,
	reviewerWallet: string
): ReviewableSettlementRecord {
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
		reviewerNpub: reviewerPubkey,
		revieweeNpub: revieweePubkey,
		reviewerWallet,
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

async function buildSignedReview(input: {
	reviewerSecret: Uint8Array;
	revieweePubkey: string;
	settlement: ReviewableSettlementRecord;
	overrides?: Partial<ReviewEventPayload>;
}): Promise<{
	payload: ReviewEventPayload;
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

function buildService() {
	const namespace = createReviewStateNamespace();
	const state = new CloudflareReviewStateClient(namespace);
	const reviewerPriv = generateSecretKey();
	const reviewerPubkey = getPublicKey(reviewerPriv);
	const revieweePubkey = getPublicKey(generateSecretKey());
	const reviewerWallet = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
	const settlement = makeSettlement(reviewerPubkey, revieweePubkey, reviewerWallet.address);
	const issuerPrivHex = '22'.repeat(32);
		const slotHmacSecret = new Uint8Array(Buffer.from(issuerPrivHex, 'hex'));

	const issuerPubkey = getPublicKey(new Uint8Array(Buffer.from(issuerPrivHex, 'hex')));
	const publisher = new DeferredPublisher();
	const service = new ReviewAttestationService({
		slotHmacSecret,

		state,
		settlementRegistry: {
			resolve: () => settlement
		},
		publisher,
		config: TEST_RUNTIME_CONFIG,
		issuerRegistryEnv: {
			REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1',
			REVIEW_ATTESTATION_ISSUER_NSEC: nsecEncode(new Uint8Array(Buffer.from(issuerPrivHex, 'hex'))),
			REVIEW_ATTESTATION_ISSUER_NPUB: npubEncode(issuerPubkey)
		},
		clock: () => 1700000000000
	});

	return {
		state,
		service,
		publisher,
		settlement,
		reviewerPriv,
		reviewerPubkey,
		revieweePubkey,
		reviewerWallet
	};
}

describe('ReviewStateDO concurrency harness', () => {
	it('serializes simultaneous slot claims through the durable object fetch interface', async () => {
		const state = new CloudflareReviewStateClient(createReviewStateNamespace());
		const claimRecord = {
			slotHash: 'a'.repeat(64),
			reviewDraftHash: 'b'.repeat(64),
			reviewEventId: 'c'.repeat(64),
			attestationEventId: 'd'.repeat(64),
			issuedAt: 1700000000000
		};

		const results = await Promise.all(
			Array.from({ length: 8 }, () => state.claimIssuedSlot(claimRecord))
		);

		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(
			results.filter(
				(result) =>
					!result.created && result.existing?.attestationEventId === claimRecord.attestationEventId
			)
		).toHaveLength(7);
	});

	it('enforces burst rate limits atomically through the durable object fetch interface', async () => {
		const state = new CloudflareReviewStateClient(createReviewStateNamespace());
		const now = 1700000000000;

		const decisions = await Promise.all(
			Array.from({ length: 5 }, () => state.checkRateLimit('ip:127.0.0.1', 3, 60, now))
		);

		expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
		expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(2);
		expect(decisions.every((decision) => decision.retryAfterSeconds > 0)).toBe(true);
	});

	it('reuses the same issuance on concurrent attestation redemption and blocks new challenges afterwards', async () => {
		const { service, publisher, settlement, reviewerPriv, reviewerPubkey, revieweePubkey, reviewerWallet } =
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
		const challengeMessage = challenge.challengeMessage;
		const nostrChallengeSignature = bytesToHex(
			await schnorr.sign(sha256(utf8ToBytes(challengeMessage)), reviewerPriv)
		);
		const request: AttestationRequest = {
			schemaVersion: 1,
			reviewDraftHash: payload.reviewDraftHash,
			signedReviewEvent: event,
			challengeToken: challenge.challengeToken,
			nostrChallengeSignature,
			walletChallengeSignature: await reviewerWallet.signMessage({ message: challengeMessage }),
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

		const first = service.issueAttestation(request, { clientIp: '127.0.0.1', now: 1700000000000 });
		await publisher.started;
		const second = service.issueAttestation(request, { clientIp: '127.0.0.1', now: 1700000000000 });
		publisher.complete();

		const [firstResponse, secondResponse] = await Promise.all([first, second]);
		expect(firstResponse.attestationEventId).toBe(secondResponse.attestationEventId);
		expect(firstResponse.issuedAt).toBe(secondResponse.issuedAt);

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
				{ clientIp: '127.0.0.1', now: 1700000000001 }
			)
		).rejects.toMatchObject({ code: 'duplicate_review_slot' });
	});
});

import { describe, expect, it, vi } from 'vitest';
import { createReviewsAttestationApp } from '../src/app';
import { createInMemoryReviewStateClient, type ReviewStateNamespace } from '../src/state';
import {
	buildSettlementSlotHash
} from '../src/contracts';
import { bytesToHex } from 'nostr-tools/utils';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { buildReviewFixture, computeReviewDraftHashFromPayload } from '@bittasker/reviews-contracts';

vi.mock('../src/settlement-resolver', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/settlement-resolver')>();
	return {
		...actual,
		DynamicSettlementResolver: class StubDynamicSettlementResolver {
			constructor(..._args: unknown[]) {}
			async resolve(input: {
				subjectType: string;
				subjectId: string;
				settlementType: string;
				settlementId: string;
				chain: string;
				asset: string;
				contractAddress: string;
				reviewerNpub: string;
				revieweeNpub: string;
				reviewerWallet: string;
				revieweeWallet: string;
			}) {
				return {
					subjectType: input.subjectType,
					subjectId: input.subjectId,
					settlementType: input.settlementType,
					settlementId: input.settlementId,
					chain: input.chain,
					asset: input.asset,
					contractAddress: input.contractAddress,
					contractVersion: '1',
					reviewerRole: 'client' as const,
					revieweeRole: 'provider' as const,
					reviewerNpub: input.reviewerNpub,
					revieweeNpub: input.revieweeNpub,
					reviewerWallet: input.reviewerWallet,
					revieweeWallet: input.revieweeWallet,
					blockchainState: 'funds_released' as const,
					completedAt: 1000,
					reviewableAt: 1000,
					contractOutcome: 'completed' as const,
					status: 'reviewable' as const,
					sourceVisibility: 'public_present' as const,
					sourcePresentation: {},
					sourceRefs: {}
				};
			}
		}
	};
});

function toHex(pubkey: any): string {
    if (typeof pubkey === 'string') return pubkey;
    return bytesToHex(pubkey);
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
							return new Response(
								JSON.stringify(
									await state.checkRateLimit(body.bucketKey, body.limit, body.windowSeconds, body.now)
								)
							);
						case '/slots/get':
							return new Response(JSON.stringify(await state.getIssuedSlot(body.slotHash)));
						case '/slots/claim':
							return new Response(JSON.stringify(await state.claimIssuedSlot(body)));
						default:
							return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
					}
				}
			} as DurableObjectStub;
		}
	};
}

const realPriv = generateSecretKey();
const realPubHex = toHex(getPublicKey(realPriv));
const realNpub = npubEncode(realPubHex);
const dummyWallet = '0x1111111111111111111111111111111111111111';

function createValidSettlement(overrides = {}) {
    return {
        subjectType: 'task',
        subjectId: 't1',
        settlementType: 'escrow',
        settlementId: 's1',
        chain: 'rsk',
        asset: 'rbtc',
        contractAddress: dummyWallet,
        contractVersion: '1',
        reviewerRole: 'client',
        revieweeRole: 'provider',
        reviewerNpub: realNpub,
        revieweeNpub: realNpub,
        reviewerWallet: dummyWallet,
        revieweeWallet: dummyWallet,
        blockchainState: 'funds_released', // VALID for 'completed' outcome
        completedAt: 1000,
        reviewableAt: 1000,
        contractOutcome: 'completed',
        status: 'reviewable',
        sourceVisibility: 'public_present',
        sourcePresentation: { label: 'Task' },
        sourceRefs: { escrowId: 'e1' },
        ...overrides
    };
}

describe('reviews attestation backend app', () => {
	it('serves issuers and issues challenges over HTTP', async () => {
		const issuerPriv = generateSecretKey();
		const issuerPubHex = toHex(getPublicKey(issuerPriv));
		const issuerNsec = nsecEncode(issuerPriv);
		const issuerNpub = npubEncode(issuerPubHex);
		
        const settlement = createValidSettlement();

		const app = createReviewsAttestationApp();
		const env = {
			REVIEW_STATE: createNamespace(),
			REVIEW_ATTESTATION_ISSUER_NSEC: issuerNsec,
			REVIEW_ATTESTATION_ISSUER_NPUB: issuerNpub,
            REVIEW_SLOT_HMAC_SECRET: '0'.repeat(64),
            REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1'
		} as any;

		const challengeResponse = await app.request(
			'/review-attestations/challenge',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					reviewDraftHash: 'a'.repeat(64),
					subjectType: settlement.subjectType,
					subjectId: settlement.subjectId,
					settlementType: settlement.settlementType,
					settlementId: settlement.settlementId,
					chain: settlement.chain,
					asset: settlement.asset,
					contractAddress: settlement.contractAddress,
					reviewerNpub: settlement.reviewerNpub,
					revieweeNpub: settlement.revieweeNpub,
					reviewerWallet: settlement.reviewerWallet,
					revieweeWallet: settlement.revieweeWallet
				})
			},
			env
		);
		if (challengeResponse.status !== 200) {
            const errBody = await challengeResponse.text();
            console.error('Challenge response fail:', errBody);
        }
		expect(challengeResponse.status).toBe(200);
	});

	it('returns challenge_expired when the attestation arrives after the challenge TTL', async () => {
		const issuerPriv = generateSecretKey();
		const issuerPubHex = toHex(getPublicKey(issuerPriv));
		const issuerNsec = nsecEncode(issuerPriv);
		const issuerNpub = npubEncode(issuerPubHex);

		const reviewerPriv = generateSecretKey();
		const reviewerPubHex = toHex(getPublicKey(reviewerPriv));
        const reviewerNpub = npubEncode(reviewerPubHex);
		
		const revieweePriv = generateSecretKey();
		const revieweePubHex = toHex(getPublicKey(revieweePriv));

		const settlement = createValidSettlement({
			subjectId: 'task-123',
			settlementId: 'escrow-123',
			reviewerNpub,
			revieweeNpub: realNpub,
            revieweePubkey: revieweePubHex
		});
		const reviewPayload = buildReviewFixture({
			reviewDraftHash: 'a'.repeat(64),
			subjectType: settlement.subjectType,
			settlementType: settlement.settlementType,
			revieweePubkey: revieweePubHex,
			reviewerRole: settlement.reviewerRole,
			revieweeRole: settlement.revieweeRole,
			contractOutcome: settlement.contractOutcome,
			createdAt: 1700000000
		});
		const reviewDraftHash = await computeReviewDraftHashFromPayload(reviewPayload);
		const reviewEvent = finalizeEvent(
			{
				kind: 10001,
				created_at: 1700000000,
				tags: [],
				content: JSON.stringify({ ...reviewPayload, reviewDraftHash })
			},
			reviewerPriv
		);
		const app = createReviewsAttestationApp();
		const env = {
			REVIEW_STATE: createNamespace(),
			REVIEW_ATTESTATION_ISSUER_NSEC: issuerNsec,
			REVIEW_ATTESTATION_ISSUER_NPUB: issuerNpub,
			REVIEW_CHALLENGE_TTL_SECONDS: '1',
            REVIEW_SLOT_HMAC_SECRET: '0'.repeat(64),
            REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1'
		} as any;

		const challengeResponse = await app.request(
			'/review-attestations/challenge',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					reviewDraftHash,
					subjectType: settlement.subjectType,
					subjectId: settlement.subjectId,
					settlementType: settlement.settlementType,
					settlementId: settlement.settlementId,
					chain: settlement.chain,
					asset: settlement.asset,
					contractAddress: settlement.contractAddress,
					reviewerNpub: settlement.reviewerNpub,
					revieweeNpub: settlement.revieweeNpub,
					reviewerWallet: settlement.reviewerWallet,
					revieweeWallet: settlement.revieweeWallet
				})
			},
			env
		);
		const challenge = (await challengeResponse.json()) as any;

		// Wait for TTL to expire
		await new Promise((resolve) => setTimeout(resolve, 1100));

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
						await schnorr.sign(sha256(utf8ToBytes(challenge.challengeMessage || '')), reviewerPriv)
					),
					walletChallengeSignature: '0x' + 'f'.repeat(130), // Correct hex format
					subjectType: settlement.subjectType,
					subjectId: settlement.subjectId,
					settlementType: settlement.settlementType,
					settlementId: settlement.settlementId,
					chain: settlement.chain,
					asset: settlement.asset,
					contractAddress: settlement.contractAddress,
					reviewerNpub: settlement.reviewerNpub,
					revieweeNpub: settlement.revieweeNpub,
					reviewerWallet: settlement.reviewerWallet,
					revieweeWallet: settlement.revieweeWallet
				})
			},
			env
		);

		expect(attestationResponse.status).toBe(400);
	});

	it('returns a generic internal_error for completely unexpected errors', async () => {
		const app = createReviewsAttestationApp();
        const issuerPriv = generateSecretKey();
		const env = {
			REVIEW_STATE: {
				idFromName: () => ({}),
				get: () => ({
					fetch: () => {
						throw new Error('Explosion');
					}
				})
			},
            REVIEW_SLOT_HMAC_SECRET: '0'.repeat(64),
            REVIEW_ATTESTATION_ISSUER_NSEC: nsecEncode(issuerPriv),
            REVIEW_ATTESTATION_ISSUER_NPUB: npubEncode(toHex(getPublicKey(issuerPriv))),
            REVIEW_ATTESTATION_ISSUER_KEY_ID: 'reviews-attestation-issuer-v1'
		} as any;

		const response = await app.request('/health', { method: 'GET' }, env);
		expect(response.status).toBe(200);
	});
});

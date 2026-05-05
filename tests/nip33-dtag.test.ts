import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { REVIEW_ATTESTATION_KIND, buildSettlementSlotHash } from '../src/contracts';
import type { ReviewableSettlementRecord, AttestationEventPayload } from '../src/contracts';
import { utf8ToBytes } from '@noble/hashes/utils';

/**
 * NIP-33 compliance: the `d` tag MUST be the `slotHash` (stable per settlement),
 * NOT `reviewDraftHash` (which changes with review content).
 *
 * This test verifies that the attestation event uses `slotHash` as the `d` tag
 * so that NIP-33 clients can query by settlement slot.
 */
describe('NIP-33 d-tag compliance', () => {
	it('uses slotHash as d-tag in attestation events', () => {
		const issuerPriv = generateSecretKey();
		const issuerPub = getPublicKey(issuerPriv);
		const slotHmacSecret = utf8ToBytes('test-secret-at-least-32-chars-long!!');

		const settlement: ReviewableSettlementRecord = {
			subjectType: 'task',
			subjectId: 'task-1',
			settlementType: 'escrow',
			settlementId: 'escrow-1',
			chain: 'rsk',
			asset: 'rbtc',
			contractAddress: '0x1234000000000000000000000000000000000001',
			contractVersion: '2',
			reviewerRole: 'tasker',
			revieweeRole: 'taskee',
			reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
			revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222',
			blockchainState: 'funds_released',
			completedAt: 1700000000,
			reviewableAt: 1700000100,
			contractOutcome: 'completed',
			status: 'reviewable',
			sourceVisibility: 'public_present',
			sourcePresentation: {},
			sourceRefs: {}
		};

		const slotHash = buildSettlementSlotHash(settlement, slotHmacSecret);
		const reviewDraftHash = 'a'.repeat(64);
		const reviewEventId = 'b'.repeat(64);
		const reviewerPubkey = bytesToHex(generateSecretKey());
		const revieweePubkey = bytesToHex(generateSecretKey());

		const payload: AttestationEventPayload = {
			schemaVersion: 1,
			reviewEventId,
			reviewDraftHash,
			subjectType: 'task',
			settlementType: 'escrow',
			reviewerPubkey,
			revieweePubkey,
			reviewerRole: 'tasker',
			revieweeRole: 'taskee',
			contractOutcome: 'completed',
			issuedAt: 1700000000000,
			expiresAt: 1700086400000,
			keyId: 'issuer-v1'
		};

		const event = finalizeEvent(
			{
				kind: REVIEW_ATTESTATION_KIND,
				created_at: Math.floor(1700000000),
				tags: [
					['e', reviewEventId],
					['d', slotHash],
					['p', reviewerPubkey],
					['p', revieweePubkey],
					['subject', 'task'],
					['settlement', 'escrow']
				],
				content: JSON.stringify(payload)
			},
			issuerPriv
		);

		// Verify the d tag is the slotHash
		const dTag = event.tags.find((t: string[]) => t[0] === 'd');
		expect(dTag).toBeDefined();
		expect(dTag![1]).toBe(slotHash);
		expect(dTag![1]).not.toBe(reviewDraftHash);
	});

	it('slotHash is stable for the same settlement material', () => {
		const slotHmacSecret = utf8ToBytes('test-secret-at-least-32-chars-long!!');

		const settlement: ReviewableSettlementRecord = {
			subjectType: 'task',
			subjectId: 'task-1',
			settlementType: 'escrow',
			settlementId: 'escrow-1',
			chain: 'rsk',
			asset: 'rbtc',
			contractAddress: '0x1234000000000000000000000000000000000001',
			contractVersion: '2',
			reviewerRole: 'tasker',
			revieweeRole: 'taskee',
			reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
			revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222',
			blockchainState: 'funds_released',
			completedAt: 1700000000,
			reviewableAt: 1700000100,
			contractOutcome: 'completed',
			status: 'reviewable',
			sourceVisibility: 'public_present',
			sourcePresentation: {},
			sourceRefs: {}
		};

		const hash1 = buildSettlementSlotHash(settlement, slotHmacSecret);
		const hash2 = buildSettlementSlotHash(settlement, slotHmacSecret);

		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(/^[a-f0-9]{64}$/);
	});

	it('slotHash changes with different settlement material', () => {
		const slotHmacSecret = utf8ToBytes('test-secret-at-least-32-chars-long!!');

		const settlement1: ReviewableSettlementRecord = {
			subjectType: 'task',
			subjectId: 'task-1',
			settlementType: 'escrow',
			settlementId: 'escrow-1',
			chain: 'rsk',
			asset: 'rbtc',
			contractAddress: '0x1234000000000000000000000000000000000001',
			contractVersion: '2',
			reviewerRole: 'tasker',
			revieweeRole: 'taskee',
			reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
			revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222',
			blockchainState: 'funds_released',
			completedAt: 1700000000,
			reviewableAt: 1700000100,
			contractOutcome: 'completed',
			status: 'reviewable',
			sourceVisibility: 'public_present',
			sourcePresentation: {},
			sourceRefs: {}
		};

		const settlement2 = { ...settlement1, settlementId: 'escrow-2' };

		const hash1 = buildSettlementSlotHash(settlement1, slotHmacSecret);
		const hash2 = buildSettlementSlotHash(settlement2, slotHmacSecret);

		expect(hash1).not.toBe(hash2);
	});
});

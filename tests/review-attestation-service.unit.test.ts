import { describe, expect, it, vi } from 'vitest';
import { ReviewAttestationService, ReviewApiError } from '../src/review-attestation-service';
import { createInMemoryReviewStateClient } from '../src/state';
import { MockReviewNostrPublisher } from '../src/nostr-publisher';
import { createReviewChallengeToken } from '../src/challenge-token';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { bytesToHex } from 'nostr-tools/utils';

// Helper to ensure we have a hex string
function toHex(pubkey: any): string {
    if (typeof pubkey === 'string') return pubkey;
    return bytesToHex(pubkey);
}

describe('ReviewAttestationService unit tests (edge cases)', () => {
	const setup = () => {
		const state = createInMemoryReviewStateClient();
		const priv = generateSecretKey();
		const pubHex = toHex(getPublicKey(priv));
		const nsec = nsecEncode(priv);
		const npub = npubEncode(pubHex);
		
		const service = new ReviewAttestationService({
			state,
			publisher: new MockReviewNostrPublisher(),
			settlementResolver: { resolve: () => null },
			config: {
				challengeTtlMs: 1000,
				attestationTtlMs: 1000,
				rateLimitWindowSeconds: 60
			},
			slotHmacSecret: new Uint8Array(32),
			issuerRegistryEnv: {
				REVIEW_ATTESTATION_ISSUER_NSEC: nsec,
				REVIEW_ATTESTATION_ISSUER_NPUB: npub,
				REVIEW_ATTESTATION_ISSUER_KEY_ID: 'test-key'
			},
			clock: () => 10000 // Fixed time
		});

		return { service, nsec, npub, pubHex, state, priv };
	};

	it('throws issuer_unavailable if nsec is missing', () => {
		const service = new ReviewAttestationService({
			state: createInMemoryReviewStateClient(),
			publisher: new MockReviewNostrPublisher(),
			settlementResolver: { resolve: () => null },
			config: { challengeTtlMs: 1000, attestationTtlMs: 1000, rateLimitWindowSeconds: 60 },
			slotHmacSecret: new Uint8Array(32),
			issuerRegistryEnv: {},
			clock: () => Date.now()
		});

		// @ts-expect-error
		expect(() => service.getIssuerPrivateKey()).toThrow('issuer_unavailable');
	});

	it('verifyChallengeToken throws for malformed token', () => {
		const { service } = setup();
		// @ts-expect-error
		expect(() => service.verifyChallengeToken('malformed', 'slot', 'hash', 10000)).toThrow('Malformed challenge token');
	});

	it('verifyChallengeToken throws for unknown issuer', () => {
		const { service, priv } = setup();
		const payload = { 
            schemaVersion: 1 as const,
            keyId: 'unknown-key',
            slotHash: '0'.repeat(64),
            reviewDraftHash: '0'.repeat(64),
            issuedAt: 1000,
            expiresAt: 2000,
            nonce: '0'.repeat(32)
        };
		const token = createReviewChallengeToken(payload, bytesToHex(priv));
		
		// @ts-expect-error
		vi.spyOn(service, 'getIssuerRegistryAt').mockReturnValue({ issuers: [] });
		
		// @ts-expect-error
		expect(() => service.verifyChallengeToken(token, 'slot', 'hash', 10000)).toThrow('Unknown challenge issuer');
	});

	it('verifyChallengeToken throws for expired challenge issuer', () => {
		const { service, priv } = setup();
		const payload = { 
            schemaVersion: 1 as const,
            keyId: 'test-key',
            slotHash: '0'.repeat(64),
            reviewDraftHash: '0'.repeat(64),
            issuedAt: 5000,
            expiresAt: 6000,
            nonce: '0'.repeat(32)
        };
		const token = createReviewChallengeToken(payload, bytesToHex(priv));
		
		// @ts-expect-error
		vi.spyOn(service, 'getIssuerRegistryAt').mockReturnValue({
			issuers: [{
				keyId: 'test-key',
				validUntil: 4000,
				validFrom: 0,
				pubkey: 'a'.repeat(64),
				status: 'active'
			}]
		});

		// @ts-expect-error
		expect(() => service.verifyChallengeToken(token, 'slot', 'hash', 10000)).toThrow('Challenge issuer expired');
	});

	it('throws participant_mismatch for incorrect reviewer npub', () => {
		const { service, npub } = setup();
		const otherPubHex = toHex(getPublicKey(generateSecretKey()));
		const otherNpub = npubEncode(otherPubHex);
		
		const settlement = {
			reviewerNpub: npub,
			revieweeNpub: npub,
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222'
		} as any;
		const input = {
			reviewerNpub: otherNpub,
			revieweeNpub: npub,
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222'
		} as any;

		// @ts-expect-error
		expect(() => service.assertInputMatchesSettlement(input, settlement)).toThrow('Reviewer pubkey does not match settlement');
	});

	it('throws settlement_not_reviewable when bindings are missing', () => {
		const { service } = setup();
		const settlement = { reviewerNpub: 'n1' } as any;
		// @ts-expect-error
		expect(() => service.assertSettlementBindings(settlement)).toThrow('Settlement is missing participant bindings');
	});
});

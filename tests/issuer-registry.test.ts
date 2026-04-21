import { describe, expect, it } from 'vitest';
import { getIssuerRegistry, getActiveIssuer } from '../src/issuer-registry';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';

describe('issuer registry unit tests', () => {
	const dummyPrivkey = generateSecretKey();
	const dummyPubkeyRaw = getPublicKey(dummyPrivkey);
	const dummyPubkeyHex = typeof dummyPubkeyRaw === 'string' ? dummyPubkeyRaw : bytesToHex(dummyPubkeyRaw);
	const dummyNpub = npubEncode(dummyPubkeyHex);
	const dummyNsec = nsecEncode(dummyPrivkey);
	const defaultKeyId = 'reviews-attestation-issuer-v1';
	const baseEnv = {
		REVIEW_ATTESTATION_ISSUER_NSEC: dummyNsec,
		REVIEW_ATTESTATION_ISSUER_NPUB: dummyNpub,
		REVIEW_ATTESTATION_ISSUER_KEY_ID: defaultKeyId
	};

	it('resolves registry from explicit JSON env', () => {
		const registryJson = JSON.stringify([
			{
				keyId: defaultKeyId,
				pubkey: dummyPubkeyHex,
				status: 'active',
				validFrom: 0,
				validUntil: 2000
			}
		]);
		const registry = getIssuerRegistry({
			...baseEnv,
			REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON: registryJson
		});
		expect(registry.issuers).toHaveLength(1);
		expect(registry.issuers[0].keyId).toBe(defaultKeyId);
	});

	it('resolves registry from individual env components', () => {
		const registry = getIssuerRegistry({
			...baseEnv
		});
		expect(registry.issuers).toHaveLength(1);
		expect(registry.issuers[0].keyId).toBe(defaultKeyId);
		expect(registry.issuers[0].pubkey).toBe(dummyPubkeyHex);
		expect(registry.issuers[0].status).toBe('active');
	});

	describe('getActiveIssuer', () => {
		it('picks the currently active issuer based on clock', () => {
			// NOTE: parseIssuerRegistry (in state.ts) has a limitation where the FIRST 'active' entry
			// in the JSON must match the configured keyId and pubkey in the environment.
			const registryJson = JSON.stringify([
				{
					keyId: defaultKeyId,
					pubkey: dummyPubkeyHex,
					status: 'active',
					validFrom: 1000,
					validUntil: 2000
				},
				{
					keyId: 'other-key',
					pubkey: 'a'.repeat(64),
					status: 'retired',
					validFrom: 0,
					validUntil: 500
				}
			]);
			const env = { ...baseEnv, REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON: registryJson };

			const active = getActiveIssuer({ ...env, clock: () => 1500 });
			expect(active.keyId).toBe(defaultKeyId);
			expect(active.pubkey).toBe(dummyPubkeyHex);
		});

		it('throws if no active issuer is found for the given time', () => {
			const registryJson = JSON.stringify([
				{
					keyId: defaultKeyId,
					pubkey: dummyPubkeyHex,
					status: 'active',
					validFrom: 1000,
					validUntil: 2000
				}
			]);
			const env = { ...baseEnv, REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON: registryJson };

			expect(() => getActiveIssuer({ ...env, clock: () => 500 })).toThrow('No active issuer available');
		});

		it('respects inactive status even if time matches', () => {
			// To test this we need a registry where the first 'active' one matches env,
			// but we want to find one that is NOT active.
			// Actually we can just have one entry that matches keyId but is retired.
			// Wait, parseIssuerRegistry will throw if it doesn't find ANY active one.
			
			const registryJson = JSON.stringify([
				{
					keyId: defaultKeyId,
					pubkey: dummyPubkeyHex,
					status: 'active',
					validFrom: 0,
					validUntil: 500 // Active by status, but expired by time
				}
			]);
			const env = { ...baseEnv, REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON: registryJson };

			expect(() => getActiveIssuer({ ...env, clock: () => 1000 })).toThrow('No active issuer available');
		});
	});
});

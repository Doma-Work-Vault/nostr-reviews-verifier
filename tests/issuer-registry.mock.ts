import { vi } from 'vitest';

vi.mock('../src/issuer-registry', async () => {
	const actualService = await vi.importActual<typeof import('../src/review-attestation-service')>(
		'../src/review-attestation-service'
	);
	const contracts = await vi.importActual<typeof import('../src/contracts')>('../src/contracts');

	function normalizePubkey(value: string): string {
		return contracts.parseHexOrNpub(value);
	}

	function buildIssuerRegistry(env: Record<string, string | undefined>) {
		const keyId = env.REVIEW_ATTESTATION_ISSUER_KEY_ID?.trim() || 'reviews-attestation-issuer-v1';
		const issuerNpub = env.REVIEW_ATTESTATION_ISSUER_NPUB?.trim();
		const issuerNsec = env.REVIEW_ATTESTATION_ISSUER_NSEC?.trim();

		if (!issuerNpub || !issuerNsec) {
			throw new Error('Missing review attestation issuer npub/nsec configuration');
		}

		const raw = env.REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?.trim();
		if (raw) {
			const parsed = JSON.parse(raw) as Array<{
				keyId: string;
				pubkey: string;
				status: 'active' | 'retired';
				validFrom: number;
				validUntil: number | null;
			}>;

			if (parsed.length === 0) {
				return {
					schemaVersion: 1 as const,
					issuers: [
						{
							keyId,
							pubkey: normalizePubkey(issuerNpub),
							status: 'active' as const,
							validFrom: 0,
							validUntil: null
						}
					]
				};
			}

			const active = parsed.find((entry) => entry.status === 'active');
			if (!active) {
				throw new Error('No active issuer available');
			}

			if (active.keyId !== keyId) {
				throw new Error('Active issuer keyId does not match configured issuer keyId');
			}

			if (normalizePubkey(active.pubkey) !== normalizePubkey(issuerNpub)) {
				throw new Error('Issuer npub does not match configured issuer npub');
			}

			return {
				schemaVersion: 1 as const,
				issuers: parsed.map((entry) => ({
					...entry,
					pubkey: normalizePubkey(entry.pubkey)
				}))
			};
		}

		return {
			schemaVersion: 1 as const,
			issuers: [
				{
					keyId,
					pubkey: normalizePubkey(issuerNpub),
					status: 'active' as const,
					validFrom: 0,
					validUntil: null
				}
			]
		};
	}

	return {
		getIssuerRegistry(env: Record<string, string | undefined>) {
			return buildIssuerRegistry(env);
		},
		getActiveIssuer(env: Record<string, string | undefined> & { clock?: () => number }) {
			const registry = buildIssuerRegistry(env);
			const now = env.clock?.() ?? Date.now();
			const active = registry.issuers.find((entry) => entry.status === 'active');
			if (!active) {
				throw new Error('No active issuer available');
			}

			if (now < active.validFrom) {
				throw new actualService.ReviewApiError(
					'issuer_unavailable',
					503,
					'Active issuer is not yet valid'
				);
			}

			if (active.validUntil !== null && active.validUntil !== undefined && now > active.validUntil) {
				throw new actualService.ReviewApiError(
					'issuer_unavailable',
					503,
					'Active issuer has expired'
				);
			}

			return active;
		}
	};
});

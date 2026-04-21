import {
	issuerRegistryResponseSchema,
	type IssuerRegistryResponse
} from './contracts';
import { parseIssuerRegistry } from './state';

export function getIssuerRegistry(env: {
	REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?: string;
	REVIEW_ATTESTATION_ISSUER_KEY_ID?: string;
	REVIEW_ATTESTATION_ISSUER_NPUB?: string;
	REVIEW_ATTESTATION_ISSUER_NSEC?: string;
	clock?: () => number;
}): IssuerRegistryResponse {
	const registry = parseIssuerRegistry(env);
	return issuerRegistryResponseSchema.parse(registry);
}

export function getActiveIssuer(env: {
	REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?: string;
	REVIEW_ATTESTATION_ISSUER_KEY_ID?: string;
	REVIEW_ATTESTATION_ISSUER_NPUB?: string;
	REVIEW_ATTESTATION_ISSUER_NSEC?: string;
	clock?: () => number;
}) {
	const registry = getIssuerRegistry(env);
	const now = env.clock?.() ?? Date.now();
	const active = registry.issuers.find((entry) => {
		if (entry.status !== 'active') {
			return false;
		}

		if (now < entry.validFrom) {
			return false;
		}

		if (entry.validUntil !== null && entry.validUntil !== undefined && now > entry.validUntil) {
			return false;
		}

		return true;
	});
	if (!active) {
		throw new Error('No active issuer available');
	}

	return active;
}

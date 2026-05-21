/**
 * v1 legacy escrow: on-chain `getEscrow` stays at Completed (4) after payout; Kind 31006
 * carries FundsReleased (legacy `s`=10/11 on wire `v`=0.0.1, or canonical `s`=7).
 *
 * Mirrors BitTasker `deriveV1EffectiveContractStatus` + `legacyEscrowStatusToContractStatus`.
 */

/** Nostr Kind 31006 — contract status updates */
export const KIND_CONTRACT_STATUS = 31006;

/** Canonical {@link ContractStatus}.FundsReleased — reviewable after payout */
export const CANONICAL_FUNDS_RELEASED = 7;

/** On-chain legacy getEscrow Completed */
export const LEGACY_ONCHAIN_COMPLETED = 4;

const LEGACY_WIRE_VERSIONS = new Set(['v1', '0.0.1']);

export type NostrTagList = string[][];

export type NostrStatusEvent = {
	tags: NostrTagList;
	created_at?: number;
};

function tagValue(tags: NostrTagList, name: string): string | undefined {
	for (const tag of tags) {
		if (tag[0] === name && tag[1] !== undefined) {
			return tag[1];
		}
	}
	return undefined;
}

export function isLegacyContractStatusWireVersion(version: string | undefined): boolean {
	if (version === undefined || version === '') return false;
	return LEGACY_WIRE_VERSIONS.has(version);
}

/**
 * Map Kind 31006 `s` (+ optional legacy `v`) to canonical contract status 0–11.
 * Returns undefined when the tag cannot be interpreted.
 */
export function normalizeContractStatusFromTags(
	rawS: number,
	version: string | undefined,
	chainState?: number
): number | undefined {
	if (!Number.isInteger(rawS) || rawS < 0) return undefined;

	if (isLegacyContractStatusWireVersion(version)) {
		switch (rawS) {
			case 0:
				return 0; // Funded
			case 1:
				return 1; // InDispute
			case 2:
				return 2; // DisputeResolved
			case 3:
				return 3; // DisputeUnresolved
			case 4:
				return 4; // Completed
			case 5:
				return 5; // Cancelled
			case 6:
				return 0; // Funded
			case 7:
				return 10; // WorkInProgress
			case 8:
				return 4; // Completed
			case 9:
				return 5; // Cancelled
			case 10:
			case 11:
				return CANONICAL_FUNDS_RELEASED;
			case 12:
			case 13:
			case 14:
				return 1; // InDispute
			case 15:
				return 2; // DisputeResolved
			case 16:
				if (chainState === LEGACY_ONCHAIN_COMPLETED) return LEGACY_ONCHAIN_COMPLETED;
				if (chainState === 1) return 1;
				return undefined;
			default:
				return undefined;
		}
	}

	if (rawS >= 0 && rawS <= 11) {
		return rawS;
	}

	return undefined;
}

export function nostrEventIndicatesFundsReleased(
	event: NostrStatusEvent,
	chainOnchainState: number
): boolean {
	const rawS = parseInt(tagValue(event.tags, 's') ?? '', 10);
	if (isNaN(rawS)) return false;
	const version = tagValue(event.tags, 'v');
	const normalized = normalizeContractStatusFromTags(rawS, version, chainOnchainState);
	return normalized === CANONICAL_FUNDS_RELEASED;
}

/**
 * When legacy getEscrow reports Completed (4), treat as payout-complete if any Kind 31006
 * in history normalizes to FundsReleased (7).
 */
export function legacyEscrowHistoryHasFundsReleased(
	statusEvents: readonly NostrStatusEvent[],
	chainOnchainState: number
): boolean {
	if (chainOnchainState !== LEGACY_ONCHAIN_COMPLETED) {
		return false;
	}
	for (const ev of statusEvents) {
		if (nostrEventIndicatesFundsReleased(ev, chainOnchainState)) {
			return true;
		}
	}
	return false;
}

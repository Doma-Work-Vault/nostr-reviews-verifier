import { describe, it, expect } from 'vitest';
import {
	legacyEscrowHistoryHasFundsReleased,
	normalizeContractStatusFromTags,
	nostrEventIndicatesFundsReleased,
	LEGACY_ONCHAIN_COMPLETED,
	CANONICAL_FUNDS_RELEASED
} from '../src/v1-legacy-nostr-status';

describe('v1-legacy-nostr-status', () => {
	it('maps legacy s=10 with v=0.0.1 to FundsReleased', () => {
		expect(normalizeContractStatusFromTags(10, '0.0.1')).toBe(CANONICAL_FUNDS_RELEASED);
	});

	it('maps canonical s=7 to FundsReleased', () => {
		expect(normalizeContractStatusFromTags(7, undefined)).toBe(CANONICAL_FUNDS_RELEASED);
	});

	it('detects FundsReleased from legacy Kind 31006 event', () => {
		const ev = {
			tags: [
				['e', 'contract-id'],
				['s', '10'],
				['v', '0.0.1']
			]
		};
		expect(nostrEventIndicatesFundsReleased(ev, LEGACY_ONCHAIN_COMPLETED)).toBe(true);
	});

	it('returns false when chain is not Completed', () => {
		const ev = {
			tags: [
				['s', '10'],
				['v', '0.0.1']
			]
		};
		expect(legacyEscrowHistoryHasFundsReleased([ev], 7)).toBe(false);
	});

	it('fuses when history contains legacy FundsReleased and chain is Completed', () => {
		const ev = {
			tags: [
				['s', '10'],
				['v', '0.0.1']
			]
		};
		expect(legacyEscrowHistoryHasFundsReleased([ev], LEGACY_ONCHAIN_COMPLETED)).toBe(true);
	});

	it('does not fuse on Completed-only Nostr without payout', () => {
		const ev = {
			tags: [
				['s', '4'],
				['v', '0.0.1']
			]
		};
		expect(legacyEscrowHistoryHasFundsReleased([ev], LEGACY_ONCHAIN_COMPLETED)).toBe(false);
	});
});

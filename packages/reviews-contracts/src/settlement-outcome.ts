import type { ReviewBlockchainState, ReviewContractOutcome } from './enums';
import { ONCHAIN_STATE_MAP, type OnchainStateValue } from './abi/verification-abi';
import { isReviewableBlockchainState } from './status';

/**
 * Maps on-chain escrow/payment state to the review payload contractOutcome field.
 * Mirrors nostr-reviews-verifier settlement-resolver logic.
 */
export function deriveContractOutcomeFromBlockchainState(
	state: ReviewBlockchainState
): ReviewContractOutcome {
	switch (state) {
		case 'funds_released':
		case 'funds_claimed':
		case 'completed':
			return 'completed';
		case 'dispute_resolved':
			return 'disputed_resolved_payout';
		case 'dispute_unresolved':
		case 'refunded':
			return 'refunded';
		default:
			return 'completed';
	}
}

export function mapOnchainStateValueToBlockchainState(
	value: OnchainStateValue
): ReviewBlockchainState | null {
	if (isReviewableBlockchainState(value)) {
		return value;
	}
	return null;
}

/**
 * Derives contractOutcome from a numeric on-chain state (0–11).
 */
export function deriveContractOutcomeFromOnchainState(
	onchainState: number
): ReviewContractOutcome | null {
	const mapped = ONCHAIN_STATE_MAP[onchainState as keyof typeof ONCHAIN_STATE_MAP];
	if (!mapped) {
		return null;
	}
	return deriveContractOutcomeFromBlockchainState(mapped);
}

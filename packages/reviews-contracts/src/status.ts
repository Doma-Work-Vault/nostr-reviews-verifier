import type { ReviewableSettlementRecord } from './types';
import type {
	ReviewBlockchainState as ReviewBlockchainStateEnum,
	ReviewContractOutcome as ReviewContractOutcomeEnum,
	ReviewVerificationStatus as ReviewVerificationStatusEnum
} from './enums';

const reviewableStates: ReviewBlockchainStateEnum[] = [
	'funds_released',
	'funds_claimed',
	'dispute_resolved',
	'dispute_unresolved',
	'refunded'
];

export function isReviewableBlockchainState(state: ReviewBlockchainStateEnum): boolean {
	return reviewableStates.includes(state);
}

export function isReviewableSettlementRecord(
	record: Pick<ReviewableSettlementRecord, 'status'>
): boolean {
	return record.status === 'reviewable';
}

export function deriveReviewVerificationStatus(
	record: Pick<ReviewableSettlementRecord, 'status'>
): ReviewVerificationStatusEnum {
	return record.status;
}

export function isTerminalReviewOutcome(outcome: ReviewContractOutcomeEnum): boolean {
	return (
		outcome === 'completed' ||
		outcome === 'disputed_resolved_payout' ||
		outcome === 'disputed_resolved_refund' ||
		outcome === 'refunded'
	);
}

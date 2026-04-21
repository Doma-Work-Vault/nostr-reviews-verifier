export const REVIEW_SUBJECT_TYPES = ['task', 'service_booking'] as const;
export type ReviewSubjectType = (typeof REVIEW_SUBJECT_TYPES)[number];

export const REVIEW_SETTLEMENT_TYPES = [
	'escrow',
	'service_quote_contract',
	'instant_buy_contract'
] as const;
export type ReviewSettlementType = (typeof REVIEW_SETTLEMENT_TYPES)[number];

export const REVIEW_ROLES = ['tasker', 'taskee', 'client', 'freelancer', 'provider'] as const;
export type ReviewRole = (typeof REVIEW_ROLES)[number];

export const REVIEW_CHAINS = ['rsk', 'bsc'] as const;
export type ReviewChain = (typeof REVIEW_CHAINS)[number];

export const REVIEW_ASSETS = ['rbtc', 'usdt'] as const;
export type ReviewAsset = (typeof REVIEW_ASSETS)[number];

export const REVIEW_BLOCKCHAIN_STATES = [
	'funded',
	'in_dispute',
	'dispute_resolved',
	'dispute_unresolved',
	'completed',
	'cancelled',
	'refunded',
	'funds_released',
	'funds_claimed',
	'no_show',
	'work_in_progress',
	'in_dispute_wip'
] as const;
export type ReviewBlockchainState = (typeof REVIEW_BLOCKCHAIN_STATES)[number];

export const REVIEW_CONTRACT_OUTCOMES = [
	'completed',
	'disputed_resolved_payout',
	'disputed_resolved_refund',
	'refunded'
] as const;
export type ReviewContractOutcome = (typeof REVIEW_CONTRACT_OUTCOMES)[number];

export const REVIEW_CONTENT_LANGUAGES = ['en', 'es'] as const;
export type ReviewContentLanguage = (typeof REVIEW_CONTENT_LANGUAGES)[number];

export const REVIEW_ERROR_CODES = [
	'request_invalid',
	'translation_invalid',
	'translation_failed',
	'contract_outcome_invalid',
	'challenge_expired',
	'challenge_invalid',
	'nostr_signature_invalid',
	'wallet_signature_invalid',
	'issuer_unavailable',
	'rate_limited',
	'attestation_rate_limited',
	'resolver_not_found',
	'unsupported_contract',
	'settlement_not_reviewable',
	'participant_mismatch',
	'duplicate_review_slot',
	'duplicate_review_reply',
	'reply_event_invalid',
	'reply_not_allowed',
	'attestation_publish_failed',
	'review_event_invalid',
	'internal_error'
] as const;
export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

export const REVIEW_SOURCE_VISIBILITIES = [
	'public_present',
	'public_deleted',
	'public_unknown'
] as const;
export type ReviewSourceVisibility = (typeof REVIEW_SOURCE_VISIBILITIES)[number];

export const REVIEW_VERIFICATION_STATUSES = [
	'reviewable',
	'already_reviewed',
	'not_reviewable'
] as const;
export type ReviewVerificationStatus = (typeof REVIEW_VERIFICATION_STATUSES)[number];

export const REVIEW_ATTACHMENT_TYPES = ['image', 'video'] as const;
export type ReviewAttachmentType = (typeof REVIEW_ATTACHMENT_TYPES)[number];

export const REVIEWABLE_OUTCOMES = new Set<ReviewContractOutcome>([
	'completed',
	'disputed_resolved_payout',
	'disputed_resolved_refund',
	'refunded'
]);

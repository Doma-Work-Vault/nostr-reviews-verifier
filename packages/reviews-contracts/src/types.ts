import type {
	ReviewAsset,
	ReviewAttachmentType,
	ReviewBlockchainState,
	ReviewChain,
	ReviewContractOutcome,
	ReviewErrorCode,
	ReviewRole,
	ReviewSettlementType,
	ReviewContentLanguage,
	ReviewSourceVisibility,
	ReviewSubjectType,
	ReviewVerificationStatus
} from './enums';

export interface ReviewLocalizedComment {
	comment: string;
}

export interface ReviewBilingualContent {
	sourceLanguage: ReviewContentLanguage;
	en: ReviewLocalizedComment;
	es: ReviewLocalizedComment;
}

export interface ProviderCategoryRatings {
	workQuality: number;
	experience: number;
	deliverySpeed: number;
}

export interface ClientCategoryRatings {
	communication: number;
	clarity: number;
	paymentTimeliness: number;
}

export type ReviewCategoryRatings = ProviderCategoryRatings | ClientCategoryRatings;

export interface ReviewRating {
	overallRating: number;
	categoryRatings: ReviewCategoryRatings;
}

export interface ReviewAttachment {
	key: string;
	url: string;
	type: ReviewAttachmentType;
	alt: string;
	size: number;
	originalSize?: number;
	compressed?: boolean;
	cloudflareId?: string;
	variants?: Record<string, string>;
}

export interface ReviewDraftFingerprint {
	reviewerPubkey: string;
	subjectType: ReviewSubjectType;
	settlementType: ReviewSettlementType;
	revieweePubkey: string;
	reviewerRole: ReviewRole;
	revieweeRole: ReviewRole;
	contractOutcome: ReviewContractOutcome;
	createdAt: number;
	rating: ReviewRating;
	content: ReviewBilingualContent;
	attachments: ReviewAttachment[];
}

export interface ReviewPublicPayload extends Omit<ReviewDraftFingerprint, 'reviewerPubkey'> {
	reviewDraftHash: string;
}

export interface ReviewAttestationEventContent {
	schemaVersion: 1;
	reviewDraftHash: string;
	subjectType: ReviewSubjectType;
	settlementType: ReviewSettlementType;
	reviewerPubkey: string;
	revieweePubkey: string;
	reviewerRole: ReviewRole;
	revieweeRole: ReviewRole;
	contractOutcome: ReviewContractOutcome;
	issuedAt: number;
	expiresAt: number;
	keyId: string;
}

export interface ReviewReplyEventContent {
	schemaVersion: 1;
	parentReviewEventId: string;
	revieweePubkey: string;
	createdAt: number;
	content: ReviewBilingualContent;
	attachments: ReviewAttachment[];
}

export interface ReviewChallengeRequest {
	schemaVersion?: 1;
	reviewDraftHash: string;
	subjectType: ReviewSubjectType;
	subjectId: string;
	settlementType: ReviewSettlementType;
	settlementId: string;
	chain: ReviewChain;
	asset: ReviewAsset;
	contractAddress: string;
	reviewerNpub: string;
	revieweeNpub: string;
	reviewerWallet: string;
	revieweeWallet: string;
}

export interface ReviewChallengeResponse {
	schemaVersion: 1;
	challengeToken: string;
	challengeMessage: string;
	issuedAt: number;
	expiresAt: number;
}

export interface NostrEventLike {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
	sig: string;
}

export interface ReviewAttestationRequest {
	schemaVersion?: 1;
	reviewDraftHash: string;
	signedReviewEvent: NostrEventLike;
	challengeToken: string;
	nostrChallengeSignature: string;
	walletChallengeSignature: string;
	subjectType: ReviewSubjectType;
	subjectId: string;
	settlementType: ReviewSettlementType;
	settlementId: string;
	chain: ReviewChain;
	asset: ReviewAsset;
	contractAddress: string;
	reviewerNpub: string;
	revieweeNpub: string;
	reviewerWallet: string;
	revieweeWallet: string;
}

export interface ReviewAttestationResponse {
	schemaVersion: 1;
	status: 'ok';
	attestationEventId: string;
	issuerPubkey: string;
	reviewDraftHash: string;
	issuedAt: number;
}

export interface ReviewIssuerRecord {
	keyId: string;
	pubkey: string;
	status: 'active' | 'retired';
	validFrom: number;
	validUntil: number | null;
}

export interface ReviewIssuerRegistryResponse {
	schemaVersion: 1;
	issuers: ReviewIssuerRecord[];
}

export interface ReviewErrorResponse {
	schemaVersion: 1;
	status: 'error';
	code: ReviewErrorCode;
	message: string;
	retryAfterSeconds?: number;
}

export interface ReviewableSettlementRecord {
	subjectType: ReviewSubjectType;
	subjectId: string;
	settlementType: ReviewSettlementType;
	settlementId: string;
	chain: ReviewChain;
	asset: ReviewAsset;
	contractAddress: string;
	contractVersion: string;
	reviewerRole: ReviewRole;
	revieweeRole: ReviewRole;
	reviewerNpub?: string;
	revieweeNpub?: string;
	reviewerWallet?: string;
	revieweeWallet?: string;
	blockchainState: ReviewBlockchainState;
	completedAt: number;
	reviewableAt: number;
	contractOutcome: ReviewContractOutcome;
	status: ReviewVerificationStatus;
	sourceVisibility: ReviewSourceVisibility;
	sourcePresentation: {
		label?: string;
		href?: string | null;
	};
	sourceRefs: {
		escrowId?: string;
		quoteRequestId?: string;
		proposalId?: string;
		instantOrderId?: string;
	};
}

export interface ReviewReplyCandidate extends ReviewReplyEventContent {
	eventId: string;
}

export interface CanonicalReviewReply extends ReviewReplyCandidate {
	isCanonical: true;
}

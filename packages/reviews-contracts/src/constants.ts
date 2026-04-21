export const REVIEWS_SCHEMA_VERSION = 1 as const;

export const REVIEW_NOSTR_KINDS = {
	REVIEW: 6430,
	ATTESTATION: 6431,
	REPLY: 6432
} as const;

export const REVIEW_TAG_NAMES = {
	ATTESTATION: 'e',
	REVIEW_DRAFT_HASH: 'review_draft_hash',
	REVIEWEE: 'p',
	PARENT_REVIEW: 'review'
} as const;

export const REVIEW_ATTACHMENT_LIMITS = {
	maxFiles: 5,
	maxFileSizeMb: 10,
	maxDurationSeconds: 300,
	allowedMimePatterns: ['image/*', 'video/*']
} as const;

export const REVIEW_CHALLENGE_LIMITS = {
	maxTokenLength: 1024,
	maxTokenPayloadLength: 768,
	maxTokenPayloadJsonLength: 512,
	maxChallengeMessageLength: 1536,
	maxKeyIdLength: 64
} as const;

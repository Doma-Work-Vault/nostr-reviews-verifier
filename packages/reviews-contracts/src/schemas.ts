import { z } from 'zod';
import {
	REVIEW_ASSETS,
	REVIEW_BLOCKCHAIN_STATES,
	REVIEW_CHAINS,
	REVIEW_CONTENT_LANGUAGES,
	REVIEW_CONTRACT_OUTCOMES,
	REVIEW_ERROR_CODES,
	REVIEW_ATTACHMENT_TYPES,
	REVIEW_SOURCE_VISIBILITIES,
	REVIEW_VERIFICATION_STATUSES,
	REVIEW_ROLES,
	REVIEW_SETTLEMENT_TYPES,
	REVIEW_SUBJECT_TYPES
} from './enums';
import {
	REVIEW_ATTACHMENT_LIMITS,
	REVIEW_CHALLENGE_LIMITS,
	REVIEW_NOSTR_KINDS,
	REVIEWS_SCHEMA_VERSION
} from './constants';

const schemaVersionLiteral = z.literal(REVIEWS_SCHEMA_VERSION);

const unixTimestampSchema = z.number().int().nonnegative();
const npubSchema = z.string().regex(/^npub1[023456789ac-hj-np-z]+$/, 'Expected a valid npub');
const hexPubkeySchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Expected 64-char hex pubkey');
const nostrPubkeySchema = z.union([hexPubkeySchema, npubSchema]);
const hexSignatureSchema = z.string().regex(/^[a-f0-9]{128}$/i, 'Expected 128-char hex signature');
const walletSignatureSchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]{130}$/, 'Expected 0x-prefixed hex signature');
const hexHashSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Expected lowercase hex sha256');
const chainAddressSchema = z.string().min(1);
const challengeTokenSchema = z
	.string()
	.max(REVIEW_CHALLENGE_LIMITS.maxTokenLength)
	.regex(/^v1\.[A-Za-z0-9_-]+\.[a-f0-9]{128}$/i, 'Expected opaque challenge token');

export const reviewSubjectTypeSchema = z.enum(REVIEW_SUBJECT_TYPES);
export const reviewSettlementTypeSchema = z.enum(REVIEW_SETTLEMENT_TYPES);
export const reviewRoleSchema = z.enum(REVIEW_ROLES);
export const reviewChainSchema = z.enum(REVIEW_CHAINS);
export const reviewAssetSchema = z.enum(REVIEW_ASSETS);
export const reviewBlockchainStateSchema = z.enum(REVIEW_BLOCKCHAIN_STATES);
export const reviewContractOutcomeSchema = z.enum(REVIEW_CONTRACT_OUTCOMES);
export const reviewErrorCodeSchema = z.enum(REVIEW_ERROR_CODES);
export const reviewLanguageSchema = z.enum(REVIEW_CONTENT_LANGUAGES);
export const reviewAttachmentTypeSchema = z.enum(REVIEW_ATTACHMENT_TYPES);
export const reviewSourceVisibilitySchema = z.enum(REVIEW_SOURCE_VISIBILITIES);
export const reviewVerificationStatusSchema = z.enum(REVIEW_VERIFICATION_STATUSES);

export const reviewAttachmentSchema = z
	.object({
		url: z.string().url(),
		key: z.string().min(1),
		type: reviewAttachmentTypeSchema,
		alt: z.string().min(1),
		size: z
			.number()
			.int()
			.nonnegative()
			.max(REVIEW_ATTACHMENT_LIMITS.maxFileSizeMb * 1024 * 1024),
		originalSize: z.number().int().nonnegative().optional(),
		compressed: z.boolean().optional(),
		cloudflareId: z.string().min(1).optional(),
		variants: z.record(z.string(), z.string()).optional()
	})
	.strict();

export const reviewCategoryRatingsSchema = z
	.union([
		z
			.object({
				workQuality: z.number().int().min(1).max(5),
				experience: z.number().int().min(1).max(5),
				deliverySpeed: z.number().int().min(1).max(5)
			})
			.strict(),
		z
			.object({
				communication: z.number().int().min(1).max(5),
				clarity: z.number().int().min(1).max(5),
				paymentTimeliness: z.number().int().min(1).max(5)
			})
			.strict()
	])
	.superRefine((value, ctx) => {
		const providerSet = 'workQuality' in value && 'experience' in value && 'deliverySpeed' in value;
		const clientSet =
			'communication' in value && 'clarity' in value && 'paymentTimeliness' in value;
		if ((providerSet ? 1 : 0) + (clientSet ? 1 : 0) !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Category ratings must match exactly one supported role rating set'
			});
		}
	});

export const localizedReviewCommentSchema = z
	.object({
		comment: z.string().trim().min(1).max(1000)
	})
	.strict();

export const bilingualReviewContentSchema = z
	.object({
		sourceLanguage: reviewLanguageSchema,
		en: localizedReviewCommentSchema,
		es: localizedReviewCommentSchema
	})
	.strict();

export const reviewSourcePresentationSchema = z
	.object({
		label: z.string().trim().min(1).optional(),
		href: z.string().trim().min(1).nullable().optional()
	})
	.strict();

export const reviewEventPayloadSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		reviewDraftHash: hexHashSchema,
		subjectType: reviewSubjectTypeSchema,
		settlementType: reviewSettlementTypeSchema,
		revieweePubkey: hexPubkeySchema,
		reviewerRole: reviewRoleSchema,
		revieweeRole: reviewRoleSchema,
		contractOutcome: reviewContractOutcomeSchema,
		createdAt: unixTimestampSchema,
		rating: z
			.object({
				overallRating: z.number().int().min(1).max(5),
				categoryRatings: reviewCategoryRatingsSchema
			})
			.strict(),
		content: bilingualReviewContentSchema,
		attachments: z.array(reviewAttachmentSchema).max(REVIEW_ATTACHMENT_LIMITS.maxFiles).default([])
	})
	.strict();

export const reviewReplyEventPayloadSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		parentReviewEventId: z.string().min(1),
		revieweePubkey: hexPubkeySchema,
		createdAt: unixTimestampSchema,
		content: bilingualReviewContentSchema,
		attachments: z.array(reviewAttachmentSchema).max(REVIEW_ATTACHMENT_LIMITS.maxFiles).default([])
	})
	.strict();

export const reviewReplyCandidateSchema = reviewReplyEventPayloadSchema
	.extend({
		eventId: hexHashSchema
	})
	.strict();

export const nostrUnsignedEventSchema = z
	.object({
		kind: z.number().int().nonnegative(),
		pubkey: hexPubkeySchema,
		created_at: z.number().int().nonnegative(),
		tags: z.array(z.array(z.string())),
		content: z.string()
	})
	.strict();

export const nostrSignedEventSchema = nostrUnsignedEventSchema.extend({
	id: z.string().min(1),
	sig: hexSignatureSchema
});

export const reviewSignedEventSchema = nostrSignedEventSchema.extend({
	kind: z.literal(REVIEW_NOSTR_KINDS.REVIEW)
});

export const attestationSignedEventSchema = nostrSignedEventSchema.extend({
	kind: z.literal(REVIEW_NOSTR_KINDS.ATTESTATION)
});

export const reviewReplySignedEventSchema = nostrSignedEventSchema.extend({
	kind: z.literal(REVIEW_NOSTR_KINDS.REPLY)
});

export const reviewTranslationRequestSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		sourceLanguage: reviewLanguageSchema,
		comment: z.string().trim().min(1).max(1000)
	})
	.strict();

export const reviewTranslationResponseSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		sourceLanguage: reviewLanguageSchema,
		content: bilingualReviewContentSchema
	})
	.strict();

export const attestationChallengeRequestSchema = z
	.object({
		schemaVersion: schemaVersionLiteral.optional(),
		reviewDraftHash: hexHashSchema,
		subjectType: reviewSubjectTypeSchema,
		subjectId: z.string().min(1),
		settlementType: reviewSettlementTypeSchema,
		settlementId: z.string().min(1),
		chain: reviewChainSchema,
		asset: reviewAssetSchema,
		contractAddress: chainAddressSchema,
		reviewerNpub: nostrPubkeySchema,
		revieweeNpub: nostrPubkeySchema,
		reviewerWallet: chainAddressSchema,
		revieweeWallet: chainAddressSchema
	})
	.strict();

export const attestationChallengeResponseSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		challengeToken: challengeTokenSchema,
		challengeMessage: z.string().min(1).max(REVIEW_CHALLENGE_LIMITS.maxChallengeMessageLength),
		issuedAt: unixTimestampSchema,
		expiresAt: unixTimestampSchema
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.expiresAt <= value.issuedAt) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'expiresAt must be greater than issuedAt',
				path: ['expiresAt']
			});
		}
	});

export const attestationRequestSchema = z
	.object({
		schemaVersion: schemaVersionLiteral.optional(),
		reviewDraftHash: hexHashSchema,
		signedReviewEvent: reviewSignedEventSchema,
		challengeToken: challengeTokenSchema,
		nostrChallengeSignature: hexSignatureSchema,
		walletChallengeSignature: walletSignatureSchema,
		subjectType: reviewSubjectTypeSchema,
		subjectId: z.string().min(1),
		settlementType: reviewSettlementTypeSchema,
		settlementId: z.string().min(1),
		chain: reviewChainSchema,
		asset: reviewAssetSchema,
		contractAddress: chainAddressSchema,
		reviewerNpub: nostrPubkeySchema,
		revieweeNpub: nostrPubkeySchema,
		reviewerWallet: chainAddressSchema,
		revieweeWallet: chainAddressSchema
	})
	.strict();

export const attestationResponseSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		status: z.literal('ok'),
		attestationEventId: z.string().min(1),
		issuerPubkey: hexPubkeySchema,
		reviewDraftHash: hexHashSchema,
		issuedAt: unixTimestampSchema
	})
	.strict();

export const reviewErrorResponseSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		status: z.literal('error'),
		code: reviewErrorCodeSchema,
		message: z.string().min(1),
		retryAfterSeconds: z.number().int().positive().optional()
	})
	.strict();

export const attestationEventPayloadSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		reviewEventId: z.string().min(1),
		reviewDraftHash: hexHashSchema,
		subjectType: reviewSubjectTypeSchema,
		settlementType: reviewSettlementTypeSchema,
		reviewerPubkey: hexPubkeySchema,
		revieweePubkey: hexPubkeySchema,
		reviewerRole: reviewRoleSchema,
		revieweeRole: reviewRoleSchema,
		contractOutcome: reviewContractOutcomeSchema,
		issuedAt: unixTimestampSchema,
		expiresAt: unixTimestampSchema,
		keyId: z.string().min(1)
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.expiresAt <= value.issuedAt) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'expiresAt must be greater than issuedAt',
				path: ['expiresAt']
			});
		}
	});

export const issuerRegistryEntrySchema = z
	.object({
		keyId: z.string().min(1),
		pubkey: hexPubkeySchema,
		status: z.enum(['active', 'retired']),
		validFrom: unixTimestampSchema,
		validUntil: unixTimestampSchema.nullable().optional()
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.validUntil !== null &&
			value.validUntil !== undefined &&
			value.validUntil < value.validFrom
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'validUntil must be greater than or equal to validFrom',
				path: ['validUntil']
			});
		}
	});

export const issuerRegistryResponseSchema = z
	.object({
		schemaVersion: schemaVersionLiteral,
		issuers: z.array(issuerRegistryEntrySchema)
	})
	.strict()
	.superRefine((value, ctx) => {
		const seenKeyIds = new Set<string>();
		for (const [index, issuer] of value.issuers.entries()) {
			if (seenKeyIds.has(issuer.keyId)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Issuer keyId values must be unique',
					path: ['issuers', index, 'keyId']
				});
				continue;
			}
			seenKeyIds.add(issuer.keyId);
		}
	});

export const reviewableSettlementRecordSchema = z
	.object({
		subjectType: reviewSubjectTypeSchema,
		subjectId: z.string().min(1),
		settlementType: reviewSettlementTypeSchema,
		settlementId: z.string().min(1),
		chain: reviewChainSchema,
		asset: reviewAssetSchema,
		contractAddress: chainAddressSchema,
		contractVersion: z.string().min(1),
		reviewerRole: reviewRoleSchema,
		revieweeRole: reviewRoleSchema,
		reviewerNpub: nostrPubkeySchema.optional(),
		revieweeNpub: nostrPubkeySchema.optional(),
		reviewerWallet: chainAddressSchema.optional(),
		revieweeWallet: chainAddressSchema.optional(),
		blockchainState: reviewBlockchainStateSchema,
		completedAt: unixTimestampSchema,
		reviewableAt: unixTimestampSchema,
		contractOutcome: reviewContractOutcomeSchema,
		status: reviewVerificationStatusSchema,
		sourceVisibility: reviewSourceVisibilitySchema,
		sourcePresentation: reviewSourcePresentationSchema,
		sourceRefs: z
			.object({
				escrowId: z.string().min(1).optional(),
				quoteRequestId: z.string().min(1).optional(),
				proposalId: z.string().min(1).optional(),
				instantOrderId: z.string().min(1).optional()
			})
			.strict()
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.status !== 'reviewable') {
			return;
		}

		for (const field of [
			'reviewerNpub',
			'revieweeNpub',
			'reviewerWallet',
			'revieweeWallet'
		] as const) {
			if (!value[field]) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `${field} is required when settlement status is reviewable`,
					path: [field]
				});
			}
		}
	});

export type ReviewAttachment = z.infer<typeof reviewAttachmentSchema>;
export type ReviewCategoryRatings = z.infer<typeof reviewCategoryRatingsSchema>;
export type BilingualReviewContent = z.infer<typeof bilingualReviewContentSchema>;
export type ReviewEventPayload = z.infer<typeof reviewEventPayloadSchema>;
export type ReviewReplyEventPayload = z.infer<typeof reviewReplyEventPayloadSchema>;
export type ReviewReplyCandidate = z.infer<typeof reviewReplyCandidateSchema>;
export type ReviewTranslationRequest = z.infer<typeof reviewTranslationRequestSchema>;
export type ReviewTranslationResponse = z.infer<typeof reviewTranslationResponseSchema>;
export type AttestationChallengeRequest = z.infer<typeof attestationChallengeRequestSchema>;
export type AttestationChallengeResponse = z.infer<typeof attestationChallengeResponseSchema>;
export type AttestationRequest = z.infer<typeof attestationRequestSchema>;
export type AttestationResponse = z.infer<typeof attestationResponseSchema>;
export type AttestationEventPayload = z.infer<typeof attestationEventPayloadSchema>;
export type IssuerRegistryEntry = z.infer<typeof issuerRegistryEntrySchema>;
export type IssuerRegistryResponse = z.infer<typeof issuerRegistryResponseSchema>;
export type ReviewableSettlementRecord = z.infer<typeof reviewableSettlementRecordSchema>;

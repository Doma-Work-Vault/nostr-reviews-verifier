import { REVIEWS_SCHEMA_VERSION } from './constants';
import type { ReviewEventPayload } from './schemas';

function normalizeComment(value: string): string {
	return value.replace(/\r\n/g, '\n').trim();
}

type CanonicalReviewDraftHashShape = Pick<
	ReviewEventPayload,
	| 'reviewDraftHash'
	| 'subjectType'
	| 'settlementType'
	| 'revieweePubkey'
	| 'reviewerRole'
	| 'revieweeRole'
	| 'contractOutcome'
	| 'createdAt'
	| 'rating'
	| 'content'
	| 'attachments'
> & {
	schemaVersion: number;
};

export function buildCanonicalReviewDraftPayload(
	value: Omit<ReviewEventPayload, 'reviewDraftHash'>
): Omit<CanonicalReviewDraftHashShape, 'reviewDraftHash'> {
	return {
		schemaVersion: REVIEWS_SCHEMA_VERSION,
		subjectType: value.subjectType,
		settlementType: value.settlementType,
		revieweePubkey: value.revieweePubkey,
		reviewerRole: value.reviewerRole,
		revieweeRole: value.revieweeRole,
		contractOutcome: value.contractOutcome,
		createdAt: value.createdAt,
		rating: {
			overallRating: value.rating.overallRating,
			categoryRatings: { ...value.rating.categoryRatings }
		},
		content: {
			sourceLanguage: value.content.sourceLanguage,
			en: { comment: normalizeComment(value.content.en.comment) },
			es: { comment: normalizeComment(value.content.es.comment) }
		},
		attachments: value.attachments.map((attachment) => ({
			url: attachment.url,
			key: attachment.key,
			type: attachment.type,
			alt: attachment.alt,
			size: attachment.size
		}))
	};
}

export function createCanonicalReviewDraftHashInput(
	value: Omit<ReviewEventPayload, 'reviewDraftHash'>
): string {
	return JSON.stringify(buildCanonicalReviewDraftPayload(value));
}

export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeReviewDraftHash(
	value: Omit<ReviewEventPayload, 'reviewDraftHash'>
): Promise<string> {
	return sha256Hex(createCanonicalReviewDraftHashInput(value));
}

export async function computeReviewDraftHashFromPayload(
	value: ReviewEventPayload
): Promise<string> {
	const { reviewDraftHash: _ignore, ...payloadWithoutHash } = value;
	return computeReviewDraftHash(payloadWithoutHash);
}

export async function verifyReviewDraftHash(value: ReviewEventPayload): Promise<boolean> {
	const computedHash = await computeReviewDraftHashFromPayload(value);
	return computedHash === value.reviewDraftHash;
}

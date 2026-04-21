import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import type { ReviewChallengeRequest, ReviewPublicPayload, ReviewReplyCandidate } from './types';

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => normalize(entry));
	}

	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			out[key] = normalize(record[key]);
		}
		return out;
	}

	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export function sha256Hex(value: string): string {
	return bytesToHex(sha256(new TextEncoder().encode(value)));
}

export function buildReviewDraftHash(fingerprint: ReviewPublicPayload): string {
	return sha256Hex(canonicalJson(fingerprint));
}

export function buildReviewChallengeMessage(request: ReviewChallengeRequest): string {
	return canonicalJson(request);
}

export function selectCanonicalReviewReply<T extends ReviewReplyCandidate>(replies: T[]): T | null {
	if (replies.length === 0) {
		return null;
	}

	return [...replies].sort((a, b) => {
		const createdAtDiff = a.createdAt - b.createdAt;
		if (createdAtDiff !== 0) {
			return createdAtDiff;
		}

		return a.eventId.localeCompare(b.eventId);
	})[0];
}

export function isReplyAuthorAllowed(
	replyAuthorPubkey: string,
	expectedRevieweePubkey: string
): boolean {
	return replyAuthorPubkey.toLowerCase() === expectedRevieweePubkey.toLowerCase();
}

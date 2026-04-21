import type { ReviewReplyCandidate } from './types';
import {
	isReplyAuthorAllowed as isReplyAuthorAllowedImpl,
	selectCanonicalReviewReply
} from './canonical';

export { selectCanonicalReviewReply };

export function isReplyAuthorAllowed(
	replyAuthorPubkey: string,
	expectedRevieweePubkey: string
): boolean {
	return isReplyAuthorAllowedImpl(replyAuthorPubkey, expectedRevieweePubkey);
}

export function assertSingleReplyWinner<T extends ReviewReplyCandidate>(replies: T[]): T | null {
	return selectCanonicalReviewReply(replies);
}

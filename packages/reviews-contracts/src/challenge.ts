export function buildReviewAttestationChallengeMessage(input: {
	challengeToken: string;
	slotHash: string;
	reviewDraftHash: string;
	nonce: string;
	issuedAt: number;
	expiresAt: number;
	audience?: string;
}): string {
	const audience = input.audience ?? 'BitTasker review attestation';
	return [
		audience,
		`challenge_token:${input.challengeToken}`,
		`slot_hash:${input.slotHash}`,
		`review_draft_hash:${input.reviewDraftHash}`,
		`nonce:${input.nonce}`,
		`issued_at:${input.issuedAt}`,
		`expires_at:${input.expiresAt}`
	].join('\n');
}

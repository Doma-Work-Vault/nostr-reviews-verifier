import { schnorr } from '@noble/curves/secp256k1';
import { utf8ToBytes } from '@noble/hashes/utils';
import { sha256Fn } from './hash-utils';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { z } from 'zod';
import {
	canonicalJson,
	buildReviewAttestationChallengeMessage,
	REVIEW_CHALLENGE_LIMITS
} from '@bittasker/reviews-contracts';

const CHALLENGE_TOKEN_PREFIX = 'v1';
const CHALLENGE_TOKEN_SIGNATURE_HEX_LENGTH = 128;
const base64UrlSegmentSchema = z
	.string()
	.min(1)
	.max(REVIEW_CHALLENGE_LIMITS.maxTokenPayloadLength)
	.regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url payload segment');
const signatureHexSchema = z
	.string()
	.length(CHALLENGE_TOKEN_SIGNATURE_HEX_LENGTH)
	.regex(/^[a-f0-9]{128}$/i, 'Expected 128-char hex signature');

const challengeTokenPayloadSchema = z
	.object({
		schemaVersion: z.literal(1),
		slotHash: z.string().regex(/^[a-f0-9]{64}$/i),
		reviewDraftHash: z.string().regex(/^[a-f0-9]{64}$/i),
		issuedAt: z.number().int().nonnegative(),
		expiresAt: z.number().int().nonnegative(),
		nonce: z.string().regex(/^[a-f0-9]{32}$/i),
		keyId: z.string().min(1).max(REVIEW_CHALLENGE_LIMITS.maxKeyIdLength)
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

export type ReviewChallengeTokenPayload = z.infer<typeof challengeTokenPayloadSchema>;

function encodeBase64Url(input: Uint8Array): string {
	return Buffer.from(input)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function decodeBase64Url(input: string): Uint8Array {
	const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
	const padded = `${base64}${'='.repeat((4 - (base64.length % 4 || 4)) % 4)}`;
	return new Uint8Array(Buffer.from(padded, 'base64'));
}

function parseChallengeTokenSegments(token: string): {
	payloadEncoded: string;
	signatureHex: string;
} {
	if (token.length === 0 || token.length > REVIEW_CHALLENGE_LIMITS.maxTokenLength) {
		throw new Error('Malformed challenge token');
	}

	const [prefix, payloadEncoded, signatureHex, ...rest] = token.split('.');
	if (prefix !== CHALLENGE_TOKEN_PREFIX || !payloadEncoded || !signatureHex || rest.length > 0) {
		throw new Error('Malformed challenge token');
	}

	try {
		return {
			payloadEncoded: base64UrlSegmentSchema.parse(payloadEncoded),
			signatureHex: signatureHexSchema.parse(signatureHex)
		};
	} catch {
		throw new Error('Malformed challenge token');
	}
}

function decodeSerializedPayload(payloadEncoded: string): string {
	const payloadJson = new TextDecoder().decode(decodeBase64Url(payloadEncoded));
	if (
		payloadJson.length === 0 ||
		payloadJson.length > REVIEW_CHALLENGE_LIMITS.maxTokenPayloadJsonLength
	) {
		throw new Error('Malformed challenge token');
	}

	return payloadJson;
}

function parseChallengeTokenPayloadFromSerialized(serializedPayload: string): ReviewChallengeTokenPayload {
	const parsed = challengeTokenPayloadSchema.parse(JSON.parse(serializedPayload));
	if (serializePayload(parsed) !== serializedPayload) {
		throw new Error('Malformed challenge token');
	}

	return parsed;
}

function serializePayload(payload: ReviewChallengeTokenPayload): string {
	const parsed = challengeTokenPayloadSchema.parse(payload);
	return canonicalJson({
		...parsed,
		slotHash: parsed.slotHash.toLowerCase(),
		reviewDraftHash: parsed.reviewDraftHash.toLowerCase(),
		nonce: parsed.nonce.toLowerCase()
	});
}

export function createReviewChallengeToken(
	payload: ReviewChallengeTokenPayload,
	issuerPrivateKeyHex: string
): string {
	const serialized = serializePayload(payload);
	if (serialized.length > REVIEW_CHALLENGE_LIMITS.maxTokenPayloadJsonLength) {
		throw new Error('Challenge payload exceeds maximum size');
	}
	const signature = bytesToHex(schnorr.sign(sha256Fn(utf8ToBytes(serialized)), hexToBytes(issuerPrivateKeyHex)));
	const encodedPayload = encodeBase64Url(utf8ToBytes(serialized));
	if (encodedPayload.length > REVIEW_CHALLENGE_LIMITS.maxTokenPayloadLength) {
		throw new Error('Challenge payload exceeds maximum encoded size');
	}
	return `${CHALLENGE_TOKEN_PREFIX}.${encodedPayload}.${signature}`;
}

export function parseReviewChallengeTokenPayload(token: string): ReviewChallengeTokenPayload {
	const { payloadEncoded } = parseChallengeTokenSegments(token);
	return parseChallengeTokenPayloadFromSerialized(decodeSerializedPayload(payloadEncoded));
}

export function parseAndVerifyReviewChallengeToken(
	token: string,
	expectedPubkeyHex: string
): ReviewChallengeTokenPayload {
	const { payloadEncoded, signatureHex } = parseChallengeTokenSegments(token);
	const serializedPayload = decodeSerializedPayload(payloadEncoded);
	const isValid = schnorr.verify(
		hexToBytes(signatureHex),
		sha256Fn(utf8ToBytes(serializedPayload)),
		hexToBytes(expectedPubkeyHex)
	);
	if (!isValid) {
		throw new Error('Challenge token signature invalid');
	}

	return parseChallengeTokenPayloadFromSerialized(serializedPayload);
}

export function buildOpaqueReviewChallengeMessage(
	token: string,
	payload: ReviewChallengeTokenPayload
): string {
	return buildReviewAttestationChallengeMessage({
		challengeToken: token,
		slotHash: payload.slotHash,
		reviewDraftHash: payload.reviewDraftHash,
		nonce: payload.nonce,
		issuedAt: payload.issuedAt,
		expiresAt: payload.expiresAt
	});
}

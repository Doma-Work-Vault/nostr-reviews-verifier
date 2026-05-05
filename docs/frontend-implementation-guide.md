# Frontend Implementation Guide — Reviews Attestation System

**Version:** 1.0.0
**Last Updated:** 2026-05-05
**Audience:** Frontend developers integrating the reviews attestation backend

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [API Reference](#3-api-reference)
4. [Review Attestation Flow](#4-review-attestation-flow)
5. [Reply Attestation Flow](#5-reply-attestation-flow)
6. [Error Handling](#6-error-handling)
7. [Frontend Utilities Reference](#7-frontend-utilities-reference)
8. [Environment Configuration](#8-environment-configuration)
9. [Querying Attestations from Relays](#9-querying-attestations-from-relays)
10. [Complete Example](#10-complete-example)

---

## 1. Architecture Overview

```
┌──────────────────────────┐     ┌───────────────────────────┐
│   BitTasker Frontend     │────▶│  nostr-reviews-verifier   │
│   (SvelteKit)            │     │  (Cloudflare Workers)     │
│                          │     │                           │
│  • Review form UI        │     │  POST /challenge          │
│  • Nostr key signing     │     │  POST /attestations       │
│  • Wallet signing        │     │  POST /reply-*/challenge  │
│  • Relay subscriptions   │     │  POST /reply-*            │
└──────────────────────────┘     └───────────────────────────┘
           │                                  │
           │ WSS                              │ RPC
           ▼                                  ▼
┌──────────────────────────┐     ┌───────────────────────────┐
│   Nostr Relays           │     │   RSK Blockchain          │
│                          │     │                           │
│   Kind 6430: Review      │     │   Escrow contract state   │
│   Kind 6431: Attestation │     │   Settlement verification │
│   Kind 6432: Reply       │     └───────────────────────────┘
│   Kind 6433: Reply Att.  │
└──────────────────────────┘
```

**Key design principles:**

- **Keys never leave the client.** The backend never sees your Nostr nsec or wallet private key. It only receives cryptographic signatures proving key ownership.
- **Dual-signature verification.** Every review requires both a Nostr Schnorr signature AND an EVM wallet signature on the same challenge message. This cryptographically binds your Nostr identity to your wallet address.
- **On-chain settlement verification.** Reviews are only allowed after the escrow contract reaches a final state. The backend queries the blockchain to verify this.
- **Immutable attestations.** Review attestations are published to Nostr relays as Kind 6431 events. Anyone can verify them independently.

---

## 2. Prerequisites

### NPM Dependencies

```json
{
  "dependencies": {
    "nostr-tools": "^2.13.0",
    "@noble/curves": "^1.9.2",
    "@noble/hashes": "^1.8.0",
    "@bittasker/reviews-contracts": "^0.1.0"
  }
}
```

### User Requirements

- A Nostr key pair (nsec/npub) — the user's identity
- An EVM wallet (MetaMask, Rabby, etc.) — the user's on-chain identity
- Both keys must match the settlement record (backend validates this)

### Backend Endpoint

```
VITE_REVIEWS_ATTESTATION_API_URL=https://reviews-api.bittasker.io
```

---

## 3. API Reference

### 3.1 GET /review-attestation-issuers

Returns the active issuer registry (public keys used to sign attestations).

**Response:**
```json
{
  "schemaVersion": 1,
  "issuers": [{
    "keyId": "reviews-attestation-issuer-v1",
    "pubkey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "status": "active",
    "validFrom": 0,
    "validUntil": null
  }]
}
```

### 3.2 POST /review-attestations/challenge

Request a time-limited challenge token for review attestation. The challenge binds to a specific settlement slot and review content hash.

**Request:**
```typescript
interface ChallengeRequest {
  reviewDraftHash: string;    // 64-char hex — SHA-256 of review content (see §4.1)
  subjectType: 'task' | 'service_booking';
  subjectId: string;          // e.g. "task-123"
  settlementType: 'escrow' | 'service_quote_contract' | 'instant_buy_contract';
  settlementId: string;       // e.g. "escrow-456"
  chain: 'rsk' | 'bsc';
  asset: 'rbtc' | 'usdt';
  contractAddress: string;    // 0x-prefixed escrow contract address
  reviewerNpub: string;       // npub1... or hex pubkey
  revieweeNpub: string;       // npub1... or hex pubkey
  reviewerWallet: string;     // 0x-prefixed wallet
  revieweeWallet: string;     // 0x-prefixed wallet
}
```

**Response (200):**
```json
{
  "schemaVersion": 1,
  "challengeToken": "v1.<base64url>.<128-char-hex-sig>",
  "challengeMessage": "BitTasker review attestation\nchallenge_token:v1....\nslot_hash:abc...\nreview_draft_hash:def...\nnonce:0123456789abcdef...\nissued_at:1700000000000\nexpires_at:1700000900000",
  "issuedAt": 1700000000000,
  "expiresAt": 1700000900000
}
```

**Error codes:** `resolver_not_found` (404), `contract_outcome_invalid` (409), `duplicate_review_slot` (409), `rate_limited` (429), `participant_mismatch` (409), `settlement_not_reviewable` (409)

### 3.3 POST /review-attestations

Submit a signed review for attestation. Requires dual signatures on the challenge message.

**Request:**
```typescript
interface AttestationRequest {
  reviewDraftHash: string;
  signedReviewEvent: {
    id: string;           // event ID (64-char hex)
    pubkey: string;       // reviewer's hex pubkey
    kind: 6430;           // review event kind
    created_at: number;   // unix timestamp
    tags: string[][];     // Nostr tags
    content: string;      // JSON string of ReviewEventPayload
    sig: string;          // 128-char hex Schnorr signature
  };
  challengeToken: string;           // from §3.2 response
  nostrChallengeSignature: string;  // 128-char hex — Schnorr signature of challengeMessage
  walletChallengeSignature: string; // 0x-prefixed — EIP-191 signature of challengeMessage
  subjectType: string;
  subjectId: string;
  settlementType: string;
  settlementId: string;
  chain: string;
  asset: string;
  contractAddress: string;
  reviewerNpub: string;
  revieweeNpub: string;
  reviewerWallet: string;
  revieweeWallet: string;
}
```

**Response (200):**
```json
{
  "schemaVersion": 1,
  "status": "ok",
  "attestationEventId": "<event-id>",
  "issuerPubkey": "<issuer-hex-pubkey>",
  "reviewDraftHash": "<64-char-hex>",
  "issuedAt": 1700000000000
}
```

**Error codes:** All from §3.2 plus `nostr_signature_invalid` (400), `wallet_signature_invalid` (400), `challenge_expired` (400), `challenge_invalid` (400), `review_event_invalid` (400), `duplicate_review_slot` (409), `attestation_publish_failed` (502)

### 3.4 POST /review-reply-attestations/challenge

Request a challenge for replying to an existing attested review. Only the reviewee (person reviewed) can reply.

**Request:**
```typescript
interface ReplyChallengeRequest {
  parentReviewEventId: string;  // 64-char hex — the review being replied to
  replyDraftHash: string;       // 64-char hex — SHA-256 of reply content
  revieweeNpub: string;
  revieweeWallet: string;
}
```

**Response (200):** Same shape as §3.2.

**Error codes:** `resolver_not_found` (404 — original review not attested), `reply_not_allowed` (403 — caller is not the reviewee), `duplicate_review_reply` (409), `rate_limited` (429)

### 3.5 POST /review-reply-attestations

Submit a signed reply for attestation.

**Request:**
```typescript
interface ReplyAttestationRequest {
  parentReviewEventId: string;
  replyDraftHash: string;
  signedReplyEvent: {
    id: string;
    pubkey: string;
    kind: 6432;            // reply event kind
    created_at: number;
    tags: string[][];
    content: string;        // JSON string of ReviewReplyEventPayload
    sig: string;
  };
  challengeToken: string;
  nostrChallengeSignature: string;
  walletChallengeSignature: string;
  revieweeNpub: string;
  revieweeWallet: string;
}
```

**Response (200):** Same shape as §3.3.

---

## 4. Review Attestation Flow

### Step 1: Build the review content

```typescript
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { bytesToHex } from 'nostr-tools/utils';

interface ReviewContent {
  schemaVersion: 1;
  reviewDraftHash: string;     // computed below
  subjectType: 'task';
  settlementType: 'escrow';
  revieweePubkey: string;      // hex pubkey of the person being reviewed
  reviewerRole: string;        // e.g. 'client', 'tasker'
  revieweeRole: string;        // e.g. 'provider', 'taskee'
  contractOutcome: string;     // e.g. 'completed', 'refunded'
  createdAt: number;
  rating: {
    overallRating: number;     // 1-5
    categoryRatings: {         // depends on reviewerRole
      workQuality?: number;
      experience?: number;
      deliverySpeed?: number;
      communication?: number;
      clarity?: number;
      paymentTimeliness?: number;
    };
  };
  content: {
    sourceLanguage: 'en' | 'es';
    en: { comment: string };
    es: { comment: string };
  };
  attachments: Array<{
    url: string;
    key: string;
    type: 'image' | 'video';
    alt: string;
    size: number;
  }>;
}

function computeReviewDraftHash(payload: Omit<ReviewContent, 'reviewDraftHash'>): string {
  // Canonical JSON serialization (sorted keys), then SHA-256
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}
```

### Step 2: Request a challenge

```typescript
async function requestChallenge(
  apiUrl: string,
  reviewContent: ReviewContent,
  settlement: {
    subjectType: string; subjectId: string;
    settlementType: string; settlementId: string;
    chain: string; asset: string; contractAddress: string;
    reviewerNpub: string; revieweeNpub: string;
    reviewerWallet: string; revieweeWallet: string;
  }
): Promise<ChallengeResponse> {
  const response = await fetch(`${apiUrl}/review-attestations/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewDraftHash: reviewContent.reviewDraftHash,
      ...settlement
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new ReviewApiError(error.code, error.message);
  }

  return response.json();
}
```

### Step 3: Sign the challenge (dual signature)

The user must sign the `challengeMessage` with BOTH keys:

```typescript
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

// Nostr signature (Schnorr, BIP-340)
function signChallengeWithNostr(challengeMessage: string, nsecHex: string): string {
  const hash = sha256(utf8ToBytes(challengeMessage));
  const sig = schnorr.sign(hash, nsecHex);
  return bytesToHex(sig);
}

// EVM wallet signature (EIP-191 personal_sign)
async function signChallengeWithWallet(
  challengeMessage: string,
  walletAddress: string
): Promise<string> {
  if (!window.ethereum) throw new Error('Wallet not available');
  return window.ethereum.request({
    method: 'personal_sign',
    params: [challengeMessage, walletAddress]
  }) as Promise<string>;
}
```

### Step 4: Build and sign the review event (Kind 6430)

```typescript
import { finalizeEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';

function buildSignedReviewEvent(
  reviewContent: ReviewContent,
  reviewerNpub: string,
  reviewerNsecHex: string
) {
  const event = finalizeEvent(
    {
      kind: 6430,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', reviewContent.reviewDraftHash],
        ['p', reviewContent.revieweePubkey],
        ['subject', reviewContent.subjectType],
        ['settlement', reviewContent.settlementType]
      ],
      content: JSON.stringify(reviewContent)
    },
    hexToBytes(reviewerNsecHex)
  );
  return event;
}
```

### Step 5: Submit attestation

```typescript
async function submitAttestation(
  apiUrl: string,
  params: {
    challengeToken: string;
    signedReviewEvent: ReturnType<typeof buildSignedReviewEvent>;
    nostrChallengeSignature: string;
    walletChallengeSignature: string;
    // ... settlement fields, reviewer/reviewee npub/wallet
  }
): Promise<AttestationResponse> {
  const response = await fetch(`${apiUrl}/review-attestations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new ReviewApiError(error.code, error.message);
  }

  return response.json();
}
```

### Step 6: Confirm attestation on relays

After the backend returns success, subscribe to relays to confirm the attestation is published:

```typescript
import { SimplePool } from 'nostr-tools';

// Subscribe to Kind 6431 events by the issuer for this slot
function waitForAttestationConfirmation(
  relays: string[],
  issuerPubkey: string,
  slotHash: string,
  timeoutMs = 60000
): Promise<Event | null> {
  return new Promise((resolve) => {
    const pool = new SimplePool();
    const sub = pool.sub(relays, [{
      kinds: [6431],
      authors: [issuerPubkey],
      '#d': [slotHash],
      limit: 1
    }]);

    const timer = setTimeout(() => {
      sub.unsub();
      pool.destroy();
      resolve(null);
    }, timeoutMs);

    sub.on('event', (event: Event) => {
      clearTimeout(timer);
      sub.unsub();
      pool.destroy();
      resolve(event);
    });
  });
}
```

---

## 5. Reply Attestation Flow

The reply flow is nearly identical to the review flow but with these differences:

1. **No settlement resolution** — the parent review event ID identifies the context
2. **Reviewee-only** — the backend verifies the caller IS the reviewee from the original attested review
3. **Kind 6432** for reply events, **Kind 6433** for reply attestations
4. **One reply per review** — enforced by DO slot claiming

### Reply Content Structure

```typescript
interface ReplyContent {
  schemaVersion: 1;
  parentReviewEventId: string;  // 64-char hex
  revieweePubkey: string;       // hex
  createdAt: number;
  content: {
    sourceLanguage: 'en' | 'es';
    en: { comment: string };
    es: { comment: string };
  };
  attachments: Array<{
    url: string;
    key: string;
    type: 'image' | 'video';
    alt: string;
    size: number;
  }>;
}
```

### Reply Flow Steps

1. Compute `replyDraftHash` from reply content (same SHA-256 canonical approach as §4.1)
2. `POST /review-reply-attestations/challenge` with `{ parentReviewEventId, replyDraftHash, revieweeNpub, revieweeWallet }`
3. User signs challenge with both Nostr key and wallet
4. Build Kind 6432 signed reply event
5. `POST /review-reply-attestations` with signed reply, challenge token, and dual signatures
6. Wait for Kind 6433 attestation on relays

---

## 6. Error Handling

### Error Response Format

All errors follow this structure:
```json
{
  "schemaVersion": 1,
  "status": "error",
  "code": "error_code",
  "message": "Human-readable description",
  "retryAfterSeconds": 30   // only present for rate-limited errors
}
```

### Error Code Reference

| Code | HTTP | Meaning | Retry? |
|------|------|---------|--------|
| `resolver_not_found` | 404 | Settlement not found or contract not yet finalized | Yes (after delay) |
| `contract_outcome_invalid` | 409 | Settlement state is not reviewable | No |
| `settlement_not_reviewable` | 409 | Settlement missing participant identity bindings | No |
| `participant_mismatch` | 409 | Your keys don't match the settlement record | No |
| `nostr_signature_invalid` | 400 | Nostr challenge or event signature verification failed | No |
| `wallet_signature_invalid` | 400 | Wallet challenge signature verification failed | No |
| `challenge_expired` | 400 | Challenge token TTL exceeded (default: 15 minutes) | Yes (request new challenge) |
| `challenge_invalid` | 400 | Challenge token malformed or tampered with | Yes (request new challenge) |
| `review_event_invalid` | 400 | Review event content doesn't match challenge or settlement | No |
| `duplicate_review_slot` | 409 | A review already exists for this settlement | No |
| `duplicate_review_reply` | 409 | A reply already exists for this review | No |
| `reply_not_allowed` | 403 | Caller is not the reviewee of the original review | No |
| `rate_limited` | 429 | Too many requests | Yes (after retryAfterSeconds) |
| `attestation_publish_failed` | 502 | Failed to publish to Nostr relays | Yes (retry) |
| `issuer_unavailable` | 503 | Backend signing key not configured | Yes (retry) |
| `internal_error` | 500 | Unexpected backend error | Yes (exponential backoff) |

---

## 7. Frontend Utilities Reference

### API Client Class

```typescript
class ReviewsApiClient {
  constructor(private baseUrl: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new ReviewApiError(err.code, err.message, err.retryAfterSeconds);
    }
    return res.json();
  }

  async getIssuers(): Promise<IssuerRegistryResponse> {
    const res = await fetch(`${this.baseUrl}/review-attestation-issuers`);
    return res.json();
  }

  requestChallenge(req: ChallengeRequest) {
    return this.post<ChallengeResponse>('/review-attestations/challenge', req);
  }

  submitAttestation(req: AttestationRequest) {
    return this.post<AttestationResponse>('/review-attestations', req);
  }

  requestReplyChallenge(req: ReplyChallengeRequest) {
    return this.post<ChallengeResponse>('/review-reply-attestations/challenge', req);
  }

  submitReplyAttestation(req: ReplyAttestationRequest) {
    return this.post<AttestationResponse>('/review-reply-attestations', req);
  }
}

class ReviewApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfterSeconds?: number
  ) {
    super(message);
  }

  get isRetryable(): boolean {
    return [
      'rate_limited', 'challenge_expired', 'challenge_invalid',
      'attestation_publish_failed', 'internal_error', 'issuer_unavailable',
      'resolver_not_found'
    ].includes(this.code);
  }
}
```

### Signing Utilities

```typescript
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { bytesToHex } from 'nostr-tools/utils';
import { getEventHash, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools';

function signChallengeMessage(message: string, nsecHex: string): string {
  return bytesToHex(
    schnorr.sign(sha256(utf8ToBytes(message)), nsecHex)
  );
}

function buildSignedNostrEvent(
  event: { kind: number; created_at: number; tags: string[][]; content: string },
  pubkey: string,
  nsecHex: string
) {
  const template = { ...event, pubkey, created_at: event.created_at };
  const id = getEventHash(template);
  const sig = schnorr.sign(sha256(utf8ToBytes(JSON.stringify([0, pubkey, template.created_at, template.kind, template.tags, template.content]))), nsecHex);
  return { ...template, id, sig: bytesToHex(sig) };
}
```

---

## 8. Environment Configuration

```bash
# .env
VITE_REVIEWS_ATTESTATION_API_URL=https://reviews-api.bittasker.io

# Relays used for attestation subscription (can be multiple, comma-separated)
VITE_NOSTR_RELAYS=wss://relay.bittasker.hedgehackers.io,wss://nos.lol,wss://relay.nostpy.com

# Issuer pubkey (get from GET /review-attestation-issuers)
VITE_ISSUER_PUBKEY=0123456789abcdef...
```

---

## 9. Querying Attestations from Relays

The backend does NOT provide attestation query endpoints. The frontend queries Nostr relays directly — this is lower latency and reduces backend load.

### 9.1 By Event ID

```typescript
const events = await pool.querySync(relays, {
  kinds: [6431],
  ids: [eventId],
  limit: 1
});
```

### 9.2 By Settlement Slot (NIP-33 d-tag query)

The `d` tag on Kind 6431 attestation events is the `slotHash`. To query the latest attestation for a given settlement:

```typescript
const events = await pool.querySync(relays, {
  kinds: [6431],
  authors: [issuerPubkey],
  '#d': [slotHash],
  limit: 1
});
```

**How to get the slotHash:**
- It's embedded in the challenge token payload (base64url decode the middle segment)
- It's the `d` tag on the attestation event returned by the backend

### 9.3 By Reviewer Pubkey

```typescript
const events = await pool.querySync(relays, {
  kinds: [6431],
  '#p': [reviewerPubkey],
  limit: 20
});
```

### 9.4 Live Subscription

```typescript
const sub = pool.sub(relays, [{
  kinds: [6431],
  authors: [issuerPubkey],
  since: Math.floor(Date.now() / 1000)
}]);
sub.on('event', (event) => { /* handle new attestation */ });
```

---

## 10. Complete Example

```typescript
// Complete review submission flow
async function submitReview(
  api: ReviewsApiClient,
  reviewData: {
    overallRating: number;
    categoryRatings: Record<string, number>;
    commentEn: string;
    commentEs: string;
  },
  settlement: {
    subjectType: string; subjectId: string;
    settlementType: string; settlementId: string;
    chain: string; asset: string; contractAddress: string;
    reviewerNpub: string; revieweeNpub: string;
    reviewerWallet: string; revieweeWallet: string;
    reviewerNsecHex: string;
  }
): Promise<string> {
  // 1. Build review content
  const reviewContent: Omit<ReviewContent, 'reviewDraftHash'> = {
    schemaVersion: 1,
    subjectType: settlement.subjectType as 'task',
    settlementType: settlement.settlementType as 'escrow',
    revieweePubkey: settlement.revieweeNpub,
    reviewerRole: 'client',
    revieweeRole: 'provider',
    contractOutcome: 'completed',
    createdAt: Date.now(),
    rating: {
      overallRating: reviewData.overallRating,
      categoryRatings: reviewData.categoryRatings
    },
    content: {
      sourceLanguage: 'en',
      en: { comment: reviewData.commentEn },
      es: { comment: reviewData.commentEs }
    },
    attachments: []
  };

  const reviewDraftHash = computeReviewDraftHash(reviewContent);
  const fullContent = { ...reviewContent, reviewDraftHash };

  // 2. Request challenge
  const challenge = await api.requestChallenge({
    reviewDraftHash,
    ...settlement
  });

  // 3. Dual-sign the challenge
  const nostrSig = signChallengeMessage(
    challenge.challengeMessage,
    settlement.reviewerNsecHex
  );
  const walletSig = await signChallengeWithWallet(
    challenge.challengeMessage,
    settlement.reviewerWallet
  );

  // 4. Build signed review event
  const signedEvent = buildSignedNostrEvent(
    {
      kind: 6430,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', reviewDraftHash],
        ['p', settlement.revieweeNpub],
        ['subject', settlement.subjectType],
        ['settlement', settlement.settlementType]
      ],
      content: JSON.stringify(fullContent)
    },
    settlement.reviewerNpub,
    settlement.reviewerNsecHex
  );

  // 5. Submit attestation
  const result = await api.submitAttestation({
    reviewDraftHash,
    signedReviewEvent: signedEvent,
    challengeToken: challenge.challengeToken,
    nostrChallengeSignature: nostrSig,
    walletChallengeSignature: walletSig,
    ...settlement
  });

  return result.attestationEventId;
}
```

---

## Nostr Event Kinds Reference

| Kind | Name | Published by | Description |
|------|------|-------------|-------------|
| 6430 | Review | Reviewer (client) | User's review content, signed with reviewer's nsec |
| 6431 | Attestation | Issuer (backend) | Cryptographic attestation that the review is valid |
| 6432 | Reply | Reviewee | The reviewed person's response |
| 6433 | Reply Attestation | Issuer (backend) | Cryptographic attestation that the reply is valid |

## Nostr Tags Reference

| Tag | Used on | Meaning |
|-----|---------|---------|
| `d` | 6430, 6431, 6432, 6433 | NIP-33 instance identifier (reviewDraftHash for 6430, slotHash for 6431) |
| `e` | 6431, 6433 | Referenced event ID (original review) |
| `p` | 6430, 6431, 6432, 6433 | Participant hex pubkey |
| `subject` | 6430, 6431 | Review subject type (`task`, `service_booking`) |
| `settlement` | 6430, 6431 | Settlement type (`escrow`, etc.) |

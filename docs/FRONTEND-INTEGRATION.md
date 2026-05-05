# Frontend Integration Guide - Nostr Reviews Attestation System

**Version:** 0.1.0
**Last Updated:** 2026-05-04
**Status:** Planning

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Integration Flow](#3-integration-flow)
4. [Prerequisites](#4-prerequisites)
5. [Step-by-Step Implementation](#5-step-by-step-implementation)
6. [API Reference](#6-api-reference)
7. [Environment Configuration](#7-environment-configuration)
8. [Error Handling](#8-error-handling)
9. [Testing Strategy](#9-testing-strategy)
10. [Migration Path](#10-migration-path)

---

## 1. Overview

This guide describes how the BitTasker frontend (SvelteKit application) integrates with the `nostr-reviews-verifier` Cloudflare Workers backend to enable cryptographically verified reviews for escrow-based task completion.

### 1.1 What This System Does

The review attestation system provides:
- **Dual-key verified reviews**: Reviews require both Nostr key + EVM wallet signatures
- **On-chain settlement verification**: Reviews are only allowed after escrow is finalized on-chain
- **Tamper-proof attestations**: Published to Nostr relays as immutable events
- **Decentralized verification**: Anyone can verify reviews without the original service

### 1.2 Key Design Principle: No API Keys, Keys Never Leave Client

**This system is end-to-end encryption by design.**

There is **NO** traditional authentication (no API keys, no JWTs, no sessions). The system uses cryptographic challenge-response:

1. User's Nostr key **never leaves** the client
2. User's wallet private key **never leaves** the wallet (only the wallet signs on user's request)
3. The backend only receives **signatures** (proof of key possession), not the keys themselves

**The flow:**
```
Frontend ──▶ "I want to review settlement X" ──▶ Backend
              (no auth needed, rate limited by IP)

Backend ──▶ Challenge token (server-signed) ──▶ Frontend

Frontend ──▶ "Here's my review + dual signatures proving I own keys" ──▶ Backend
              (cryptographic proof, not authentication)

Backend ──▶ Verify signatures, publish to Nostr ──▶ Done
```

### 1.3 Key Components

| Component | Description |
|-----------|-------------|
| `nostr-reviews-verifier` | Cloudflare Workers backend (this repo) |
| BitTasker Frontend | SvelteKit app that users interact with |
| Nostr Relays | Decentralized event broadcast network |
| RSK/BSC Blockchain | Where escrow contracts live |
| User's Nostr Key | Secp256k1 key for Nostr identity (NEVER sent to backend) |
| User's EVM Wallet | Ethereum-compatible wallet (MetaMask, etc.) - signs locally |

---

## 2. System Architecture

### 2.1 High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          BITTASKER FRONTEND                                  │
│                         (SvelteKit Application)                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
┌──────────────────────────────┐    ┌──────────────────────────────────────┐
│   HTTP API Calls             │    │   Nostr Relay Subscriptions            │
│                              │    │                                        │
│   POST /challenge            │    │   Subscribe to Kind 6431 events       │
│   POST /attestations          │    │   for attestation updates              │
│   GET  /review-attestations  │    │                                        │
└──────────────────────────────┘    └──────────────────────────────────────┘
            │                                        │
            │ HTTPS                                  │ WSS
            ▼                                        ▼
┌──────────────────────────────┐    ┌──────────────────────────────────────┐
│  nostr-reviews-verifier      │    │  Nostr Relays                         │
│  (Cloudflare Workers)        │    │                                       │
│                              │    │  wss://relay.bittasker.hedgehackers.io │
│  • Validates settlement      │    │  wss://relay.nostpy.com               │
│  • Issues challenge tokens   │    │  wss://nos.lol                         │
│  • Verifies dual signatures  │    │                                       │
│  • Publishes attestations    │    └──────────────────────────────────────┘
└──────────────────────────────┘
            │
            │ RPC
            ▼
┌──────────────────────────────┐
│  RSK/BSC Blockchain         │
│                              │
│  EscrowContract V2          │
│  SecurePaymentContract       │
└──────────────────────────────┘
```

### 2.2 Frontend Responsibilities

The frontend is responsible for:

1. **User Experience**
   - Display review forms with rating inputs
   - Show signing prompts for Nostr key and wallet
   - Display attestation status and results

2. **Signature Collection**
   - Request challenge from backend
   - Prompt user to sign challenge with Nostr key
   - Prompt user to sign challenge with EVM wallet
   - Submit signed attestation request

3. **Result Subscription**
   - Subscribe to Nostr relays for attestation events
   - Display confirmation when attestation is confirmed

### 2.3 Backend Responsibilities

The backend (`nostr-reviews-verifier`) handles:

1. **Settlement Verification**
   - Query blockchain for escrow state
   - Validate settlement is finalized/reviewable

2. **Challenge Issuance**
   - Generate time-limited challenge token
   - Sign challenge with issuer key

3. **Attestation Verification**
   - Verify Nostr event signature
   - Verify Schnorr signature of challenge
   - Verify EVM wallet signature
   - Publish attestation to relays

---

## 3. Integration Flow

### 3.1 Complete Review Attestation Flow

```
USER FLOW (Frontend)                    BACKEND FLOW (nostr-reviews-verifier)
─────────────────────────────────       ───────────────────────────────────────

1. User completes task
   │
   ▼
2. Frontend: POST /challenge
   {                                        Backend:
     subjectType: "task",                    1. Resolve settlement from registry/RPC
     subjectId: "task-123",                 2. Verify settlement is reviewable
     settlementType: "escrow",              3. Check rate limits
     settlementId: "escrow-456",            4. Generate challenge token
     chain: "rsk",                          5. Sign token with issuer key
     asset: "rbtc",                         6. Return challenge to frontend
     contractAddress: "0x...",
     reviewerNpub: "npub1...",
     revieweeNpub: "npub1...",
     reviewerWallet: "0x...",
     revieweeWallet: "0x..."
   }
   │
   ▼
3. Frontend shows signing prompt
   │
   ▼
4a. User signs with Nostr key
     └─▶ Signs challengeMessage with nsec
   │
4b. User signs with EVM wallet
     └─▶ Signs challengeMessage with wallet
   │
   ▼
5. Frontend: POST /attestations
   {
     challengeToken: "v1.b64url.sig",
     reviewerNpub: "npub1...",
     reviewerWallet: "0x...",
     nostrChallengeSignature: "sig",
     walletChallengeSignature: "0x...",
     signedReviewEvent: {
       id: "event-id",
       pubkey: "npub1...",
       kind: 6430,
       tags: [...],
       content: "{...}",
       sig: "event-sig"
     }
   }
   │
   ▼                                         Backend:
                                              1. Parse challenge token
                                              2. Verify challenge signature
                                              3. Verify Nostr event signature
                                              4. Verify Schnorr signature
                                              5. Verify EVM signature
                                              6. Validate review content
                                              7. Claim slot (atomic)
                                              8. Publish to Nostr relays
                                              9. Return attestation event ID
   │
   ▼
6. Frontend subscribes to relay
   for Kind 6431 events by issuer
   │
   ▼
7. Relay delivers attestation event
   (Kind 6431, d=slotHash)
   │
   ▼
8. Frontend confirms to user:
   "Your review has been attested!"
```

### 3.2 Review Form Flow (UI States)

```
┌─────────────────────────────────────────────────────────────────┐
│                        REVIEW FORM STATES                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  STATE: idle                                                    │
│  ─────────────────                                              │
│  • Task just completed                                          │
│  • "Leave a Review" button visible                              │
│                                                                  │
│                          │                                       │
│                          ▼                                       │
│  STATE: form                                                         │
│  ─────────────────                                                         │
│  • Rating inputs (1-5 stars)                                    │
│  • Category ratings (workQuality, communication, etc.)          │
│  • Comment textarea (en/es)                                     │
│  • "Submit Review" button                                       │
│                                                                  │
│                          │                                       │
│                          ▼                                       │
│  STATE: signing                                                     │
│  ─────────────────                                                     │
│  • "Sign with Nostr Key" prompt                                  │
│  • "Sign with Wallet" prompt                                     │
│  • Progress indicator                                            │
│                                                                  │
│                          │                                       │
│                    ┌─────┴─────┐                                 │
│                    │ success   │ error                           │
│                    ▼           ▼                                 │
│  STATE: submitted    STATE: error                                 │
│  ────────────────    ───────────                                 │
│  • Spinner showing  • Error message                             │
│    "Waiting for     • "Retry" button                            │
│     confirmation"   • "Try Again" link                          │
│                                                                  │
│                          │                                       │
│                          ▼                                       │
│  STATE: confirmed                                                     │
│  ───────────────────                                                     │
│  • Checkmark animation                                           │
│  • "Review Attested" message                                    │
│  • Link to attestation on Nostr                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Prerequisites

### 4.1 Frontend Requirements

| Requirement | Description |
|-------------|-------------|
| SvelteKit | Framework for the frontend app |
| `@nostr-dev-kit/ndk` | Nostr SDK for event signing and subscriptions |
| `nostr-tools` | Additional Nostr utilities |
| `viem` | EVM wallet signature verification (if needed client-side) |
| Environment | `VITE_REVIEWS_ATTESTATION_API_URL` |

### 4.2 User Requirements

| Requirement | Description |
|-------------|-------------|
| Nostr Key | Secp256k1 key pair (npub/nsec) |
| EVM Wallet | MetaMask, Rabby, or similar |
| Browser Extension | Nostr signing extension (Alby, nos2x, etc.) |

### 4.3 Backend Requirements

See `IMPLEMENTATION-PLAN.md` Section 12 for full deployment requirements.

---

## 5. Step-by-Step Implementation

### 5.1 Step 1: Environment Configuration

Add to your frontend's `.env` file:

```bash
# Frontend environment variables (.env)
VITE_REVIEWS_ATTESTATION_API_URL=https://reviews-api.bittasker.io
VITE_NOSTR_RELAY_URL=wss://relay.bittasker.hedgehackers.io
```

For local development:

```bash
# .env.local
VITE_REVIEWS_ATTESTATION_API_URL=http://localhost:8787
VITE_NOSTR_RELAY_URL=wss://relay.bittasker.hedgehackers.io
```

### 5.2 Step 2: API Client Module

Create a module to interact with the attestation backend:

```typescript
// src/lib/reviews-attestation-api.ts

const API_BASE = import.meta.env.VITE_REVIEWS_ATTESTATION_API_URL;

export interface ChallengeRequest {
    subjectType: 'task' | 'service_booking';
    subjectId: string;
    settlementType: 'escrow' | 'service_quote_contract' | 'instant_buy_contract';
    settlementId: string;
    chain: 'rsk' | 'bsc';
    asset: 'rbtc' | 'usdt';
    contractAddress: string;
    reviewerNpub: string;
    revieweeNpub: string;
    reviewerWallet: string;
    revieweeWallet: string;
}

export interface ChallengeResponse {
    schemaVersion: number;
    challengeToken: string;
    challengeMessage: string;
    issuedAt: number;
    expiresAt: number;
}

export interface AttestationRequest {
    challengeToken: string;
    reviewerNpub: string;
    revieweeNpub: string;
    reviewerWallet: string;
    revieweeWallet: string;
    nostrChallengeSignature: string;
    walletChallengeSignature: string;
    signedReviewEvent: {
        id: string;
        pubkey: string;
        kind: number;
        tags: string[][];
        content: string;
        sig: string;
    };
}

export interface AttestationResponse {
    schemaVersion: number;
    status: 'ok';
    attestationEventId: string;
    issuerPubkey: string;
    reviewDraftHash: string;
    issuedAt: number;
}

export class ReviewsAttestationApi {
    private baseUrl: string;

    constructor(baseUrl: string = API_BASE) {
        this.baseUrl = baseUrl;
    }

    async requestChallenge(request: ChallengeRequest): Promise<ChallengeResponse> {
        const response = await fetch(`${this.baseUrl}/review-attestations/challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new ReviewApiError(error.code, error.message);
        }

        return response.json();
    }

    async submitAttestation(request: AttestationRequest): Promise<AttestationResponse> {
        const response = await fetch(`${this.baseUrl}/review-attestations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new ReviewApiError(error.code, error.message);
        }

        return response.json();
    }

    async getAttestation(eventId: string): Promise<AttestationResponse | null> {
        const response = await fetch(`${this.baseUrl}/review-attestations/${eventId}`);

        if (response.status === 404) return null;
        if (!response.ok) {
            const error = await response.json();
            throw new ReviewApiError(error.code, error.message);
        }

        return response.json();
    }
}

export class ReviewApiError extends Error {
    constructor(
        public code: string,
        message: string,
        public retryAfterSeconds?: number
    ) {
        super(message);
        this.name = 'ReviewApiError';
    }
}

// Singleton instance
export const reviewsApi = new ReviewsAttestationApi();
```

### 5.3 Step 3: Nostr Signing Utilities

Create utilities for Nostr signing (using `@nostr-dev-kit/ndk`):

```typescript
// src/lib/nostr-signing.ts
import { getEventHash, signEvent } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/pure';

export interface SignedEvent {
    id: string;
    pubkey: string;
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
    sig: string;
}

/**
 * Signs a Nostr event with the user's nsec
 */
export async function signNostrEvent(
    event: Omit<Event, 'id' | 'sig'>,
    nsec: string
): Promise<SignedEvent> {
    const id = getEventHash({ ...event, pubkey: event.pubkey } as Event);
    const sig = signEvent({ ...event, id } as Event, nsec);

    return {
        ...event,
        id,
        sig
    } as SignedEvent;
}

/**
 * Gets the npub from a hex private key
 */
export function getNpubFromHex(hexPriv: string): string {
    // Implementation using @ nostr-dev-kit/ndk or noble/secp256k1
    // Return npub1... format
}
```

### 5.4 Step 4: Wallet Signing Utilities

Create utilities for EVM wallet signing:

```typescript
// src/lib/wallet-signing.ts

declare global {
    interface Window {
        ethereum?: {
            isMetaMask?: boolean;
            request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
            selectedAddress?: string;
        };
    }
}

/**
 * Signs a message with the user's EVM wallet
 * Uses EIP-191 format
 */
export async function signWithWallet(
    message: string,
    address: string
): Promise<string> {
    if (!window.ethereum) {
        throw new Error('No EVM wallet detected. Please install MetaMask.');
    }

    const signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [message, address]
    }) as string;

    return signature;
}

/**
 * Gets the connected wallet address
 */
export async function getConnectedWallet(): Promise<string | null> {
    if (!window.ethereum) return null;

    const accounts = await window.ethereum.request({
        method: 'eth_accounts'
    }) as string[];

    return accounts[0] || null;
}

/**
 * Requests wallet connection
 */
export async function connectWallet(): Promise<string[]> {
    if (!window.ethereum) {
        throw new Error('No EVM wallet detected. Please install MetaMask.');
    }

    return window.ethereum.request({
        method: 'eth_requestAccounts'
    }) as Promise<string[]>;
}
```

### 5.5 Step 5: Review Form Component

Create a Svelte component for the review form:

```svelte
<!-- src/lib/components/ReviewForm.svelte -->
<script lang="ts">
    import { reviewsApi, type ChallengeRequest, type AttestationRequest } from '$lib/reviews-attestation-api';
    import { signNostrEvent } from '$lib/nostr-signing';
    import { signWithWallet } from '$lib/wallet-signing';

    // Props
    export let settlement: {
        subjectType: 'task';
        subjectId: string;
        settlementId: string;
        contractAddress: string;
        reviewerNpub: string;
        revieweeNpub: string;
        reviewerWallet: string;
        revieweeWallet: string;
        chain: 'rsk';
        asset: 'rbtc';
    };
    export let userNsec: string; // User's Nostr private key
    export let onSuccess: (eventId: string) => void;
    export let onError: (error: Error) => void;

    // State
    let state: 'idle' | 'form' | 'signing' | 'submitting' | 'confirmed' | 'error' = 'idle';
    let errorMessage = '';

    // Form data
    let overallRating = 0;
    let workQuality = 0;
    let communication = 0;
    let paymentTimeliness = 0;
    let comment = '';
    let commentEs = '';

    async function handleSubmit() {
        try {
            state = 'signing';

            // 1. Request challenge from backend
            const challengeRequest: ChallengeRequest = {
                subjectType: settlement.subjectType,
                subjectId: settlement.subjectId,
                settlementType: 'escrow',
                settlementId: settlement.settlementId,
                chain: settlement.chain,
                asset: settlement.asset,
                contractAddress: settlement.contractAddress,
                reviewerNpub: settlement.reviewerNpub,
                revieweeNpub: settlement.revieweeNpub,
                reviewerWallet: settlement.reviewerWallet,
                revieweeWallet: settlement.revieweeWallet
            };

            const challenge = await reviewsApi.requestChallenge(challengeRequest);

            // 2. Build review event (Kind 6430)
            const reviewEvent = {
                kind: 6430,
                pubkey: settlement.reviewerNpub,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['d', challenge.challengeMessage], // d tag for NIP-33
                    ['subject', settlement.subjectType],
                    ['settlement', settlement.settlementId]
                ],
                content: JSON.stringify({
                    overallRating,
                    categoryRatings: {
                        workQuality,
                        communication,
                        paymentTimeliness
                    },
                    content: {
                        en: comment,
                        es: commentEs
                    }
                })
            };

            // 3. Sign review event with Nostr key
            const signedReviewEvent = await signNostrEvent(reviewEvent, userNsec);

            // 4. Sign challenge with Nostr key
            const nostrChallengeSig = await signMessageWithNostr(
                challenge.challengeMessage,
                userNsec
            );

            // 5. Sign challenge with wallet
            state = 'submitting';
            const walletChallengeSig = await signWithWallet(
                challenge.challengeMessage,
                settlement.reviewerWallet
            );

            // 6. Submit attestation
            const attestationRequest: AttestationRequest = {
                challengeToken: challenge.challengeToken,
                reviewerNpub: settlement.reviewerNpub,
                revieweeNpub: settlement.revieweeNpub,
                reviewerWallet: settlement.reviewerWallet,
                revieweeWallet: settlement.revieweeWallet,
                nostrChallengeSignature: nostrChallengeSig,
                walletChallengeSignature: walletChallengeSig,
                signedReviewEvent: signedReviewEvent
            };

            const result = await reviewsApi.submitAttestation(attestationRequest);

            state = 'confirmed';
            onSuccess(result.attestationEventId);

        } catch (err) {
            state = 'error';
            errorMessage = err instanceof Error ? err.message : 'Unknown error';
            onError(err instanceof Error ? err : new Error(errorMessage));
        }
    }
</script>

<!-- Template continues with form fields and state-based UI -->
```

### 5.6 Step 6: Attestation Subscription

Create a subscription to watch for attestation confirmation:

```typescript
// src/lib/reviews-subscription.ts
import { createRxOnePlayer } from 'rx-nostr';
import { firstValueFrom, timeout } from 'rxjs';

const RELAYS = [
    'wss://relay.bittasker.hedgehackers.io',
    'wss://nos.lol',
    'wss://relay.nostpy.com'
];

const ISSUER_PUBKEY = import.meta.env.VITE_ISSUER_PUBKEY;

export interface AttestationEvent {
    id: string;
    pubkey: string;
    kind: 6431;
    created_at: number;
    tags: string[][];
    content: string;
    sig: string;
}

/**
 * Subscribes to attestation events for a specific slot hash
 * Uses NIP-33 semantics: latest event by issuer with d=slotHash
 */
export async function waitForAttestation(
    slotHash: string,
    timeoutMs = 60000
): Promise<AttestationEvent | null> {
    const player = createRxOnePlayer();
    await player.setRelays(RELAYS);

    const subscription = player.subscribe({
        kinds: [6431],
        authors: [ISSUER_PUBKEY],
        '#d': [slotHash],
        limit: 1
    });

    try {
        const event = await firstValueFrom(
            player.on(),
            { timeout: timeoutMs }
        );

        return event as unknown as AttestationEvent;
    } catch {
        return null; // Timeout
    } finally {
        subscription.unsubscribe();
    }
}

/**
 * Queries relays for attestation by event ID
 */
export async function getAttestationById(
    eventId: string
): Promise<AttestationEvent | null> {
    const player = createRxOnePlayer();
    await player.setRelays(RELAYS);

    const events = await player.query({
        kinds: [6431],
        ids: [eventId],
        limit: 1
    });

    return events[0] as unknown as AttestationEvent || null;
}
```

### 5.7 Step 7: Error Handling

Create comprehensive error handling:

```typescript
// src/lib/reviews-errors.ts

export interface ReviewError {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
}

export const ERROR_CODES: Record<string, ReviewError> = {
    settlement_not_found: {
        code: 'settlement_not_found',
        message: 'Settlement not found or not yet reviewable',
        retryable: false
    },
    rate_limited: {
        code: 'rate_limited',
        message: 'Too many requests. Please try again later.',
        retryable: true
    },
    invalid_signature: {
        code: 'invalid_signature',
        message: 'Signature verification failed',
        retryable: false
    },
    duplicate_review_slot: {
        code: 'duplicate_review_slot',
        message: 'A review has already been submitted for this settlement',
        retryable: false
    },
    challenge_expired: {
        code: 'challenge_expired',
        message: 'Challenge has expired. Please request a new one.',
        retryable: true
    },
    attestation_publish_failed: {
        code: 'attestation_publish_failed',
        message: 'Failed to publish attestation. Please try again.',
        retryable: true
    }
};

export function parseReviewError(error: unknown): ReviewError {
    if (error instanceof ReviewApiError) {
        return {
            code: error.code,
            message: error.message,
            retryable: error.retryAfterSeconds !== undefined,
            retryAfterSeconds: error.retryAfterSeconds
        };
    }

    if (error instanceof Error) {
        return {
            code: 'unknown',
            message: error.message,
            retryable: true
        };
    }

    return {
        code: 'unknown',
        message: 'An unexpected error occurred',
        retryable: true
    };
}
```

---

## 6. API Reference

### 6.1 POST /review-attestations/challenge

**Description:** Request a challenge token for review attestation.

**Request:**
```json
{
    "subjectType": "task",
    "subjectId": "task-123",
    "settlementType": "escrow",
    "settlementId": "escrow-456",
    "chain": "rsk",
    "asset": "rbtc",
    "contractAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE8C",
    "reviewerNpub": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn",
    "revieweeNpub": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqeq6c2j",
    "reviewerWallet": "0x1234567890AbcdEF1234567890aBcDeF12345678",
    "revieweeWallet": "0xFeDcBa0987654321FeDcBa0987654321fEdCbA09"
}
```

**Response (200):**
```json
{
    "schemaVersion": 1,
    "challengeToken": "v1.eyJzY2hlbWFWZXJzaW9uIjoxLCJzbG90SGFzaCI6Ii4uLiIsInJldmlld0RyYWZ0SGFzaCI6Ii4uLiIsImlzc3VlZEF0IjoxNzE0MDAwMDAwMCwiZXhwaXJlZEF0IjoxNzE0MDAwOTAwMCIsIm5vbmNlIjoiLi4uIiwia2V5SWQiOiJyZXZpZXdzLWF0dGVzdGF0aW9uLWlzc3Vlci12MSJ9.signature",
    "challengeMessage": "Verify challenge: v1.ey... at 1714000000 for slot abc123 with review abc456",
    "issuedAt": 1714000000000,
    "expiresAt": 1714000900000
}
```

**Error Responses:**
- `400` - Invalid request body
- `404` - Settlement not found
- `429` - Rate limited

### 6.2 POST /review-attestations

**Description:** Submit a signed review for attestation.

**Request:**
```json
{
    "challengeToken": "v1.eyJzY2hlbWFWZXJzaW9uIjox...",
    "reviewerNpub": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn",
    "revieweeNpub": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqeq6c2j",
    "reviewerWallet": "0x1234567890AbcdEF1234567890aBcDeF12345678",
    "revieweeWallet": "0xFeDcBa0987654321FeDcBa0987654321fEdCbA09",
    "nostrChallengeSignature": "signature_hex_128_chars",
    "walletChallengeSignature": "0xsignature_hex",
    "signedReviewEvent": {
        "id": "event_id_hex",
        "pubkey": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn",
        "kind": 6430,
        "tags": [["d", "slot_hash"]],
        "content": "{\"overallRating\":5,\"categoryRatings\":{...},\"content\":{\"en\":\"...\",\"es\":\"...\"}}",
        "sig": "event_signature_hex"
    }
}
```

**Response (200):**
```json
{
    "schemaVersion": 1,
    "status": "ok",
    "attestationEventId": "attestation_event_id",
    "issuerPubkey": "npub1...issuer...",
    "reviewDraftHash": "hash_hex",
    "issuedAt": 1714000000000
}
```

**Error Responses:**
- `400` - Invalid request
- `401` - Invalid challenge signature
- `404` - Settlement not found
- `409` - Duplicate attestation
- `429` - Rate limited

### 6.3 GET /review-attestations/:id

**Description:** Get an attestation by event ID.

**Response (200):**
```json
{
    "schemaVersion": 1,
    "status": "ok",
    "attestationEventId": "...",
    "issuerPubkey": "...",
    "reviewDraftHash": "...",
    "issuedAt": 1714000000000
}
```

### 6.4 GET /review-attestations/slot/:slotHash

**Description:** Get the latest attestation for a settlement slot (NIP-33 query).

**Response (200):**
```json
{
    "schemaVersion": 1,
    "status": "ok",
    "attestationEventId": "...",
    "slotHash": "...",
    "issuerPubkey": "...",
    "reviewDraftHash": "...",
    "issuedAt": 1714000000000
}
```

---

## 7. Environment Configuration

### 7.1 Frontend Environment Variables

```bash
# .env.example

# Reviews Attestation API
VITE_REVIEWS_ATTESTATION_API_URL=https://reviews-api.bittasker.io

# Nostr Relays
VITE_NOSTR_RELAY_URL=wss://relay.bittasker.hedgehackers.io

# Attestation Issuer Public Key (for subscription filtering)
VITE_ISSUER_PUBKEY=npub1...issuer...

# Optional: Alternative relay for redundancy
VITE_NOSTR_RELAY_BACKUP=wss://nos.lol
```

### 7.2 CORS Configuration (Backend)

The backend must have CORS configured to allow frontend origins:

```bash
# Backend wrangler.toml vars
ALLOWED_ORIGINS=https://bittasker.io,https://www.bittasker.io,http://localhost:5173
```

---

## 8. Error Handling

### 8.1 User-Facing Error Messages

| Error Code | User Message | Action |
|------------|--------------|--------|
| `settlement_not_found` | "This task cannot be reviewed yet. Please try again later." | Retry after delay |
| `rate_limited` | "You've submitted too many reviews. Please wait {X} seconds." | Show countdown |
| `invalid_signature` | "Signature verification failed. Please ensure your keys are correct." | Check keys |
| `duplicate_review_slot` | "You've already submitted a review for this task." | Show existing review |
| `challenge_expired` | "Your signing session expired. Please try again." | Auto-retry |
| `attestation_publish_failed` | "Network error. Your review was saved locally." | Retry with local copy |

### 8.2 Retry Logic

```typescript
async function submitReviewWithRetry(
    request: AttestationRequest,
    maxRetries = 3,
    baseDelayMs = 1000
): Promise<AttestationResponse> {
    let lastError: Error;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await reviewsApi.submitAttestation(request);
        } catch (error) {
            lastError = error;

            if (error instanceof ReviewApiError && !error.retryAfterSeconds) {
                throw error; // Non-retryable error
            }

            const delay = error.retryAfterSeconds
                ? error.retryAfterSeconds * 1000
                : baseDelayMs * Math.pow(2, attempt);

            await sleep(delay);
        }
    }

    throw lastError!;
}
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

Test individual functions:
- Challenge token parsing
- Signature verification
- Event building

### 9.2 Integration Tests

```typescript
// tests/integration/review-flow.test.ts
import { describe, it, expect } from 'vitest';
import { reviewsApi } from '$lib/reviews-attestation-api';

describe('Review Attestation Flow', () => {
    it('should complete full attestation flow', async () => {
        // 1. Request challenge
        const challenge = await reviewsApi.requestChallenge({
            subjectType: 'task',
            subjectId: 'test-task-1',
            settlementType: 'escrow',
            settlementId: 'test-escrow-1',
            chain: 'rsk',
            asset: 'rbtc',
            contractAddress: '0x...',
            reviewerNpub: 'npub1...',
            revieweeNpub: 'npub1...',
            reviewerWallet: '0x...',
            revieweeWallet: '0x...'
        });

        expect(challenge.challengeToken).toBeDefined();
        expect(challenge.expiresAt).toBeGreaterThan(Date.now());

        // 2. Sign and submit (mock signatures for unit test)
        // ...

        // 3. Verify attestation
        // ...
    });
});
```

### 9.3 E2E Tests

Using Playwright or similar for full browser testing:
- Form submission
- Wallet signing prompts
- Error state handling
- Success confirmation

---

## 10. Migration Path

### 10.1 Current State (BitTasker)

The current BitTasker implementation:
- Publishes reviews directly to Nostr (Kind 6411)
- Uses `publishVerifiedReview()` function
- No attestation backend integration

### 10.2 Target State

Reviews go through the full attestation flow:
1. Challenge requested from `nostr-reviews-verifier`
2. Dual signatures collected
3. Attestation published to relays (Kind 6431)
4. Frontend subscribes for confirmation

### 10.3 Migration Steps

**Phase 1: Parallel Run (Week 1-2)**
- Deploy `nostr-reviews-verifier` alongside existing system
- Both systems publish reviews
- Monitor attestation backend errors

**Phase 2: Gradual Migration (Week 3-4)**
- New reviews use attestation backend
- Old reviews remain on existing system
- Aggregate display shows both sources

**Phase 3: Full Cutover (Week 5)**
- All new reviews go through attestation backend
- Deprecate old review publishing
- Update clients to use new flow only

---

## Appendix A: Event Kinds Reference

| Kind | Name | Description |
|------|------|-------------|
| 6430 | Review | User's review content |
| 6431 | Attestation | Issuer's attestation of the review |
| 6432 | Reply | Reviewee's response to a review |

## Appendix B: Nostr Tags Reference

| Tag | Description | Example |
|-----|-------------|---------|
| `d` | Instance identifier (NIP-33) | `d` tag for replaceable events |
| `e` | Event reference | Original review event ID |
| `p` | Pubkey | Participant pubkeys |
| `subject` | Review subject type | `task` |
| `settlement` | Settlement type | `escrow` |

## Appendix C: Dependencies

```json
{
    "dependencies": {
        "nostr-tools": "^2.0.0",
        "@nostr-dev-kit/ndk": "^2.0.0",
        "rx-nostr": "^3.0.0"
    }
}
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1.0 | 2026-05-04 | Claude | Initial draft |

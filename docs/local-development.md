# Reviews Attestation Backend — Local Development Guide

## Overview

This guide covers running the reviews attestation backend (Hono API on Cloudflare Workers) locally and packaging `@bittasker/reviews-contracts` for local consumption and npm publishing.

---

## 1. Building & Packing `reviews-contracts`

The shared contracts package lives at `packages/reviews-contracts/` and provides types, Zod schemas, enums, and hash utilities used by both the backend and the frontend.

### Build

```bash
cd packages/reviews-contracts
npm run build
```

This runs `tsc -p tsconfig.json` which compiles TypeScript from `src/` to `dist/`, producing `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` files. The `dist/` directory is already built and checked in, but rebuilding ensures it's current.

Verify the build output:

```bash
ls dist/
# Should see: index.js, index.d.ts, constants.js, enums.js, schemas.js, etc.
```

### Pack for local use

```bash
npm pack
```

This produces `bittasker-reviews-contracts-0.0.1.tgz` in the package directory. This `.tgz` file can be:

- **Installed locally in BitTasker frontend**: From the BitTasker root, run `npm install ./nostr-reviews-verifier/packages/reviews-contracts/bittasker-reviews-contracts-0.0.1.tgz`
- **Published to npm** (requires removing `"private": true` from `package.json`): `npm publish`

> **Note:** The backend's `package.json` currently has `"@bittasker/reviews-contracts": "file:../packages/reviews-contracts"`. This path is relative to the `nostr-reviews-verifier/` root and resolves correctly to `nostr-reviews-verifier/packages/reviews-contracts/`. It does NOT reference `BitTasker/packages/` which only contains `merkle-review-sdk/`.

### Package structure

| Field | Value |
|-------|-------|
| Name | `@bittasker/reviews-contracts` |
| Version | `0.0.1` |
| Entry | `./dist/index.js` |
| Types | `./dist/index.d.ts` |
| Peer deps | `@noble/hashes`, `nostr-tools`, `zod` |
| Published files | `dist/` only (via `"files": ["dist"]`) |

### Key exports

- **Constants**: `REVIEWS_SCHEMA_VERSION` (1), `REVIEW_NOSTR_KINDS` (6430/6431/6432), `REVIEW_TAG_NAMES`, `REVIEW_ATTACHMENT_LIMITS`
- **Enums**: 10 string-literal union types (`ReviewSubjectType`, `ReviewSettlementType`, `ReviewRole`, `ReviewChain`, `ReviewAsset`, `ReviewBlockchainState`, `ReviewContractOutcome`, `ReviewContentLanguage`, `ReviewErrorCode`, `ReviewVerificationStatus`)
- **Types**: `ReviewDraftFingerprint`, `ReviewPublicPayload`, `ReviewAttestationEventContent`, `ReviewChallengeRequest`, `ReviewChallengeResponse`, `ReviewAttestationRequest`, `ReviewAttestationResponse`, `ReviewableSettlementRecord`, `NostrEventLike`, etc.
- **Schemas**: 28 Zod schemas for runtime validation (`reviewEventPayloadSchema`, `attestationChallengeRequestSchema`, `attestationRequestSchema`, `attestationResponseSchema`, `issuerRegistryResponseSchema`, etc.)
- **Hash utilities**: `canonicalJson()`, `buildReviewDraftHash()`, `computeReviewDraftHash()`, `buildReviewChallengeMessage()`
- **ABI**: `VERIFICATION_ABI` — minimal V2 contract ABI (~500 bytes) for `getPaymentContractState(uint32)`

> **⚠️ Two hash implementations exist**: `canonical.ts` (synchronous, using `@noble/hashes`) and `hash.ts` (async, using `crypto.subtle`). They produce **different hashes** for the same input because `hash.ts` additionally normalizes comments and strips `reviewDraftHash`. The backend uses `canonical.ts` (noble). Always verify which implementation you're using.

---

## 2. Running the Hono API Locally

### Prerequisites

- Node.js 20+
- A Nostr keypair for the attestation issuer (generate one if needed)
- Nostr relay URLs (at least one writable relay)

### Step 1: Create `.dev.vars`

Copy the example:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your values. Vars marked **REQUIRED** must be set — the backend won't start without them:

```env
# ── REQUIRED ──────────────────────────────────────────

# Public Nostr identity of the attestation issuer (npub format).
REVIEW_ATTESTATION_ISSUER_NPUB=npub1...

# Private Nostr signing key for the attestation issuer (nsec format).
REVIEW_ATTESTATION_ISSUER_NSEC=nsec1...

# HMAC secret for slot hash computation (>=32 chars or 64-char hex).
# Used to derive stable settlement slot identifiers without revealing settlement data.
REVIEW_SLOT_HMAC_SECRET=your-hmac-secret-at-least-32-chars

# Nostr relays for publishing attestations (JSON array).
REVIEW_ATTESTATION_NOSTR_RELAYS_JSON=["wss://relay.damus.io"]

# Allowed CORS origins (comma-separated). Required for browser access.
ALLOWED_ORIGINS=http://localhost:3000

# ── OPTIONAL (sensible defaults exist) ────────────────

# Human-readable label for the active signing key.
REVIEW_ATTESTATION_ISSUER_KEY_ID=reviews-attestation-issuer-v1

# Multi-issuer registry for key rotation. Set to [] for single-key setups.
# When empty, the registry is auto-derived from NPUB/NSEC above.
# Only populate when you need multiple issuers (active/retired key rotation).
REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON=[]

# Challenge token validity (seconds). Default: 900 (15 min).
REVIEW_CHALLENGE_TTL_SECONDS=900

# Attestation expiration (seconds). Default: 86400 (24 hours).
REVIEW_ATTESTATION_TTL_SECONDS=86400

# Rate limit sliding window (seconds). Default: 600 (10 min).
REVIEW_RATE_LIMIT_WINDOW_SECONDS=600

# Settlement cache TTL (seconds). Default: 300 (5 min).
SETTLEMENT_CACHE_TTL_SECONDS=300

# ── RPC (unified fallback) ────────────────────────────

# Unified RSK RPC URL — used for both mainnet and testnet.
# Falls back to https://public-node.rsk.co if not set.
RSK_RPC_URL=
```

> **Never commit `.dev.vars`** — it's in `.gitignore`.

**Why no BSC or per-network RPC vars?** The source code (`settlement-resolver.ts`) already has a fallback chain: `RSK_MAINNET_RPC_URL → RSK_RPC_URL → hardcoded public node`. Setting a single `RSK_RPC_URL` covers both mainnet and testnet. Separate `RSK_MAINNET_RPC_URL`/`RSK_TESTNET_RPC_URL` vars are only needed if you want different RPC providers per network. BSC support is configured in source for future use — uncomment `BSC_RPC_URL` when needed.

### Step 2: Generate an issuer keypair (if needed)

Generate a Nostr keypair using any of these methods:
- Browser: [nostr-keygenerator](https://nostr-keygenerator.pages.dev/)
- CLI: `npx nostr-tools keygen` or use `@noble/curves/secp256k1`
- Copy the nsec and npub to `.dev.vars`

### Step 3: Start the local server

```bash
npm run dev
```

This runs `wrangler dev --config wrangler.toml`, which:
- Starts a local Cloudflare Workers runtime with Durable Object simulation
- Serves the Hono API at **`http://localhost:8787`**
- Auto-reloads on file changes
- Loads secrets from `.dev.vars`

### Step 4: Verify the API is running

```bash
# Health check
curl http://localhost:8787/health
# → {"ok":true}

# Issuer registry
curl http://localhost:8787/review-attestation-issuers
# → {"schemaVersion":1,"issuers":[...]}

# OpenAPI spec
curl http://localhost:8787/openapi.json
# → Full OpenAPI 3.0 spec
```

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/review-attestation-issuers` | Active issuer registry |
| `GET` | `/openapi.json` | OpenAPI 3.0 specification |
| `POST` | `/review-attestations/challenge` | Request attestation challenge (step 1) |
| `POST` | `/review-attestations` | Submit attestation (step 2) |
| `POST` | `/review-reply-attestations/challenge` | Request reply attestation challenge |
| `POST` | `/review-reply-attestations` | Submit reply attestation |

> **Note**: There are no GET endpoints for querying attestations or reviews. The frontend queries Nostr relays directly for review/attestation events.
>
> **Note on OpenAPI**: The main attestation routes (`/review-attestations/challenge`, `/review-attestations`) are registered via `@hono/zod-openapi` and appear in the OpenAPI spec. The reply attestation routes (`/review-reply-attestations/challenge`, `/review-reply-attestations`) use bare `app.post()` and are NOT in the OpenAPI spec — use the endpoint table above as reference.

### Two-Event Architecture: Why Two Nostr Events?

The attestation flow produces **two Nostr events** with different authors and purposes:

```
┌──────────────────────────────────────────────────────────────┐
│                 EVENT 1: Kind 6430 (Review)                  │
│  Author:   Reviewer (the user)                               │
│  Content:  Ratings, category scores, comment, attachments    │
│  Proves:   "Alice says Bob delivered 5-star work"            │
│  Published by: Client (frontend)                             │
├──────────────────────────────────────────────────────────────┤
│                 EVENT 2: Kind 6431 (Attestation)             │
│  Author:   BitTasker Issuer (the backend)                    │
│  Content:  reviewDraftHash, settlement proof, issuer sig     │
│  Proves:   "BitTasker certifies this review is about a real  │
│             completed on-chain settlement"                   │
│  Published by: Backend (after verification)                  │
└──────────────────────────────────────────────────────────────┘
```

**Why two events instead of one?**

Anyone can publish a Nostr event claiming "I reviewed contract X." Without the attestation, it's just a claim — not verifiable. The attestation is cryptographic proof that:

1. The reviewer was actually a participant in the settlement (verified via Nostr + EVM wallet signatures)
2. The settlement exists on-chain and is in a completed/reviewable state
3. The review hasn't been duplicated (one review per settlement slot, enforced by Durable Object)

This is the standard pattern for verifiable credentials: **one event for the claim, another for the proof**. The reviewer owns the review content. The issuer certifies its authenticity.

**What the client publishes:**
- Kind 6430 (review event) to Nostr relays — this is the actual review content
- The same signed event is submitted to the backend as part of the attestation request

**What the backend publishes:**
- Kind 6431 (attestation event) to Nostr relays — this is the verification proof

**What the client queries for displaying reviews:**
- **Primary query**: Kind 6431 (attestation events) — filtered by `#p` (reviewee pubkey) or `#d` (slot hash). These are the authoritative "verified review" records.
- **For review content** (comments, category breakdowns): Follow the `e` tag in the attestation event to fetch the referenced kind 6430 review event.

**Flow:**
```
Client                          Backend                   Nostr Relays
  │                                │                          │
  │ 1. Create & sign kind 6430 ──────────────────────────────>│ (publish review)
  │                                │                          │
  │ 2. POST /challenge ──────────>│                          │
  │    (settlement details)        │                          │
  │                                │  Verify on-chain         │
  │ <────── challengeToken ────────│                          │
  │                                │                          │
  │ 3. Sign challengeMessage       │                          │
  │    with Nostr key (Schnorr)    │                          │
  │    + EVM wallet (EIP-191)     │                          │
  │                                │                          │
  │ 4. POST /attestations ───────>│                          │
  │    (kind 6430 + both sigs)     │  Verify all sigs         │
  │                                │  Verify on-chain         │
  │                                │  Claim slot (DO)         │
  │                                │  Create kind 6431 ──────>│ (publish attestation)
  │                                │                          │
  │ <───── attestationEventId ─────│                          │
  │                                │                          │
  │ 5. Subscribe kind 6431 ──────────────────────────────────>│ (confirm attestation)
```

---

## 3. Connecting the BitTasker Frontend

### Option A: Vite proxy (recommended for local dev)

In the BitTasker `vite.config.ts`, add a proxy to forward API calls to the local wrangler server:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/review-attestations': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/review-reply-attestations': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/review-attestation-issuers': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  }
});
```

Then the frontend can call the API at the same origin (e.g., `fetch('/review-attestations/challenge', ...)`).

### Option B: Direct URL (for testing)

For manual testing, call the wrangler URL directly:

```ts
const API_BASE = 'http://localhost:8787';
const response = await fetch(`${API_BASE}/review-attestations/challenge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(challengeRequest)
});
```

### Option C: Environment variable

```ts
const API_BASE = import.meta.env.VITE_REVIEWS_API_URL || '';
// Set VITE_REVIEWS_API_URL=http://localhost:8787 in .env for local dev
// Leave empty in production (same-origin behind Cloudflare)
```

### Production deployment

When deployed to Cloudflare Workers, the API will be at the worker's URL (e.g., `https://reviews-attestation-backend.<subdomain>.workers.dev`). In production, the frontend should call the worker directly or use a custom domain.

---

## 4. Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Type check
npm run check
```

Tests use `vitest` with 67 tests across 12 test files. The contracts package also has its own test suite:

```bash
cd packages/reviews-contracts
npm test
```

---

## 5. Troubleshooting

### `/review-attestation-issuers` returns 503

This endpoint serves the issuer registry — the list of public keys that the frontend uses to verify attestation signatures.

**Root cause:** The `REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON` env var has an invalid value. Common issues:

1. **Pubkey in npub format instead of hex** — The registry schema requires `"pubkey"` matching `^[a-f0-9]{64}$` (64-char hex). If you pasted an npub like `npub1...`, it fails validation.
2. **Malformed JSON** — The value must be valid JSON: either `[]` (empty) or an array of issuer objects.

**What ISSUER_REGISTRY_JSON does:** It supports **key rotation** by allowing multiple issuer entries (some `active`, some `retired`). For single-key setups, set it to `[]` and the backend auto-derives the registry from `REVIEW_ATTESTATION_ISSUER_NPUB`/`NSEC`.

**Fix:** Set `REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON=[]` (empty array). The backend will automatically serve a registry with the single issuer derived from your NPUB/NSEC.

### All endpoints tested — expected responses

```
GET  /health                              → 200 {"ok":true}
GET  /review-attestation-issuers          → 200 (with valid config) / 503 (invalid pubkey)
GET  /openapi.json                        → 200 (full OpenAPI 3.0 spec)
POST /review-attestations/challenge       → 400 (Zod validation, requires full body)
POST /review-attestations                 → 400 (Zod validation, requires full body)
POST /review-reply-attestations/challenge → 400 (Zod validation, exists & works)
POST /review-reply-attestations           → 400 (Zod validation, exists & works)
```

> The reply attestation routes return proper validation errors — they exist and work. They use bare `app.post()` instead of `@hono/zod-openapi`, so they don't appear in the OpenAPI spec at `/openapi.json`. This is intentional — the routes function identically. Keep them.

### `@bittasker/reviews-contracts` not found

The backend depends on the workspace package via `"@bittasker/reviews-contracts": "file:./packages/reviews-contracts/bittasker-reviews-contracts-0.0.1.tgz"`. Ensure you've run `npm pack` in the contracts package directory first.

### Durable Object errors

Wrangler dev simulates Durable Objects locally. If you see DO-related errors, ensure `wrangler.toml` has the correct DO binding and migration config.

### Nostr relay connection failures

If the backend can't publish to relays, check that `REVIEW_ATTESTATION_NOSTR_RELAYS_JSON` contains valid, reachable relay URLs. The publisher uses `Promise.any()` — it succeeds if at least one relay accepts.

### CORS errors from frontend

Ensure `ALLOWED_ORIGINS` in `.dev.vars` includes your frontend origin (e.g., `http://localhost:3000`).

---

## 6. Publishing to npm (future)

When ready to publish `@bittasker/reviews-contracts`:

1. Remove `"private": true` from `packages/reviews-contracts/package.json`
2. Update the version number
3. Run `npm run build && npm publish`
4. Update the backend and frontend to use the published version instead of `file:...`

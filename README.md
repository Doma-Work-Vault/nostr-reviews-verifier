# Nostr Reviews Verifier

A **Cloudflare Workers** backend (Hono + OpenAPI) that issues **cryptographically verified** Nostr attestations for reviews on the BitTasker marketplace. It ties **EVM settlement state** on RSK/BSC to **Nostr identities** so only real participants can obtain attestations for published reviews and replies.

This repository also contains the publishable npm package **`@bittasker/reviews-contracts`** under `packages/reviews-contracts/` (Zod schemas, kinds, hashing, ABI fragments). The Worker depends on that package as specified in root `package.json`.

---

## Table of contents

- [What you get](#what-you-get)
- [Architecture](#architecture)
- [Shared contracts package](#shared-contracts-package)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [On-chain settlement resolution](#on-chain-settlement-resolution)
- [Running the service](#running-the-service)
- [API reference](#api-reference)
- [How it works](#how-it-works)
- [Reply attestation (overview)](#reply-attestation-overview)
- [Nostr event kinds and tags](#nostr-event-kinds-and-tags)
- [Querying attestations from relays](#querying-attestations-from-relays)
- [Security model](#security-model)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Deployment (Cloudflare Workers)](#deployment-cloudflare-workers)
- [Troubleshooting](#troubleshooting)
- [License and contributing](#license-and-contributing)

---

## What you get

| Feature | Description |
|--------|-------------|
| **Review attestation** | `POST /review-attestations/challenge` then `POST /review-attestations` — dual signatures (Nostr Schnorr + wallet `personal_sign`) bind reviewer npub + wallets to a settlement and review draft hash. |
| **Reply attestation** | `POST /review-reply-attestations/challenge` then `POST /review-reply-attestations` — reviewee proves the same way; issuer publishes kind **6433** after verifying kind **6432** reply and original kind **6431** attestation (fetched from relays). |
| **One review per settlement slot** | HMAC-based **slot hash** in the Durable Object; atomic claim prevents duplicate attestations for the same settlement material. |
| **One reply per reviewed review** | Separate reply slot keyed by parent review event id. |
| **Dynamic settlement resolution** | Reads contract state over JSON-RPC; supports **V2** `getPaymentContractState` and legacy **`getEscrow`** with distinct on-chain state mappings; in-memory cache with configurable TTL. |
| **Rate limiting** | Per-IP and per-slot limits enforced in the Durable Object (challenge + attestation paths; reply paths included). |
| **Multi-relay publish** | `nostr-tools` `SimplePool` publishes signed attestation events to `REVIEW_ATTESTATION_NOSTR_RELAYS_JSON`. |
| **Issuer registry** | `GET /review-attestation-issuers` — supports rotation metadata (`keyId`, `validFrom`, `validUntil`, `status`). |
| **CORS** | `ALLOWED_ORIGINS` — comma-separated list for browser clients. |
| **Structured logging** | JSON logs (`structuredLogger`) for operations and errors. |
| **OpenAPI** | `GET /openapi.json` — machine-readable contract for all HTTP routes. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Workers                                │
│                                                                          │
│  ┌────────────────────┐     ┌─────────────────────────────────────────┐│
│  │ Hono + OpenAPI     │     │ ReviewAttestationService                 ││
│  │ /health            │────▶│ · challenge + attestation (reviews)      ││
│  │ /openapi.json      │     │ · settlement via DynamicSettlementResolver│
│  │ /review-attestations/*    │ · slot HMAC + DO rate limits / claims   ││
│  │ /review-reply-*    │────▶│ ReplyAttestationService                  ││
│  │ /review-attestation-issuers│ · relay read + reply path               ││
│  └─────────┬──────────┘     └──────────────────┬──────────────────────┘│
│            │                                    │                        │
│            │         ┌──────────────────────────▼──────────────────────┐│
│            │         │ Durable Object (ReviewStateDO)                   ││
│            │         │ · rate limit counters · issued slots / replies   ││
│            │         └──────────────────────────┬──────────────────────┘│
│            │                                    │                        │
│            └────────────────────────────────────┼────────────────────────────┘
│                                                 │                         │
│                      ┌──────────────────────────▼─────────────────────────┐
│                      │ RelayReviewNostrPublisher (SimplePool)             │
│                      └──────────────────────────┬─────────────────────────┘
└─────────────────────────────────────────────────┼─────────────────────────┘
                                                  │
                    ┌─────────────────────────────▼─────────────────────────────┐
                    │ Nostr relays (wss://…)                                    │
                    └─────────────────────────────┬─────────────────────────────┘
                                                  │
                    ┌─────────────────────────────▼─────────────────────────────┐
                    │ RSK / BSC JSON-RPC (settlement contracts)                  │
                    └────────────────────────────────────────────────────────────┘
```

Settlement data is **not** loaded from a static JSON file in production: the **`DynamicSettlementResolver`** talks to the chain (with cache). A pluggable fallback hook exists in code for optional future registries.

---

## Shared contracts package

- **Path:** `packages/reviews-contracts/`
- **npm name:** `@bittasker/reviews-contracts`
- **Contents:** Zod schemas (`schemas.ts`), enums, Nostr kind constants, review/reply hashing, challenge message builders, and **viem** ABI fragments (`V2_PAYMENT_STATE_ABI`, `LEGACY_ESCROW_ABI`, unified `VERIFICATION_ABI`, `ONCHAIN_STATE_MAP`).

The **root app** imports this package using the dependency entry in **`package.json`** (your team’s chosen version or registry). After changing contracts, follow your release process so the Worker resolves an updated package (publish to npm, version bump, or internal registry — whatever matches that entry).

**Local development of the contracts package:**

```bash
cd packages/reviews-contracts
npm install
npm run build
npm test
```

---

## Prerequisites

- **Node.js** 18+ (20+ recommended)
- **npm** 8+
- A **Nostr issuer** keypair (nsec / npub) for signing attestations
- A **Cloudflare** account for deployment
- **RPC endpoints** reachable from Workers for chains you use (RSK/BSC vars below)

---

## Installation

```bash
git clone <repository-url>
cd nostr-reviews-verifier
npm install
```

Copy secrets template for Wrangler dev:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars — never commit real secrets
```

### Generate issuer keys and slot secret

```javascript
// Node.js (type: module), or adapt for a small script file
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { bytesToHex } from 'nostr-tools/utils';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const random32 = globalThis.crypto.getRandomValues(new Uint8Array(32));

console.log('REVIEW_ATTESTATION_ISSUER_NSEC=' + nsecEncode(sk));
console.log('REVIEW_ATTESTATION_ISSUER_NPUB=' + npubEncode(pk));
console.log('REVIEW_SLOT_HMAC_SECRET=' + bytesToHex(random32));
```

---

## Configuration

### Required for typical operation

| Variable | Description |
|----------|-------------|
| `REVIEW_ATTESTATION_ISSUER_NPUB` | Issuer npub (public). |
| `REVIEW_ATTESTATION_ISSUER_NSEC` | Issuer nsec (secret — use **Wrangler secret** in production). |
| `REVIEW_SLOT_HMAC_SECRET` | **≥32** characters or **64-char hex**; used for settlement slot HMAC (secret in production). |
| `REVIEW_ATTESTATION_NOSTR_RELAYS_JSON` | JSON array of `wss://` relay URLs for publishing (often a secret in production). |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed by CORS (e.g. `https://app.example.com,http://localhost:5173`). |

### Optional (defaults exist)

| Variable | Default / notes |
|----------|------------------|
| `REVIEW_ATTESTATION_ISSUER_KEY_ID` | `reviews-attestation-issuer-v1` |
| `REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON` | `[]` — empty builds a single-issuer registry from npub/nsec. |
| `REVIEW_CHALLENGE_TTL_SECONDS` | `900` |
| `REVIEW_ATTESTATION_TTL_SECONDS` | `86400` |
| `REVIEW_RATE_LIMIT_WINDOW_SECONDS` | `600` |
| `SETTLEMENT_CACHE_TTL_SECONDS` | `300` — on-chain settlement cache TTL. |

### RPC URLs (settlement verification)

Used by `parseRpcConfigFromEnv` / `DynamicSettlementResolver`. Set at least what you need for `chain` values clients send (`rsk`, `bsc`).

| Variable | Role |
|----------|------|
| `RSK_RPC_URL` | Preferred single RSK URL when set. |
| `RSK_MAINNET_RPC_URL` / `RSK_TESTNET_RPC_URL` | Per-network overrides. |
| `BSC_RPC_URL` | Preferred single BSC URL when set. |
| `BSC_MAINNET_RPC_URL` / `BSC_TESTNET_RPC_URL` | Per-network overrides. |

If `RSK_RPC_URL` is unset, code may fall back to a public RSK endpoint (see `settlement-resolver.ts`).

### Example `.dev.vars` (shape only)

```bash
REVIEW_ATTESTATION_ISSUER_KEY_ID=reviews-attestation-issuer-v1
REVIEW_ATTESTATION_ISSUER_NPUB=npub1...
REVIEW_ATTESTATION_ISSUER_NSEC=nsec1...
REVIEW_SLOT_HMAC_SECRET=<64-char-hex-or-long-random-string>
REVIEW_ATTESTATION_NOSTR_RELAYS_JSON=["wss://relay.example.com"]
ALLOWED_ORIGINS=http://localhost:5173

REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON=[]
REVIEW_CHALLENGE_TTL_SECONDS=900
REVIEW_ATTESTATION_TTL_SECONDS=86400
REVIEW_RATE_LIMIT_WINDOW_SECONDS=600
SETTLEMENT_CACHE_TTL_SECONDS=300

RSK_RPC_URL=https://public-node.rsk.co
# BSC_RPC_URL=https://...
```

---

## On-chain settlement resolution

1. **`ContractSettlementVerifier`** calls **`getPaymentContractState(uint32)`** on the contract address (V2-style payment contracts).
2. If that fails (e.g. older deployment), it falls back to **`getEscrow(uint256)`** and maps the returned **Escrow** struct into the same internal shape.
3. On-chain `uint8` state is mapped to **`ReviewBlockchainState`** separately for each method (legacy escrow numbering differs from payment contracts).
4. **`InMemorySettlementCache`** stores successful resolutions for **`SETTLEMENT_CACHE_TTL_SECONDS`** to reduce RPC load.

Clients still send **`settlementId`**, **`contractAddress`**, **`chain`**, **`asset`**, wallets, and npubs; the service checks participants and **reviewable** outcomes before issuing a challenge.

---

## Running the service

```bash
npm run dev
```

Default local URL: **http://localhost:8787** (Wrangler).

| Command | Purpose |
|---------|---------|
| `npm run dev` | Wrangler dev server |
| `npm run deploy` | `wrangler deploy` |
| `npm run check` | `tsc --noEmit` |
| `npm test` | Vitest suite |
| `npm run test:watch` | Vitest watch |

---

## API reference

Interactive documentation is not bundled as a UI; import **`GET /openapi.json`** into Swagger Editor or similar.

### `GET /health`

Returns `{ "ok": true }`.

### `GET /openapi.json`

OpenAPI 3.0 document for all routes and schemas.

### `GET /review-attestation-issuers`

Public issuer registry. Each issuer **`pubkey`** may be **hex (64 chars)** or **npub** per schema.

### `POST /review-attestations/challenge`

Body: challenge request (see OpenAPI) — includes `reviewDraftHash`, subject/settlement identifiers, `chain`, `asset`, `contractAddress`, `reviewerNpub`, `revieweeNpub`, `reviewerWallet`, `revieweeWallet`.

Returns: `challengeToken`, `challengeMessage`, `issuedAt`, `expiresAt`.

### `POST /review-attestations`

Body: signed kind **6430** review event, challenge token, Nostr + wallet signatures over `challengeMessage`, and the same settlement fields as challenge.

Returns: `attestationEventId`, `issuerPubkey`, `reviewDraftHash`, `issuedAt`.

### `POST /review-reply-attestations/challenge`

```json
{
  "parentReviewEventId": "64-hex-event-id",
  "replyDraftHash": "64-hex-sha256",
  "revieweeNpub": "npub1... or 64-hex",
  "revieweeWallet": "0x..."
}
```

Returns the same challenge shape as review flow (`schemaVersion`, `challengeToken`, `challengeMessage`, `issuedAt`, `expiresAt`).

### `POST /review-reply-attestations`

Body: `parentReviewEventId`, `replyDraftHash`, `signedReplyEvent` (**kind 6432**), `challengeToken`, `nostrChallengeSignature`, `walletChallengeSignature`, `revieweeNpub`, `revieweeWallet`.

Returns: `attestationEventId`, `issuerPubkey`, `replyDraftHash`, `issuedAt`.

### Error payload

```json
{
  "schemaVersion": 1,
  "status": "error",
  "code": "rate_limited",
  "message": "…",
  "retryAfterSeconds": 60
}
```

Common **`code`** values include: `request_invalid`, `challenge_invalid`, `challenge_expired`, `nostr_signature_invalid`, `wallet_signature_invalid`, `review_event_invalid`, `reply_event_invalid`, `resolver_not_found`, `contract_outcome_invalid`, `settlement_not_reviewable`, `participant_mismatch`, `duplicate_review_slot`, `duplicate_review_reply`, `reply_not_allowed`, `rate_limited`, `attestation_publish_failed`, `issuer_unavailable`, `internal_error`. The canonical list is **`REVIEW_ERROR_CODES`** in `@bittasker/reviews-contracts` / OpenAPI.

---

## How it works

### Review flow (correct HTTP paths)

```
PHASE 1 — Challenge
  Client  POST /review-attestations/challenge  →  Worker verifies settlement + slot + limits
  Client  ←  challengeToken + challengeMessage

PHASE 2 — User signs (off Worker)
  Sign challengeMessage with Nostr key (BIP-340) and with wallet (personal_sign).

PHASE 3 — Attestation
  Client  POST /review-attestations  →  verify token, signatures, review hash, claim slot, publish kind 6431
  Client  ←  attestationEventId, issuerPubkey, …
```

### Why dual signatures?

The chain knows **wallet addresses**; Nostr knows **pubkeys**. Signing the same opaque challenge with both keys binds identity, settlement, and review content.

---

## Reply attestation (overview)

1. The **review** must already be attested (kind **6431** on relays).
2. **Challenge** proves the caller controls the **reviewee** npub + wallet and passes reply rate limits.
3. **Attestation** verifies the reply event (**6432**), challenge token, dual signatures, then publishes kind **6433** and records the reply slot in the DO.

The service **reads** relays for the parent attestation when resolving the reviewee context (configure the same relay list you publish to).

---

## Nostr event kinds and tags

| Kind | Role |
|------|------|
| **6430** | User review (payload in `content` JSON). |
| **6431** | Issuer attestation for a review. |
| **6432** | User reply to a review. |
| **6433** | Issuer attestation for a reply. |

### Kind 6431 tags (review attestation)

Typical tags:

- **`e`** — review event id (hex).
- **`e`** — subject id (e.g. task id string in Nostr tag value).
- **`d`** — **slot hash** (stable per settlement slot; NIP-33 replaceable identifier — **not** the raw `reviewDraftHash`).
- **`p`** — reviewer pubkey (hex).
- **`p`** — reviewee pubkey (hex).
- **`subject`**, **`settlement`** — subject type and settlement type strings.

### Kind 6431 `content` JSON (attestation payload)

Includes `reviewEventId`, `reviewDraftHash`, roles, `contractOutcome`, `issuedAt`, `expiresAt`, `keyId`, and optionally **`rating`** and **`comment`** mirroring the verified review (see `attestationEventPayloadSchema` in contracts).

### Kind 6433 tags (reply attestation)

Includes **`e`** tags for parent review id and reply event id, **`d`** (parent review id), **`p`** (reviewee), plus JSON `content` with `parentReviewEventId`, `replyEventId`, `replyDraftHash`, etc.

---

## Querying attestations from relays

The Worker **publishes** attestations; it is **not** a relay proxy. Frontends should use **`nostr-tools`** `SimplePool` (or NDK, etc.) against the **same relays** configured for publishing.

**Fetch attestation by review event id** (kind 6431, `e` tag points to review):

```typescript
import { SimplePool } from 'nostr-tools';

const pool = new SimplePool();
const events = await pool.querySync(relays, {
  kinds: [6431],
  '#e': [reviewEventId],
  limit: 10
});
```

**NIP-33 / latest by slot:** the **`d`** tag on kind 6431 is the **slot hash**. Filter with `#d` and `authors: [<issuer hex pubkey>]` to get replaceable semantics per issuer.

Use **`GET /review-attestation-issuers`** for issuer pubkeys and metadata.

---

## Security model

| Mechanism | Purpose |
|-----------|---------|
| Issuer-signed **challenge token** | Binds challenge to issuer key id and slot material. |
| **Dual signatures** on `challengeMessage` | Binds Nostr identity + EVM wallet. |
| **Review draft hash** | SHA-256 over canonical review payload. |
| **Slot HMAC** | Server secret; stable id per settlement slot without exposing raw ids in the `d` tag context. |
| **Durable Object** | Atomic slot claims + rate limit state. |
| **Secrets** | `REVIEW_ATTESTATION_ISSUER_NSEC`, `REVIEW_SLOT_HMAC_SECRET`, relay JSON — use **Wrangler secrets** in production, `.dev.vars` locally (gitignored). |

Rate limits (enforced in DO; approximate defaults documented in tests / `state.ts`):

| Scope | Typical limit | Window |
|-------|----------------|--------|
| Per-IP challenge | 20 | 10 min |
| Per-slot challenge | 5 | 10 min |
| Per-IP attestation | 10 | 10 min |
| Per-slot attestation | 3 | 10 min |

---

## Project structure

```
nostr-reviews-verifier/
├── src/
│   ├── index.ts                 # Worker entry + Durable Object export
│   ├── app.ts                   # Routes, CORS, service wiring
│   ├── contracts.ts             # OpenAPI routes, slot hash, shared types
│   ├── hash-utils.ts            # SHA-256 helpers
│   ├── review-attestation-service.ts
│   ├── reply-attestation-service.ts
│   ├── settlement-resolver.ts   # Dynamic on-chain resolution + cache
│   ├── durable-object.ts
│   ├── state.ts
│   ├── challenge-token.ts
│   ├── nostr-publisher.ts
│   ├── issuer-registry.ts
│   ├── middleware/cors.ts
│   ├── middleware/rate-limit-headers.ts
│   └── logger.ts
├── packages/reviews-contracts/  # @bittasker/reviews-contracts (npm package)
├── tests/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .dev.vars.example
└── README.md
```

---

## Testing

```bash
npm test
cd packages/reviews-contracts && npm test
```

Covers HTTP routes, attestation/reply flows, settlement resolver behavior, DO concurrency, and security-focused cases.

---

## Deployment (Cloudflare Workers)

1. **Login:** `npx wrangler login`
2. **Non-secret vars:** set in `wrangler.toml` `[vars]` or Cloudflare dashboard (e.g. `REVIEW_ATTESTATION_ISSUER_NPUB`, `ALLOWED_ORIGINS`, RPC URLs if not secret).
3. **Secrets** (minimum typical set):

```bash
npx wrangler secret put REVIEW_ATTESTATION_ISSUER_NSEC
npx wrangler secret put REVIEW_SLOT_HMAC_SECRET
npx wrangler secret put REVIEW_ATTESTATION_NOSTR_RELAYS_JSON
```

4. **Deploy:** `npm run deploy`

**Note:** `wrangler.toml` in this repo defines a **single** default Worker environment. There are **no** `[env.staging]` / `[env.production]` blocks unless you add them. Use **separate Cloudflare accounts or Worker names** for true isolation, or extend `wrangler.toml` with named environments before using `wrangler deploy --env <name>`.

**Logs:** `npx wrangler tail`

**Durable Objects:** migrations are already declared in `wrangler.toml` for `ReviewStateDO`. First deploy to a fresh namespace must succeed on migration application.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| `command not found: wrangler` | Use `npx wrangler …` (local devDependency). |
| Missing issuer npub/nsec | `.dev.vars` locally; secrets + vars in Cloudflare for production. |
| `Issuer npub does not match configured nsec` | Regenerate npub from the same nsec. |
| No active issuer | `REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON` entries: `status: "active"`, `validFrom` / `validUntil` vs server time. |
| `resolver_not_found` | Wrong `contractAddress` / `settlementId` / `chain`, RPC unreachable, or contract does not implement expected views. |
| `contract_outcome_invalid` / `settlement_not_reviewable` | On-chain state not in a reviewable outcome for your rules. |
| CORS errors | `ALLOWED_ORIGINS` must include the browser origin (scheme + host + port). |
| 429 rate limit | Respect `retryAfterSeconds`; reduce client parallelism. |

Structured logs use JSON — filter in Wrangler tail or Logpush.

---

## License and contributing

Specify your **license** and **contribution** process here (this README intentionally leaves placeholders for your org).

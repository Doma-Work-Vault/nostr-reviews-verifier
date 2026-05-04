# Nostr Reviews Verifier

A Cloudflare Workers-based backend service that issues cryptographically-verified attestations for reviews on the BitTasker decentralized freelance marketplace.

This service bridges blockchain-based escrow settlements with the Nostr protocol, ensuring that only legitimate participants from completed transactions can publish verified reviews.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Service](#running-the-service)
- [API Reference](#api-reference)
- [How It Works](#how-it-works)
- [Nostr Event Kinds](#nostr-event-kinds)
- [Security Model](#security-model)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

## Overview

### What This Service Does

1. **Review Attestation Issuance**: Issues Nostr event attestations (kind 6431) that cryptographically verify a review was submitted by a legitimate participant in a completed blockchain settlement
2. **Challenge-Response Authentication**: Implements a two-phase flow where reviewers must prove ownership of both their Nostr identity AND their EVM wallet
3. **One-Review-Per-Settlement Enforcement**: Prevents duplicate reviews for the same settlement slot using HMAC-based slot hashing
4. **Rate Limiting**: Protects against abuse with per-IP and per-slot rate limiting
5. **Multi-Relay Publishing**: Publishes attestation events to configurable Nostr relays

### Supported Settlement Types

| Type | Description |
|------|-------------|
| `escrow` | BitTasker escrow smart contracts |
| `service_quote_contract` | Service booking quote contracts |
| `instant_buy_contract` | Instant purchase contracts |

### Supported Chains

| Chain | Asset |
|-------|-------|
| RSK (Rootstock) | RBTC |
| BSC (Binance Smart Chain) | USDT |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Cloudflare Workers                             │
│                                                                      │
│  ┌──────────────────┐    ┌────────────────────────────────────────┐ │
│  │    Hono App      │───▶│      ReviewAttestationService          │ │
│  │   (OpenAPI)      │    │  - Challenge creation & signing        │ │
│  │                  │    │  - Signature verification              │ │
│  │  /health         │    │  - Attestation issuance                │ │
│  │  /openapi.json   │    └────────────────────────────────────────┘ │
│  │  /challenge      │                     │                         │
│  │  /attestations   │                     ▼                         │
│  └──────────────────┘    ┌────────────────────────────────────────┐ │
│           │              │         Durable Object                  │ │
│           │              │  - Rate limiting (per-IP, per-slot)     │ │
│           │              │  - Slot claiming (prevent duplicates)   │ │
│           ▼              └────────────────────────────────────────┘ │
│  ┌──────────────────┐                     │                         │
│  │ Settlement       │                     ▼                         │
│  │ Registry         │    ┌────────────────────────────────────────┐ │
│  │ (Static JSON)    │    │       Nostr Publisher                   │ │
│  └──────────────────┘    │  - SimplePool → configurable relays     │ │
│                          └────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                           ┌─────────────────────┐
                           │    Nostr Relays     │
                           │  (wss://relay..)    │
                           └─────────────────────┘
```

## Prerequisites

- **Node.js** 18+ (recommended: 20+)
- **npm** 8+ (comes with Node.js)
- A **Nostr keypair** for the attestation issuer (nsec/npub)
- A **Cloudflare account** (for deployment)

## Installation

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd nostr-reviews-verifier

# Install root dependencies
npm install

# The reviews-contracts package is linked automatically
```

### 2. Generate Issuer Keys

The attestation issuer needs a Nostr keypair. Generate one:

```javascript
// Run in Node.js REPL or create a script
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { bytesToHex } from 'nostr-tools/utils';

const sk = generateSecretKey();
const pk = getPublicKey(sk);

console.log('REVIEW_ATTESTATION_ISSUER_NSEC=' + nsecEncode(sk));
console.log('REVIEW_ATTESTATION_ISSUER_NPUB=' + npubEncode(pk));
console.log('REVIEW_SLOT_HMAC_SECRET=' + bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
```

**Keep the nsec secret!** Never commit it to version control.

### 3. Configure Environment

Create a `.dev.vars` file for local development:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your values (see [Configuration](#configuration) below).

## Configuration

### Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `REVIEW_ATTESTATION_ISSUER_KEY_ID` | Yes | Stable identifier for the signing key | `reviews-attestation-issuer-v1` |
| `REVIEW_ATTESTATION_ISSUER_NPUB` | Yes | Nostr public key (npub format) | `npub1abc...` |
| `REVIEW_ATTESTATION_ISSUER_NSEC` | Yes | Nostr private key (nsec format) | `nsec1xyz...` |
| `REVIEW_SLOT_HMAC_SECRET` | Yes | 64-char hex or 32+ char string for slot hashing | `a1b2c3...` (64 hex chars) |
| `REVIEWS_SETTLEMENT_REGISTRY_JSON` | Yes | JSON array of reviewable settlements | See below |
| `REVIEW_ATTESTATION_NOSTR_RELAYS_JSON` | No | JSON array of relay URLs | `["wss://relay.damus.io"]` |
| `REVIEW_CHALLENGE_TTL_SECONDS` | No | Challenge expiry (default: 900) | `900` |
| `REVIEW_ATTESTATION_TTL_SECONDS` | No | Attestation expiry (default: 86400) | `86400` |
| `REVIEW_RATE_LIMIT_WINDOW_SECONDS` | No | Rate limit window (default: 600) | `600` |

### Settlement Registry Format

The `REVIEWS_SETTLEMENT_REGISTRY_JSON` must be a JSON array of settlement records:

```json
[
  {
    "subjectType": "task",
    "subjectId": "task-123",
    "settlementType": "escrow",
    "settlementId": "escrow-456",
    "chain": "rsk",
    "asset": "rbtc",
    "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
    "contractVersion": "1",
    "reviewerRole": "client",
    "revieweeRole": "provider",
    "reviewerNpub": "npub1reviewer...",
    "revieweeNpub": "npub1reviewee...",
    "reviewerWallet": "0xReviewerWallet...",
    "revieweeWallet": "0xRevieweeWallet...",
    "blockchainState": "funds_released",
    "completedAt": 1713800000000,
    "reviewableAt": 1713800000000,
    "contractOutcome": "completed",
    "status": "reviewable",
    "sourceVisibility": "public_present",
    "sourcePresentation": {
      "label": "Task #123",
      "href": "https://bittasker.io/tasks/123"
    },
    "sourceRefs": {
      "escrowId": "escrow-456"
    }
  }
]
```

See [docs/settlement-registry.md](docs/settlement-registry.md) for detailed field documentation.

### Example `.dev.vars`

```bash
# Issuer Identity
REVIEW_ATTESTATION_ISSUER_KEY_ID=reviews-attestation-issuer-v1
REVIEW_ATTESTATION_ISSUER_NPUB=npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
REVIEW_ATTESTATION_ISSUER_NSEC=nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq

# Slot HMAC Secret (64-char hex)
REVIEW_SLOT_HMAC_SECRET=0000000000000000000000000000000000000000000000000000000000000000

# Settlement Registry
REVIEWS_SETTLEMENT_REGISTRY_JSON=[{"subjectType":"task","subjectId":"task-1","settlementType":"escrow","settlementId":"s1","chain":"rsk","asset":"rbtc","contractAddress":"0x1111111111111111111111111111111111111111","contractVersion":"1","reviewerRole":"client","revieweeRole":"provider","reviewerNpub":"npub1...","revieweeNpub":"npub1...","reviewerWallet":"0x...","revieweeWallet":"0x...","blockchainState":"funds_released","completedAt":1713800000000,"reviewableAt":1713800000000,"contractOutcome":"completed","status":"reviewable","sourceVisibility":"public_present","sourcePresentation":{"label":"Task"},"sourceRefs":{"escrowId":"e1"}}]

# Nostr Relays
REVIEW_ATTESTATION_NOSTR_RELAYS_JSON=["wss://relay.damus.io","wss://relay.nostr.band"]

# Timing (optional, shown are defaults)
REVIEW_CHALLENGE_TTL_SECONDS=900
REVIEW_ATTESTATION_TTL_SECONDS=86400
REVIEW_RATE_LIMIT_WINDOW_SECONDS=600
```

## Running the Service

### Local Development

```bash
# Start the development server
npm run dev

# Server runs at http://localhost:8787
```

### Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local development server |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run check` | TypeScript type checking |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |

### Using Wrangler Directly

Since Wrangler is installed as a devDependency, use `npx`:

```bash
npx wrangler --version
npx wrangler dev
npx wrangler secret put REVIEW_ATTESTATION_ISSUER_NSEC
```

## API Reference

### Endpoints

#### `GET /health`

Health check endpoint.

**Response:**
```json
{ "ok": true }
```

#### `GET /openapi.json`

Returns the OpenAPI 3.0 specification.

#### `GET /review-attestation-issuers`

Returns the public issuer registry.

**Response:**
```json
{
  "schemaVersion": 1,
  "issuers": [
    {
      "keyId": "reviews-attestation-issuer-v1",
      "pubkey": "64-char-hex-pubkey",
      "status": "active",
      "validFrom": 0,
      "validUntil": null
    }
  ]
}
```

#### `POST /review-attestations/challenge`

Request a challenge for review submission.

**Request:**
```json
{
  "reviewDraftHash": "64-char-hex-sha256",
  "subjectType": "task",
  "subjectId": "task-123",
  "settlementType": "escrow",
  "settlementId": "escrow-456",
  "chain": "rsk",
  "asset": "rbtc",
  "contractAddress": "0x...",
  "reviewerNpub": "npub1...",
  "revieweeNpub": "npub1...",
  "reviewerWallet": "0x...",
  "revieweeWallet": "0x..."
}
```

**Response:**
```json
{
  "schemaVersion": 1,
  "challengeToken": "v1.<base64url-payload>.<hex-signature>",
  "challengeMessage": "BitTasker review attestation\nchallenge_token:...\n...",
  "issuedAt": 1713800000000,
  "expiresAt": 1713800900000
}
```

#### `POST /review-attestations`

Submit a signed review for attestation.

**Request:**
```json
{
  "reviewDraftHash": "64-char-hex",
  "signedReviewEvent": {
    "id": "nostr-event-id",
    "pubkey": "hex-pubkey",
    "created_at": 1713800000,
    "kind": 6430,
    "tags": [],
    "content": "{...review payload...}",
    "sig": "128-char-hex"
  },
  "challengeToken": "v1...",
  "nostrChallengeSignature": "128-char-hex-schnorr",
  "walletChallengeSignature": "0x...130-char-hex-ecdsa",
  "subjectType": "task",
  "subjectId": "task-123",
  "settlementType": "escrow",
  "settlementId": "escrow-456",
  "chain": "rsk",
  "asset": "rbtc",
  "contractAddress": "0x...",
  "reviewerNpub": "npub1...",
  "revieweeNpub": "npub1...",
  "reviewerWallet": "0x...",
  "revieweeWallet": "0x..."
}
```

**Response:**
```json
{
  "schemaVersion": 1,
  "status": "ok",
  "attestationEventId": "nostr-event-id",
  "issuerPubkey": "64-char-hex",
  "reviewDraftHash": "64-char-hex",
  "issuedAt": 1713800000000
}
```

### Error Responses

All errors follow this format:

```json
{
  "schemaVersion": 1,
  "status": "error",
  "code": "error_code",
  "message": "Human-readable message",
  "retryAfterSeconds": 60
}
```

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `request_invalid` | 400 | Malformed request body |
| `challenge_invalid` | 400 | Invalid or tampered challenge token |
| `challenge_expired` | 400 | Challenge TTL exceeded |
| `nostr_signature_invalid` | 400 | Nostr Schnorr signature verification failed |
| `wallet_signature_invalid` | 400 | EVM wallet ECDSA signature verification failed |
| `review_event_invalid` | 400 | Review event content doesn't match expected schema |
| `resolver_not_found` | 404 | Settlement not found in registry |
| `contract_outcome_invalid` | 409 | Settlement state doesn't allow reviews |
| `settlement_not_reviewable` | 409 | Missing participant bindings |
| `participant_mismatch` | 409 | Reviewer/reviewee doesn't match settlement |
| `duplicate_review_slot` | 409 | Review already issued for this settlement |
| `rate_limited` | 429 | Too many requests |
| `attestation_publish_failed` | 502 | Failed to publish to Nostr relays |
| `issuer_unavailable` | 503 | Issuer configuration error |
| `internal_error` | 500 | Unexpected server error |

## How It Works

### The Verification Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        PHASE 1: CHALLENGE                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Client                              Backend                         │
│    │                                    │                            │
│    │  POST /challenge                   │                            │
│    │  {reviewDraftHash, settlement...}  │                            │
│    │ ─────────────────────────────────▶ │                            │
│    │                                    │                            │
│    │                            Verify: │                            │
│    │                            - Settlement exists?                 │
│    │                            - Reviewable state?                  │
│    │                            - Not already reviewed?              │
│    │                            - Rate limit OK?                     │
│    │                                    │                            │
│    │  {challengeToken, challengeMsg}    │                            │
│    │ ◀───────────────────────────────── │                            │
│    │                                    │                            │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                     PHASE 2: USER SIGNS                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  User signs challengeMessage with:                                   │
│                                                                      │
│  1. Nostr Private Key (nsec) ──▶ Schnorr signature (64 bytes)        │
│     Proves: "I control this Nostr identity"                          │
│                                                                      │
│  2. EVM Wallet Key ──▶ ECDSA signature (65 bytes)                    │
│     Proves: "I control this blockchain wallet"                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    PHASE 3: ATTESTATION                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Client                              Backend                         │
│    │                                    │                            │
│    │  POST /attestations                │                            │
│    │  {signedReview, signatures...}     │                            │
│    │ ─────────────────────────────────▶ │                            │
│    │                                    │                            │
│    │                            Verify: │                            │
│    │                            - Challenge token valid?             │
│    │                            - Challenge not expired?             │
│    │                            - Nostr signature valid?             │
│    │                            - Wallet signature valid?            │
│    │                            - Review matches hash?               │
│    │                            - Claim slot (atomic)                │
│    │                                    │                            │
│    │                            Create: │                            │
│    │                            - Attestation event (kind 6431)      │
│    │                            - Sign with issuer nsec              │
│    │                            - Publish to relays                  │
│    │                                    │                            │
│    │  {attestationEventId, issuedAt}    │                            │
│    │ ◀───────────────────────────────── │                            │
│    │                                    │                            │
└──────────────────────────────────────────────────────────────────────┘
```

### Why Dual Signatures?

The settlement (blockchain contract) knows wallet addresses. The Nostr network knows pubkeys. Without proving both:

- An attacker could create a fake Nostr identity and claim to be a settlement participant
- There would be no link between the blockchain transaction and the Nostr review

By requiring signatures from BOTH keys on the same challenge message, we cryptographically bind:
- The Nostr identity (npub)
- The blockchain wallet (0x address)  
- The specific settlement and review content

## Nostr Event Kinds

This service uses custom Nostr event kinds in the 6000-6999 range:

| Kind | Name | Created By | Purpose |
|------|------|------------|---------|
| 6430 | Review Event | User (reviewer) | Contains the review content, rating, and metadata |
| 6431 | Attestation Event | This service (issuer) | Proves the review is from a verified participant |
| 6432 | Reply Event | User (reviewee) | Allows the reviewed party to respond |

### Attestation Event Structure (Kind 6431)

```json
{
  "kind": 6431,
  "pubkey": "<issuer-pubkey>",
  "created_at": 1713800000,
  "tags": [
    ["e", "<original-review-event-id>"],
    ["d", "<review-draft-hash>"],
    ["p", "<reviewer-pubkey>"],
    ["p", "<reviewee-pubkey>"],
    ["subject", "task"],
    ["settlement", "escrow"]
  ],
  "content": "{\"schemaVersion\":1,\"reviewEventId\":\"...\",\"reviewDraftHash\":\"...\",\"issuedAt\":...,\"expiresAt\":...,\"keyId\":\"...\"}",
  "sig": "<issuer-signature>"
}
```

## Security Model

### Cryptographic Guarantees

| Mechanism | Purpose |
|-----------|---------|
| Challenge Token (Schnorr signed) | Prevents forged challenges; binds to specific settlement/review |
| Nostr Signature (Schnorr) | Proves ownership of Nostr identity |
| Wallet Signature (ECDSA) | Proves ownership of blockchain wallet |
| Review Draft Hash (SHA-256) | Commits to review content before signing |
| Slot Hash (HMAC-SHA256) | Prevents duplicate reviews even if data changes |

### Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| Per-IP (challenge) | 20 requests | 10 minutes |
| Per-slot (challenge) | 5 requests | 10 minutes |
| Per-IP (attestation) | 10 requests | 10 minutes |
| Per-slot (attestation) | 3 requests | 10 minutes |

### Secret Management

| Environment | Storage | Security |
|-------------|---------|----------|
| Local Development | `.dev.vars` file (gitignored) | File permissions |
| Production | Cloudflare Secrets | Encrypted at rest |

**Never commit secrets to version control.** Use:

```bash
# Set production secrets
npx wrangler secret put REVIEW_ATTESTATION_ISSUER_NSEC
npx wrangler secret put REVIEW_SLOT_HMAC_SECRET
```

## Project Structure

```
nostr-reviews-verifier/
├── src/
│   ├── index.ts                    # Worker entry point, exports Durable Object
│   ├── app.ts                      # Hono app factory, route handlers
│   ├── contracts.ts                # Schema re-exports, slot HMAC, OpenAPI routes
│   ├── review-attestation-service.ts  # Core business logic
│   ├── durable-object.ts           # Cloudflare DO for rate limits & slots
│   ├── state.ts                    # State client abstraction
│   ├── challenge-token.ts          # Opaque token creation/verification
│   ├── nostr-publisher.ts          # Relay publishing via SimplePool
│   └── issuer-registry.ts          # Issuer key management
├── tests/
│   ├── app.test.ts                 # HTTP app integration tests
│   ├── review-attestation-service.test.ts
│   ├── durable-object.concurrency.test.ts
│   ├── security-hardening.test.ts
│   └── ...
├── packages/
│   └── reviews-contracts/          # Shared schemas & types
│       └── src/
│           ├── schemas.ts          # Zod validation schemas
│           ├── enums.ts            # Type enumerations
│           ├── constants.ts        # Nostr kinds, limits
│           ├── hash.ts             # Review draft hashing
│           ├── canonical.ts        # JSON canonicalization
│           └── challenge.ts        # Challenge message builder
├── docs/
│   ├── settlement-registry.md      # Settlement registry format docs
│   └── dynamic-settlement.md       # Future implementation plans
├── wrangler.toml                   # Cloudflare Worker configuration
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Testing

### Run All Tests

```bash
npm test
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Test Coverage

Tests cover:
- HTTP endpoint behavior
- Challenge/attestation flows
- Signature verification
- Rate limiting
- Durable Object concurrency
- Security hardening scenarios

### Run Contract Package Tests

```bash
cd packages/reviews-contracts
npm test
```

## Deployment

### Prerequisites

1. [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/authentication/)

### Deploy Steps

```bash
# 1. Authenticate with Cloudflare
npx wrangler login

# 2. Set production secrets
npx wrangler secret put REVIEW_ATTESTATION_ISSUER_NSEC
npx wrangler secret put REVIEW_SLOT_HMAC_SECRET
npx wrangler secret put REVIEWS_SETTLEMENT_REGISTRY_JSON
npx wrangler secret put REVIEW_ATTESTATION_NOSTR_RELAYS_JSON

# 3. Deploy
npm run deploy
```

### Environment-Specific Deployment

```bash
# Deploy to staging
npx wrangler deploy --env staging

# Deploy to production
npx wrangler deploy --env production
```

## Troubleshooting

### Common Issues

#### "command not found: wrangler"

Wrangler is installed locally. Use `npx`:

```bash
npx wrangler --version
```

#### "Missing review attestation issuer npub/nsec configuration"

Ensure both `REVIEW_ATTESTATION_ISSUER_NPUB` and `REVIEW_ATTESTATION_ISSUER_NSEC` are set in `.dev.vars`.

#### "Issuer npub does not match configured nsec"

The npub must be derived from the nsec. Regenerate both together.

#### "No active issuer available"

Check that the issuer registry has an entry with `"status": "active"` and the current time is within the `validFrom`/`validUntil` range.

#### Rate Limited (429)

Wait for the `retryAfterSeconds` indicated in the response, or check for runaway clients.

### Debug Logging

The service logs errors to `console.error` in JSON format. Check Cloudflare Workers logs:

```bash
npx wrangler tail
```

## License

[Specify your license]

## Contributing

[Specify contribution guidelines]

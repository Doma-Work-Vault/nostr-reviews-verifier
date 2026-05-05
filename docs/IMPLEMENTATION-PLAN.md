# Nostr Reviews Verifier - Production Implementation Plan

**Version:** 0.2.0
**Last Updated:** 2026-05-05
**Status:** Implementation in progress

---

## Implementation Status (2026-05-05)

| Component | Status | Notes |
|-----------|--------|-------|
| NIP-33 d-tag fix | ✅ Done | `d` tag uses `slotHash` (stable) instead of `reviewDraftHash` |
| CORS middleware | ✅ Done | `src/middleware/cors.ts` — reads `ALLOWED_ORIGINS` env var |
| Structured logger | ✅ Done | `src/logger.ts` — JSON-structured logging |
| Dynamic Settlement Resolver | ✅ Done | `src/settlement-resolver.ts` — version-agnostic `ISettlementVerifier` + `ContractSettlementVerifier` + `DynamicSettlementResolver` with fallback chain |
| Settlement cache | ✅ Done | `InMemorySettlementCache` with TTL expiry |
| Circuit breaker (DO) | ✅ Done | `CloudflareReviewStateClient` — 5 failures / 60s window |
| DO health check | ✅ Done | `GET /health` on DO returns slot counts |
| Reply attestation flow | ✅ Done | `src/reply-attestation-service.ts` — Kind 6432 reply challenge + attestation, reviewee identity enforcement, reply slot tracking |
| Reply DO slot tracking | ✅ Done | `reply:{parentReviewEventId}` keys in DO |
| Minimal contract ABI | ✅ Done | `packages/reviews-contracts/src/abi/verification-abi.ts` |
| Frontend query guide | ✅ Done | `docs/frontend-query-guide.md` |
| GET relay-proxy endpoints | ❌ Removed | Frontend queries relays directly — see `docs/frontend-query-guide.md` |
| Monitoring/Observability | ✅ Done | Structured logger with `info`/`warn`/`error` levels |
| Secret rotation | 📋 Planned | Runbook in `docs/dynamic-settlement.md` |
| GC for issued slots | 📋 Planned | Not yet implemented |
| Multi-chain support | 📋 Planned | RSK primary; BSC stubbed |

### Test coverage: 67 tests across 12 test files, all passing.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Current State Assessment](#3-current-state-assessment)
4. [Required Implementation Work](#4-required-implementation-work)
5. [Dynamic Settlement Resolver](#5-dynamic-settlement-resolver)
6. [NIP-33 Compliance Fix](#6-nip-33-compliance-fix)
7. [API Infrastructure](#7-api-infrastructure)
8. [Durable Object Enhancements](#8-durable-object-enhancements)
9. [Security Hardening](#9-security-hardening)
10. [Monitoring & Observability](#10-monitoring--observability)
11. [Testing Strategy](#11-testing-strategy)
12. [Deployment Requirements](#12-deployment-requirements)
13. [Implementation Phases](#13-implementation-phases)
14. [ABI Versioning Strategy](#14-abi-versioning-strategy)
15. [Authentication Analysis](#15-authentication-analysis)
16. [Open Source Strategy](#16-open-source-strategy)
17. [Open Questions](#17-open-questions)

---

## 1. Executive Summary

This document defines the complete production implementation plan for `nostr-reviews-verifier`, a Cloudflare Workers-based review attestation backend. The service validates review attestations for blockchain escrow settlements using dual-signature verification (Nostr + EVM wallet) and publishes attestations to Nostr relays.

**Key Principles:**

- No MVP mentality — full production-grade implementation required
- On-chain settlement verification is REQUIRED, not optional
- The static `REVIEWS_SETTLEMENT_REGISTRY_JSON` approach is a temporary bridge, not a final solution
- The service must be deployable as a standalone npm package

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                            │
│                    (SvelteKit App - BitTasker)                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTPS
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    nostr-reviews-verifier                                         │
│                    (Cloudflare Workers)                                           │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  Hono API (Hono + Zod + OpenAPI)                                         │   │
│  │  ├── GET  /health                                                        │   │
│  │  ├── GET  /openapi.json                                                  │   │
│  │  ├── GET  /review-attestation-issuers                                    │   │
│  │  ├── POST /review-attestations/challenge                                │   │
│  │  ├── POST /review-attestations                                          │   │
│  │  └── GET  /review-attestations/:id        [NEEDS IMPLEMENTATION]        │   │
│  │       GET  /review-attestations/pubkey/:pubkey [NEEDS IMPLEMENTATION]│   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                      │                                           │
│                                      ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  ReviewAttestationService                                                │   │
│  │  ├── Challenge Creation                                                  │   │
│  │  ├── Dual Signature Verification (Nostr Schnorr + EVM)                   │   │
│  │  ├── Settlement Resolution (DynamicResolver)                            │   │
│  │  └── Attestation Publishing                                             │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                      │                                           │
│                    ┌─────────────────┴─────────────────┐                        │
│                    ▼                                   ▼                        │
│  ┌───────────────────────────┐     ┌───────────────────────────────────┐     │
│  │  Durable Object           │     │  Nostr Relay Publisher            │     │
│  │  (Cloudflare DO)         │     │  (RelayReviewNostrPublisher)      │     │
│  │  ├── Rate Limiting       │     │  └── Publishes Kind 6431 to relays│     │
│  │  ├── Slot Claiming       │     └───────────────────────────────────┘     │
│  │  └── Settlement Cache    │                                                 │
│  └───────────────────────────┘                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                    │                                           │
                    ▼                                           ▼
┌───────────────────────────────┐     ┌───────────────────────────────────────────┐
│  Blockchain (RSK/BSC)         │     │  Nostr Relays                            │
│  ┌─────────────────────────┐ │     │                                           │
│  │ EscrowContract V1       │ │     │  wss://relay1.example.com                │
│  │ SecurePaymentContract V2│ │     │  wss://relay2.example.com                │
│  │ (emit events, store     │ │     │  wss://relay3.example.com                │
│  │  settlement state)      │ │     │                                           │
│  └─────────────────────────┘ │     └───────────────────────────────────────────┘
└───────────────────────────────┘
```

---

## 3. Current State Assessment

### 3.1 What's Implemented


| Component                   | Status         | Details                                                         |
| --------------------------- | -------------- | --------------------------------------------------------------- |
| Challenge-Response Flow     | ✅ Complete     | 2-phase with HMAC slot hashing, rate limits, Schnorr signatures |
| Dual Signature Verification | ✅ Complete     | Nostr Schnorr (BIP-340) + EVM wallet (via viem)                 |
| Durable Object State        | ✅ Complete     | Atomic slot claims, rate limit tracking, DO transactions        |
| Nostr Relay Publishing      | ✅ Complete     | `RelayReviewNostrPublisher` with configurable relays            |
| Issuer Registry             | ✅ Complete     | Key rotation support via `validFrom`/`validUntil`               |
| Static Settlement Registry  | ✅ Complete     | JSON-based registry with full validation                        |
| Rating Validation           | ✅ Complete     | Schema enforces 1-5 scale with category sets                    |
| Zod Schemas                 | ✅ Complete     | All types/schemas in `packages/reviews-contracts`               |
| API Endpoints (POST)        | ✅ Complete     | Challenge + Attestation endpoints                               |
| Test Suite                  | ✅ 85% coverage | 10 test files, comprehensive coverage                           |
| OpenAPI Documentation       | ✅ Complete     | Auto-generated at `/openapi.json`                               |


### 3.2 What's NOT Implemented (Required for Production)


| Component                   | Priority     | Current Status                                         |
| --------------------------- | ------------ | ------------------------------------------------------ |
| Dynamic Settlement Resolver | **CRITICAL** | 0% - docs exist, no implementation                     |
| NIP-33 `d` tag fix          | **HIGH**     | Partial - uses `reviewDraftHash` instead of `slotHash` |
| CORS Configuration          | **HIGH**     | 0% - no CORS headers                                   |
| GET Endpoints               | **HIGH**     | 0% - no query endpoints                                |
| Durable Object Health Check | **MEDIUM**   | 0% - no DO health in fetch handler                     |
| Fallback Mechanisms         | **MEDIUM**   | 0% - fails if DO unavailable                           |
| Monitoring/Observability    | **MEDIUM**   | 0% - no logging/metrics                                |
| GC for Issued Slots         | **LOW**      | 0% - slots never expire                                |


### 3.3 Escrow Contract Integration Status

The BitTasker ecosystem already has deployed escrow contracts with ABIs:


| Contract                 | Chain | ABI Location                          | Status  |
| ------------------------ | ----- | ------------------------------------- | ------- |
| EscrowContract V1        | RSK   | `/src/lib/utils/escrow/v1/abi.json`   | Legacy  |
| SecurePaymentContract V2 | RSK   | `/src/lib/utils/contract/v2/abi.json` | Current |


**Existing Contract Features:**

- State tracking: `client`, `freelancer`, `amount`, `state` (0-5), timestamps
- Events emitted: `EscrowCreated`, `TaskCompleted`, `DisputeResolved`, `StateTransition`, etc.
- Nostr event emission: Contracts publish Kind 30006 (`NDKPaymentContract`) and Kind 31006 (`NDKContractStatus`)
- Fee tiers: 1.5%, 2.0%, 2.5%

**The contracts already emit Nostr events** — this is critical for the dynamic resolver.

---

## 4. Required Implementation Work

### 4.1 Priority Matrix

```
                    HIGH IMPACT
                         │
    ┌───────────────────┼───────────────────┐
    │                   │                   │
    │   Dynamic         │   CORS            │
    │   Settlement      │   Configuration   │
    │   Resolver        │                   │
    │                   │                   │
────┼───────────────────┼───────────────────┼──── LOW IMPACT
    │                   │                   │
    │   NIP-33 d-tag    │   Monitoring &    │
    │   Fix             │   Observability   │
    │                   │                   │
    └───────────────────┼───────────────────┘
                         │
                    HIGH EFFORT
```

### 4.2 Work Items Summary


| #   | Work Item                   | Effort | Impact   | Priority |
| --- | --------------------------- | ------ | -------- | -------- |
| 1   | Dynamic Settlement Resolver | High   | Critical | P0       |
| 2   | NIP-33 `d` tag Fix          | Low    | High     | P1       |
| 3   | CORS Configuration          | Low    | High     | P1       |
| 4   | GET Endpoints               | Medium | High     | P1       |
| 5   | DO Health Check             | Low    | Medium   | P2       |
| 6   | Fallback Mechanisms         | Medium | Medium   | P2       |
| 7   | Monitoring/Observability    | Medium | Medium   | P2       |
| 8   | Issued Slot GC              | Low    | Low      | P3       |


---

## 5. Dynamic Settlement Resolver

### 5.1 Why This Is Required

The current static registry approach (`REVIEWS_SETTLEMENT_REGISTRY_JSON`) is fundamentally unsuitable for production because:

1. **Single point of failure** — If the JSON is misconfigured, invalid escrow states could be attested
2. **No real-time state** — Cannot respond to on-chain events like dispute resolution
3. **Manual maintenance burden** — Operators must manually update registry when settlements finalize
4. **Security risk** — Attestation based on stale data could enable fraudulent reviews

**The service's core value proposition is verifying escrow state on-chain.** Without dynamic verification, the service is merely a fancy signature verifier.

### 5.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    DynamicSettlementResolver                                      │
│                                                                                  │
│  resolve(settlementId, chain, contractAddress)                                    │
│         │                                                                        │
│         ├─▶ 1. Check Cache (DO/KV) ──▶ [fresh] ──▶ return cached              │
│         │                                                                      │
│         ├─▶ 2. Query Blockchain                                                 │
│         │         │                                                              │
│         │         ├─▶ RSK: getSettlement(paymentId)                             │
│         │         │     via viem + RSK_RPC_URL                                  │
│         │         │                                                              │
│         │         └─▶ BSC: (future) getSettlement(paymentId)                    │
│         │               via viem + BSC_RPC_URL                                  │
│         │                                                                        │
│         ├─▶ 3. Parse Contract State                                             │
│         │         │                                                              │
│         │         ├─▶ Map contract state → ReviewBlockchainState               │
│         │         │                                                              │
│         │         └─▶ Extract: state, client, provider, amount, timestamps      │
│         │                                                                        │
│         ├─▶ 4. Resolve Identities                                               │
│         │         │                                                              │
│         │         ├─▶ Wallet → Nostr pubkey mapping                            │
│         │         │     (via NIP-26 delegation, or on-chain registry)          │
│         │         │                                                              │
│         │         └─▶ Verify participant bindings                               │
│         │                                                                        │
│         ├─▶ 5. Validate Reviewability                                            │
│         │         │                                                              │
│         │         └─▶ isReviewableOutcome(blockchainState, contractOutcome)   │
│         │                                                                        │
│         └─▶ 6. Cache Result (TTL: 300s)                                        │
│                   └─▶ Store in DO storage or Cloudflare KV                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Contract Integration

**V2 SecurePaymentContract (RSK)**

The V2 contract at `/src/lib/utils/contract/v2/abi.json` is the primary integration target.

**Key Contract Functions:**

```typescript
// From SecurePaymentContract V2 ABI
interface SecurePaymentLegacy {
    tasker: address;           // Provider/freelancer
    taskee: address;           // Client
    amount: uint72;           // Escrow amount
    state: uint8;             // 0-5: Funded, InDispute, DisputeResolved, etc.
    taskerFeeTier: uint8;     // 1=2.5%, 2=2.0%, 3=1.5%
    taskeeFeeTier: uint8;
    createdAt: uint32;
    estimatedStartTime: uint32;
    estimatedCompletionTime: uint32;
    timelockEnd: uint32;
    noShowMarked: bool;
}
```

**State Mapping:**

```typescript
// Contract state → ReviewBlockchainState
const STATE_MAP: Record<number, ReviewBlockchainState> = {
    0: 'funded',              // Escrow funded, task not started
    1: 'in_dispute',         // Dispute in progress
    2: 'dispute_resolved',   // Dispute resolved (check outcome)
    3: 'dispute_unresolved', // Dispute unresolved, refund issued
    4: 'completed',          // Task completed successfully
    5: 'cancelled',           // Cancelled before funding
    // Extended states (from V1 + Nostr events)
    6: 'funds_released',     // Funds released to provider
    7: 'funds_claimed',      // Provider claimed funds
};
```

**Key Events to Subscribe To:**

```typescript
// From V2 ABI - these events indicate state changes requiring cache invalidation
const RELEVANT_EVENTS = [
    'PaymentContractCreated',    // New settlement
    'StateTransition',           // State change
    'UpfrontDepositClaimed',     // Deposit claimed
];
```

### 5.4 Identity Resolution

**Problem:** The blockchain knows wallets (`0x...`) but we need Nostr pubkeys (`npub1...`).

**Solution Options:**


| Option                            | Mechanism                            | Pros                             | Cons                                     |
| --------------------------------- | ------------------------------------ | -------------------------------- | ---------------------------------------- |
| **A: NIP-26 Delegation**          | Client delegates Nostr key to wallet | Decentralized, no extra contract | Requires client setup                    |
| **B: On-chain Identity Registry** | Contract maps wallet → npub          | Fast lookups                     | Extra deployment, centralization         |
| **C: Client-Provided Binding**    | Client signs npub with wallet        | Simple, no contract changes      | Requires validation, potential for abuse |
| **D: Existing Nostr Events**      | Use Kind 30006/31006 events          | Already emitted by contracts     | May not have npub mapping                |


**Recommended:** Option A (NIP-26) + Option D (existing events) combined.

The BitTasker escrow contracts already emit Kind 30006 events containing settlement data. These events can carry the npub if clients have delegated their key.

### 5.5 Caching Strategy

**Storage:** Cloudflare KV (preferred) or Durable Object storage

**Cache Key Format:**

```
settlement:${chain}:${contractAddress}:${settlementId}
```

**Cache Value:**

```typescript
interface CachedSettlement {
    data: ReviewableSettlementRecord;
    fetchedAt: number;
    expiresAt: number;
    chainTip: string;  // Block hash at fetch time (for freshness)
}
```

**TTL:** 300 seconds (5 minutes)

**Invalidation Events:**

- `StateTransition` event on the contract
- Manual invalidation via admin endpoint
- TTL expiry

### 5.6 RPC Configuration

```typescript
// Environment variables required
const RPC_CONFIG = {
    rsk: {
        mainnet: process.env.RSK_RPC_URL || 'https://public-node.rsk.co',
        testnet: process.env.RSK_TESTNET_RPC_URL || 'https://public-node.testnet.rsk.co',
    },
    bsc: {
        mainnet: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
        testnet: process.env.BSC_TESTNET_RPC_URL || 'https://data-seed.bsc.testnet.noditon.io',
    },
};
```

### 5.7 Fallback Strategy

**Primary:** Dynamic resolution via blockchain query

**Fallback Chain:**

```
1. Try dynamic resolver (KV cache → RPC query)
        │
        ├─▶ [success] ──▶ return settlement
        │
        ├─▶ [RPC error] ──▶ Fallback to Static registry
        │                           │
        │                           └─▶ [found] ──▶ log warning, return
        │                                              (data may be stale)
        │
        └─▶ [not found anywhere] ──▶ return null
                                        │
                                        └─▶ throw ReviewApiError('settlement_not_found')
```

**Always log when falling back to static registry** — this indicates either:

- RPC connectivity issue
- Settlement not yet indexed
- Configuration error

---

## 6. NIP-33 Compliance Fix

### 6.1 Current Problem

**Location:** `src/review-attestation-service.ts:425`

```typescript
// CURRENT (INCORRECT)
tags: [
    ['e', reviewEvent.id],
    ['d', reviewDraftHash],  // ❌ reviewDraftHash changes if content changes
    // ...
]
```

The `d` tag currently contains `reviewDraftHash` (64-char hex of review content). This violates NIP-33 because:

1. If the same slot gets a different review content, it gets a different `d` tag
2. The `d` tag should be a **stable instance identifier**, not content-dependent
3. Clients cannot query "latest attestation for this slot" using NIP-33 semantics

### 6.2 Required Fix

```typescript
// REQUIRED (CORRECT)
tags: [
    ['e', reviewEvent.id],
    ['d', slotHash],  // ✅ slotHash is stable per settlement
    // ...
]
```

**Why `slotHash` is correct:**

- Derived from settlement material (subject, settlementId, chain, contract)
- Does NOT change based on review content
- Is already HMAC-protected (prevents prediction)
- One attestation per slot is enforced by DO slot claiming

### 6.3 NIP-33 Query Semantics

With `slotHash` as `d` tag, clients can properly use NIP-33:

```typescript
// Client queries for latest attestation for a settlement
const filter = {
    kinds: [6431],
    authors: [ISSUER_NPUB],
    '#d': [slotHash],  // Settlement slot
    limit: 1
};

// Relay returns only the latest event by this author with this d tag
```

### 6.4 Migration

**Challenge:** Existing attestations use `reviewDraftHash` as `d` tag.

**Solution:**

1. Deploy fix with new `d` tag format
2. Attestations are idempotent — same slot, same content = same hash
3. Old attestations remain on relays (clients handle both formats)
4. Client libraries should query both `d` formats during transition

---

## 7. API Infrastructure

### 7.1 CORS Configuration

**Current State:** No CORS headers configured.

**Required Configuration:**

```typescript
// src/middleware/cors.ts
export function addCorsHeaders(app: OpenAPIHono) {
    app.use('*', async (c, next) => {
        const origin = c.req.header('Origin') || '*';

        // In production, restrict to specific origins
        const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
            'https://bittasker.io',
            'https://www.bittasker.io',
'com.bittasker.com' // for mobile apk package name
        ];

        const effectiveOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

        c.header('Access-Control-Allow-Origin', effectiveOrigin);
        c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        c.header('Access-Control-Max-Age', '86400'); // 24 hours

        if (c.req.method === 'OPTIONS') {
            return c.body(null, 204);
        }

        return next();
    });
}
```

**Environment Variables:**

```bash
ALLOWED_ORIGINS=https://bittasker.io,https://www.bittasker.io,http://localhost:5173
```

### 7.2 GET Endpoints

**Required for frontend integration:**


| Endpoint                                 | Method | Description                                  |
| ---------------------------------------- | ------ | -------------------------------------------- |
| `/review-attestations/:id`               | GET    | Get attestation by event ID                  |
| `/review-attestations/slot/:slotHash` | GET    | Get latest attestation for a settlement slot |
| `/review-attestations/pubkey/:pubkey` | GET    | Get attestations by reviewer pubkey          |
| `/settlements/:id`                       | GET    | Get settlement state (from cache/RPC)        |


**Implementation approach:**

```typescript
// src/attestation-query-service.ts
export class AttestationQueryService {
    constructor(
        private readonly pool: SimplePool,
        private readonly relays: string[],
        private readonly issuerPubkey: string,
        private readonly cache: SettlementCache
    ) {}

    async getAttestationById(eventId: string): Promise<AttestationEvent | null> {
        // Query relay by event ID
        const events = await this.pool.querySync(this.relays, {
            kinds: [6431],
            ids: [eventId],
            limit: 1
        });
        return events[0] || null;
    }

    async getLatestAttestationBySlot(slotHash: string): Promise<AttestationEvent | null> {
        // NIP-33: latest by (issuer, kind, d=slotHash)
        const events = await this.pool.querySync(this.relays, {
            kinds: [6431],
            authors: [this.issuerPubkey],
            '#d': [slotHash],
            limit: 1
        });
        return events[0] || null;
    }

    async getAttestationsByPubkey(pubkey: string, limit = 20): Promise<AttestationEvent[]> {
        // Query by reviewer pubkey in 'p' tag
        const events = await this.pool.querySync(this.relays, {
            kinds: [6431],
            '#p': [pubkey],
            limit
        });
        return events;
    }
}
```

### 7.3 Rate Limiting Headers

**Add standard rate limit headers to all responses:**

```typescript
app.use('*', async (c, next) => {
    await next();

    // Add rate limit headers
    c.header('X-RateLimit-Limit', limit.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', resetTimestamp.toString());
});
```

---

## 8. Durable Object Enhancements

### 8.1 Current Limitations


| Issue                    | Severity | Description                                   |
| ------------------------ | -------- | --------------------------------------------- |
| No health check endpoint | Medium   | DO fetch handler doesn't expose health status |
| No fallback              | High     | Service fails if DO is unavailable            |
| Single global instance   | Medium   | No sharding by namespace                      |
| No observability         | High     | Zero logging/metrics                          |
| Issued slots never GC'd  | Low      | Permanent storage growth                      |


### 8.2 Health Check Endpoint

**Add to `ReviewStateDO.fetch()`:**

```typescript
// src/durable-object.ts
async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
        return jsonResponse({
            status: 'ok',
            storageStats: await this.getStorageStats(),
            timestamp: Date.now()
        });
    }

    // ... existing routes
}

private async getStorageStats() {
    const issuedSlots = await this.state.storage.list({ prefix: 'issued:' });
    const rateLimits = await this.state.storage.list({ prefix: 'ratelimit:' });

    return {
        issuedSlotsCount: issuedSlots.length,
        rateLimitBucketsCount: rateLimits.length,
        oldestSlotTimestamp: await this.getOldestSlotTimestamp()
    };
}
```

### 8.3 Fallback Mechanism

**Implement circuit breaker for DO unavailability:**

```typescript
// src/state.ts
export class CloudflareReviewStateClient implements ReviewStateClient {
    private failureCount = 0;
    private lastFailure = 0;
    private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
    private readonly CIRCUIT_BREAKER_WINDOW = 60000; // 1 minute

    async checkRateLimit(...): Promise<RateLimitDecision> {
        if (this.isCircuitOpen()) {
            // In degraded mode, allow requests but log heavily
            console.warn('[RATE LIMIT] Circuit breaker open, allowing request');
            return { allowed: true, remaining: 0, resetAt: Date.now() + 60000 };
        }

        try {
            const result = await this.doRequest('POST', '/ratelimit/check', body);
            this.failureCount = 0;
            return result;
        } catch (error) {
            this.recordFailure();
            throw error;
        }
    }

    private isCircuitOpen(): boolean {
        if (this.failureCount < this.CIRCUIT_BREAKER_THRESHOLD) return false;
        return Date.now() - this.lastFailure < this.CIRCUIT_BREAKER_WINDOW;
    }

    private recordFailure() {
        this.failureCount++;
        this.lastFailure = Date.now();
    }
}
```

### 8.4 Multi-Instance Strategy

**Current:** Single global DO instance (`globalId = 'global'`)

**Production Recommendation:**

- Keep single global instance for simplicity
- DO is already geo-distributed by Cloudflare infrastructure
- Implement DO replica reads for read-heavy operations if needed
- Consider namespace sharding for multi-tenant scenarios

---

## 9. Security Hardening

### 9.1 API Security


| Concern             | Mitigation                                    |
| ------------------- | --------------------------------------------- |
| CORS                | Restrict to allowed origins only              |
| Rate Limiting       | Already implemented (IP + slot)               |
| Input Validation    | Zod schemas on all inputs                     |
| Secret Management   | Use Cloudflare Secrets, not env vars for NSEC |
| Request Size        | 1MB limit (existing)                          |
| SQL/NoSQL Injection | N/A (no database)                             |
| XSS                 | N/A (API only, no HTML responses)             |


### 9.2 Secret Rotation Runbook

Documented in `docs/dynamic-settlement.md` but needs automation:

```typescript
// src/services/secret-rotation.ts
export class SecretRotationService {
    async rotateIssuerKey(newNsec: string): Promise<void> {
        // 1. Derive new npub
        const newNpub = deriveNpub(newNsec);

        // 2. Add new key to registry with future validFrom
        const futureTime = Date.now() + 24 * 60 * 60 * 1000; // 24h from now
        await this.addIssuerKey({
            keyId: `reviews-attestation-issuer-v2`,
            npub: newNpub,
            validFrom: futureTime,
            validUntil: null // Never expires
        });

        // 3. Old key remains valid until its validUntil
        // 4. Publish key rotation event to Nostr
    }
}
```

### 9.3 HMAC Secret Requirements

```typescript
// Minimum requirements for REVIEW_SLOT_HMAC_SECRET
const HMAC_SECRET_REQUIREMENTS = {
    minLength: 32,           // 256 bits minimum
    encoding: 'hex or utf8', // Hex (64 char) or string (32+ char)
    randomness: 'cryptographically secure random',
    rotation: ' annually or immediately if compromised'
};
```

---

## 10. Monitoring & Observability

### 10.1 Required Metrics


| Metric                             | Type      | Description                          |
| ---------------------------------- | --------- | ------------------------------------ |
| `challenge_requests_total`         | Counter   | Total challenge requests             |
| `challenge_requests_rate_limited`  | Counter   | Rate-limited challenge requests      |
| `attestation_requests_total`       | Counter   | Total attestation requests           |
| `attestation_requests_success`     | Counter   | Successful attestations              |
| `attestation_requests_failed`      | Counter   | Failed attestations (by error code)  |
| `settlement_resolver_cache_hits`   | Counter   | Cache hits for settlement resolution |
| `settlement_resolver_cache_misses` | Counter   | Cache misses                         |
| `settlement_resolver_rpc_errors`   | Counter   | RPC node errors                      |
| `do_request_latency_ms`            | Histogram | Durable Object request latency       |
| `relay_publish_latency_ms`         | Histogram | Nostr relay publish latency          |


### 10.2 Logging Strategy

```typescript
// Use structured logging
const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => {
        console.log(JSON.stringify({
            level: 'info',
            timestamp: Date.now(),
            message: msg,
            ...meta
        }));
    },

    warn: (msg: string, meta?: Record<string, unknown>) => {
        console.warn(JSON.stringify({
            level: 'warn',
            timestamp: Date.now(),
            message: msg,
            ...meta
        }));
    },

    error: (msg: string, error?: Error, meta?: Record<string, unknown>) => {
        console.error(JSON.stringify({
            level: 'error',
            timestamp: Date.now(),
            message: msg,
            error: error?.message,
            stack: error?.stack,
            ...meta
        }));
    }
};
```

### 10.3 Health Check Endpoint

**Extend `/health` to include subsystem status:**

```typescript
// GET /health
{
    status: 'ok' | 'degraded' | 'unhealthy',
    timestamp: number,
    version: string,
    uptime: number,
    subsystems: {
        durableObject: 'ok' | 'unavailable',
        nostrRelays: 'ok' | 'degraded' | string[],
        blockchain: 'ok' | 'unavailable'
    },
    stats: {
        totalAttestations: number,
        cacheHitRate: number,
        avgLatencyMs: number
    }
}
```

---

## 11. Testing Strategy

### 11.1 Current Coverage

```
Overall: 85.12% statements, 74.08% branches, 93.33% functions
```

### 11.2 Required Additional Tests


| Area                        | Test Cases                                      | Priority |
| --------------------------- | ----------------------------------------------- | -------- |
| Dynamic Settlement Resolver | RPC failures, cache invalidation, state mapping | P0       |
| NIP-33 `d` tag              | Event query by slotHash, replacement semantics  | P1       |
| CORS                        | Preflight, allowed origins, disallowed origins  | P1       |
| GET Endpoints               | Query by ID, pubkey, slot                       | P1       |
| Circuit Breaker             | DO failure, recovery                            | P2       |
| Identity Resolution         | NIP-26 delegation, wallet→npub mapping          | P2       |
| Rate Limit Headers          | Headers present and accurate                    | P2       |


### 11.3 Integration Test Setup

```typescript
// tests/integration/setup.ts
export async function setupIntegrationTest() {
    // Start local Durable Object
    const doNamespace = new DurableObjectNamespaceMock();
    env.REVIEW_STATE = doNamespace;

    // Start local Nostr relay (Gossip)
    const relay = await startLocalRelay();
    env.REVIEW_ATTESTATION_NOSTR_RELAYS_JSON = JSON.stringify([relay.url]);

    // Start local blockchain (Hardhat/Anvil)
    const blockchain = await startLocalBlockchain();
    env.RSK_RPC_URL = blockchain.rpcUrl;

    return { doNamespace, relay, blockchain };
}
```

---

## 12. Deployment Requirements

### 12.1 Environment Variables

**Required:**

```bash
# Core (required)
REVIEW_ATTESTATION_ISSUER_NSEC=nsec1...
REVIEW_SLOT_HMAC_SECRET=<64-char-hex-or-32+char-string>

# Blockchain RPC (required for dynamic resolver)
RSK_RPC_URL=https://public-node.rsk.co
BSC_RPC_URL=https://bsc-dataseed.binance.org

# Optional overrides
RSK_MAINNET_RPC_URL=https://rpc.rsk.co
RSK_TESTNET_RPC_URL=https://public-node.testnet.rsk.co
BSC_MAINNET_RPC_URL=https://bsc-dataseed.binance.org
BSC_TESTNET_RPC_URL=https://data-seed.bsc.testnet.noditon.io
```

**Optional:**

```bash
# Service
REVIEW_CHALLENGE_TTL_SECONDS=900
REVIEW_ATTESTATION_TTL_SECONDS=86400
REVIEW_RATE_LIMIT_WINDOW_SECONDS=600

# Nostr
REVIEW_ATTESTATION_NOSTR_RELAYS_JSON=["wss://relay1.example.com"]

# CORS
ALLOWED_ORIGINS=https://bittasker.io,https://www.bittasker.io

# Cache
SETTLEMENT_CACHE_TTL_SECONDS=300

# Monitoring
LOG_LEVEL=info
```

### 12.2 Cloudflare Configuration

```toml
# wrangler.toml
name = "reviews-attestation-backend"
main = "src/index.ts"
compatibility_date = "2026-03-31"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "REVIEW_STATE"
class_name = "ReviewStateDO"

# Environment-specific overrides
[env.production]
name = "reviews-attestation"
routes = [
    { pattern = "reviews-api.bittasker.io", zone_name = "bittasker.io" }
]

[env.production.vars]
RSK_NETWORK = "mainnet"
LOG_LEVEL = "warn"
```

### 12.3 Deployment Checklist

- Cloudflare account with Workers and Durable Objects
- RSK/BSC RPC endpoints configured
- Nostr relay list configured
- Issuer keys generated and stored as Cloudflare Secrets
- HMAC secret generated and stored as Cloudflare Secret
- CORS allowed origins configured
- Health check endpoint verified
- Rate limit headers verified
- Monitoring/alerting configured
- Secret rotation runbook tested

---

## 13. Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Goals:** Fix critical gaps, enable frontend integration

1. **NIP-33 `d` tag fix**
  - Change `d` tag from `reviewDraftHash` to `slotHash`
  - Update tests
  - Deploy
2. **CORS configuration**
  - Add CORS middleware
  - Configure allowed origins
  - Test preflight requests
3. **GET endpoint: `/review-attestations/:id`**
  - Query attestations by event ID from relays
  - Add to OpenAPI spec

### Phase 2: Dynamic Settlement Resolver (Week 3-6)

**Goals:** Replace static registry with real blockchain queries

1. **Settlement resolver interface**
  - Define `SettlementResolver` interface
  - Implement `DynamicSettlementResolver`
  - Add caching layer (DO or KV)
2. **Blockchain integration**
  - Integrate V2 contract ABI
  - Map contract state → `ReviewBlockchainState`
  - Handle `StateTransition` events
3. **Identity resolution**
  - Implement NIP-26 delegation verification
  - Integrate with existing Kind 30006 events
4. **Fallback mechanism**
  - Static registry as fallback
  - Circuit breaker for RPC failures
  - Logging/alerting for fallback usage

### Phase 3: Hardening (Week 7-8)

**Goals:** Production-ready observability and reliability

1. **Monitoring**
  - Structured logging
  - Metrics export (Prometheus-compatible)
  - Health check enhancement
2. **Durable Object enhancements**
  - Health endpoint in DO
  - Circuit breaker pattern
  - Storage statistics
3. **GET endpoints**
  - `/review-attestations/slot/:slotHash`
  - `/review-attestations/pubkey/:pubkey`
  - `/settlements/:id`
4. **Security**
  - Secret rotation automation
  - Key registry updates

### Phase 4: Testing & Documentation (Week 9-10)

**Goals:** Complete test coverage, production documentation

1. **Integration tests**
  - Local blockchain testing
  - End-to-end attestation flow
  - Failure mode testing
2. **Documentation**
  - API documentation (OpenAPI)
  - Deployment runbook
  - Frontend integration guide (see `FRONTEND-INTEGRATION.md`)

---

## 14. On-Chain Verification Strategy

### 14.1 The Problem

We need to verify escrow state **on-chain** to ensure settlements are actually finalized before allowing reviews. The current implementation trusts the `blockchainState` field in the registry without verification.

### 14.2 Key Clarification: Nostr Events Are Encrypted

**The Nostr events (Kind 30006/31006) emitted by contracts are encrypted.** The backend CANNOT decrypt them to read settlement state. Therefore, the previous architecture relying on Nostr events as primary source was incorrect.

**We must use direct blockchain RPC calls for verification.**

### 14.3 What Data Do We Actually Need?

From `review-attestation-service.ts:182-191`, the verification logic only needs:

```typescript
function isReviewableOutcome(state: ReviewBlockchainState, outcome: ReviewContractOutcome): boolean {
    if (state === 'funds_released' || state === 'funds_claimed')
        return outcome === 'completed';
    if (state === 'dispute_resolved') {
        return outcome === 'disputed_resolved_payout' || outcome === 'disputed_resolved_refund';
    }
    if (state === 'dispute_unresolved' || state === 'refunded') {
        return outcome === 'refunded';
    }
    return false;
}
```

**We only need the `state` field (uint8) from the contract.**

### 14.4 The V2 Contract Interface

The V2 contract has a dedicated function for this:

`**getPaymentContractState(uint32 paymentId)`** (from V2 ABI):

```json
{
  "inputs": [{ "name": "paymentId", "type": "uint32" }],
  "name": "getPaymentContractState",
  "outputs": [
    { "name": "state", "type": "uint8" },
    { "name": "exists", "type": "bool" },
    { "name": "tasker", "type": "address" },
    { "name": "taskee", "type": "address" },
    { "name": "noShowMarked", "type": "bool" }
  ],
  "stateMutability": "view"
}
```

**This is the only function we need to call for verification.**

### 14.5 Why We Need a Minimal ABI

The full V2 ABI has ~992 lines including 50+ error definitions and 40+ functions. We don't need all of that.

**We need the ABI ONLY for:**

1. Encoding the `paymentId` argument (`uint32`)
2. Decoding the `state` return value (`uint8`)

Without the ABI, `viem`/`ethers` cannot decode the return bytes into a readable value.

### 14.6 Minimal ABI Approach (Recommended)

Instead of copying the full ABI, we store only the essential fragment:

```typescript
// File: packages/reviews-contracts/src/abi/verification-abi.ts
export const V2_VERIFICATION_ABI = [
  {
    "inputs": [{ "internalType": "uint32", "name": "paymentId", "type": "uint32" }],
    "name": "getPaymentContractState",
    "outputs": [
      { "internalType": "uint8", "name": "state", "type": "uint8" },
      { "internalType": "bool", "name": "exists", "type": "bool" },
      { "internalType": "address", "name": "tasker", "type": "address" },
      { "internalType": "address", "name": "taskee", "type": "address" },
      { "internalType": "bool", "name": "noShowMarked", "type": "bool" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;
```

**Size comparison:**

- Full V2 ABI: ~16,000 bytes
- Minimal verification ABI: ~500 bytes (97% reduction)

### 14.7 Alternative: Fetch ABI from Blockscout

RSK has Blockscout explorer which provides ABI via API:

```
GET https://blockscout.com/rsk/mainnet/api?module=contract&action=getabi&address={contractAddress}
```

**Pros:** No storage needed, always current
**Cons:** External API dependency, rate limits, adds latency

**Recommendation:** Use minimal ABI locally. Fetch from Blockscout only if contract ABI is not locally available.

### 14.8 Data Already Available in Registry

The `ReviewableSettlementRecord` already contains:


| Field             | Purpose                     |
| ----------------- | --------------------------- |
| `contractAddress` | Target for on-chain call    |
| `settlementId`    | Equals `paymentId` for V2   |
| `blockchainState` | What we expect (to compare) |
| `contractOutcome` | How review resolved         |
| `contractVersion` | V2 only for new reviews     |


**The resolver only needs to:**

1. Call `getPaymentContractState(settlementId)` on `contractAddress`
2. Map returned `state` (uint8) to `ReviewBlockchainState`
3. Compare against stored `blockchainState`
4. Verify `contractOutcome` is appropriate

### 14.9 State Mapping

On-chain `ContractStatus` (uint8) to `ReviewBlockchainState` (string):


| ContractStatus | ReviewBlockchainState      |
| -------------- | -------------------------- |
| 0              | `created`                  |
| 1              | `funded`                   |
| 2              | `accepted` / `in_progress` |
| 3              | `work_in_progress`         |
| 4              | `pending_completion`       |
| 5              | `completed`                |
| 6              | `refunded`                 |
| 7              | `funds_released`           |
| 8              | `funds_claimed`            |
| ...            | ...                        |


**Reviewability check:**

- `funds_released` (7) or `funds_claimed` (8) with `outcome=completed` → reviewable
- `dispute_resolved` (2) → reviewable (needs additional data for payout vs refund)
- `dispute_unresolved` (3) or `refunded` (6) with `outcome=refunded` → reviewable

### 14.10 Version Agnosticism for Future Contracts

For future versions (V3, V4), the interface should be:

```typescript
interface ISettlementVerifier {
    // All versions must implement this
    getSettlementState(paymentId: bigint): Promise<{
        state: number;
        exists: boolean;
        tasker: string;
        taskee: string;
    }>;
}
```

**The resolver doesn't need to know version details** - it just calls `getSettlementState()` and maps the result.

### 14.11 Implementation Approach

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    DynamicSettlementResolver                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  resolve(settlementId, chain, contractAddress)                                    │
│         │                                                                       │
│         ├─▶ 1. Check Cache (DO/KV) ──▶ [fresh] ──▶ return cached             │
│         │                                                                       │
│         ├─▶ 2. Call getPaymentContractState(paymentId)                       │
│         │         │                                                              │
│         │         ├─▶ viem publicClient.readContract()                        │
│         │         ├─▶ Uses minimal ABI fragment                                 │
│         │         └─▶ Returns { state: uint8, exists, tasker, taskee }       │
│         │                                                                       │
│         ├─▶ 3. Map on-chain state to ReviewBlockchainState                     │
│         │                                                                       │
│         ├─▶ 4. Verify against stored blockchainState                           │
│         │         │                                                              │
│         │         ├─▶ Match: settlement is valid                               │
│         │         └─▶ Mismatch: flag for manual review                         │
│         │                                                                       │
│         └─▶ 5. Cache Result (TTL: 300s)                                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 14.12 ABI File Location

**Store minimal ABI at:**

```
packages/reviews-contracts/src/abi/verification-abi.ts
```

**Do NOT copy the full V2 ABI** - only the verification fragment.

---

## 15. Authentication Analysis

### 15.1 Current State: NO Traditional Authentication

**Confirmed: There is NO API key, JWT, session, or cookie authentication.**

The only mechanism is **cryptographic challenge-response with dual signatures**:

```typescript
// From review-attestation-service.ts:356-372
// 1. Nostr Schnorr signature - proves user owns Nostr private key
const nostrSigValid = schnorr.verify(
    parseChallengeSignature(input.nostrChallengeSignature),
    sha256(utf8ToBytes(challengeMessage)),
    hexToBytes(reviewerPubkey)
);

// 2. EVM Wallet signature - proves user owns wallet
const walletSigValid = await verifyMessage({
    address: normalizeAddress(input.reviewerWallet),
    message: challengeMessage,
    signature: input.walletChallengeSignature
});
```

### 15.2 Why This Is SUFFICIENT

The golden rule is: **keys never leave the client app**. This is an end-to-end encryption system.

The challenge-response flow proves:

1. User controls their Nostr private key (Schnorr signature)
2. User controls their EVM wallet (ECDSA signature)
3. User is authorized to review this specific settlement (bound by slot hash)

**No additional authentication is needed** because:

- Traditional auth (JWT/API key) would NOT add value
- It would NOT prove key ownership
- It would introduce a credential database to secure
- It would violate the keyless design principle

### 15.3 The Challenge Token Is NOT Authentication

The challenge token is a **capability token**, not an identity token:

- Single-use for one attestation
- Binds to specific slot hash
- Expires after 15 minutes
- Cannot be reused across different settlements

### 15.4 Attack Vectors (Not Mitigated by Traditional Auth)

Even WITH traditional auth, these would still exist:


| Attack                 | Description                                      | Mitigation                                           |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| Rate limiting abuse    | Attacker with many IPs bypasses IP-based limits  | Proof of Work, or accept as cost of doing business   |
| Settlement enumeration | Iterate settlement IDs to map registry           | Requires proper authorization for challenge endpoint |
| Challenge exhaustion   | Resource exhaustion via rapid challenge requests | Per-IP rate limits + CAPTCHA in extreme cases        |


### 15.5 What IS Needed for Security

Instead of traditional auth, the system needs:

1. **HMAC-bound client verification** - Prove requests come from legitimate BitTasker frontend apps
2. **Rate limit with PoW** - Make enumeration attacks economically costly
3. **Settlement registry integrity** - The registry itself must be trusted (managed off-chain)

---

## 16. Open Source Strategy

### 16.1 What to Open Source


| Component                     | Open Source? | Rationale                                                 |
| ----------------------------- | ------------ | --------------------------------------------------------- |
| `packages/reviews-contracts/` | **YES**      | Self-contained npm package with types, schemas, constants |
| `src/` (core logic)           | **YES**      | Backend implementation others can run                     |
| `tests/`                      | **YES**      | Transparency and reusability                              |
| `docs/`                       | **YES**      | Complete documentation                                    |
| **Issuer NSEC key**           | **NEVER**    | Would enable fake attestations                            |
| **HMAC secret**               | **NEVER**    | Would enable slot hash prediction                         |
| **Settlement registry JSON**  | **NEVER**    | Contains participant PII, task IDs                        |


### 16.2 Recommended Release Strategy

**Phase 1: Publish `@bittasker/reviews-contracts` to npm**

- Self-contained, no secrets
- Can be used by any frontend to build compatible review events
- Version: `0.1.0` with semantic versioning

**Phase 2: Open source core worker**

- Full `src/` directory under Apache 2.0 license
- Exclude `.env`, wrangler secrets, production config
- Include `.dev.vars.example`

### 16.3 Apache 2.0 License

**Rationale:**

- Patent grant (important for financial applications)
- Permissive for commercial use
- Clear attribution requirement
- Compatible with npm distribution

### 16.4 Files to Create for Open Source

```
├── LICENSE                    # Apache 2.0
├── SECURITY.md               # Vulnerability reporting
├── .github/
│   └── CONTRIBUTING.md       # PR process, code style
└── README.md                # Already comprehensive
```

### 16.5 What Stays Private

```bash
# NEVER commit these:
.env
.dev.vars                    # Local dev secrets
wrangler.toml [secrets]      # Use Cloudflare Secrets UI instead

# NEVER open source:
REVIEWS_SETTLEMENT_REGISTRY_JSON  # Contains participant wallets, npubs, task IDs
REVIEW_ATTESTATION_ISSUER_NSEC    # Signing key - must use Cloudflare Secrets
REVIEW_SLOT_HMAC_SECRET          # Slot binding key - must use Cloudflare Secrets
```

---

## 17. Open Questions


| #   | Question                            | Impact | Recommendation                 |
| --- | ----------------------------------- | ------ | ------------------------------ |
| 1   | BSC support timeline                | Medium | RSK first, BSC when needed     |
| 2   | Multi-tenant vs single-tenant       | High   | Single-tenant initially        |
| 3   | Settlement cache storage (DO vs KV) | Medium | KV preferred for TTL expiry    |
| 4   | Identity resolution approach        | High   | NIP-26 + Kind 30006 events     |
| 5   | Rate limit tuning                   | Low    | Monitor and adjust post-launch |
| 6   | Attestation archival                | Low    | Relays handle this             |


---

## Appendix A: Key File Locations


| File                                        | Purpose                               |
| ------------------------------------------- | ------------------------------------- |
| `src/review-attestation-service.ts`         | Core business logic                   |
| `src/durable-object.ts`                     | Durable Object implementation         |
| `src/state.ts`                              | State client abstraction              |
| `src/challenge-token.ts`                    | Challenge token creation/verification |
| `src/nostr-publisher.ts`                    | Nostr relay publishing                |
| `src/app.ts`                                | Hono API app                          |
| `packages/reviews-contracts/src/schemas.ts` | Zod schemas                           |
| `packages/reviews-contracts/src/types.ts`   | TypeScript types                      |
| `docs/dynamic-settlement.md`                | Future resolver design                |
| `docs/settlement-registry.md`               | Current registry format               |


## Appendix B: Contract ABIs

The BitTasker project already contains the escrow contract ABIs:

- **V1 EscrowContract**: `/src/lib/utils/escrow/v1/abi.json`
- **V2 SecurePaymentContract**: `/src/lib/utils/contract/v2/abi.json`

These ABIs should be copied into `nostr-reviews-verifier/packages/reviews-contracts/src/abi/` for use by the dynamic resolver.
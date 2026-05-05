# Future Implementation Plans

This document outlines planned enhancements for the Reviews Attestation Backend. These are implementation plans for future development, not current features.

## Table of Contents

1. [Dynamic Settlement Resolver](#1-dynamic-settlement-resolver)
2. [Reply Attestation Flow](#2-reply-attestation-flow)
3. [Historical Attestation Queries](#3-historical-attestation-queries)
4. [Deployment Runbook with Secret Rotation](#4-deployment-runbook-with-secret-rotation)

---

## 1. Dynamic Settlement Resolver

### Current Limitation

Settlements are resolved on-chain via RPC calls to RSK/BSC nodes. The resolver caches results with a configurable TTL to avoid redundant RPC calls.
- No real-time verification of blockchain state
- Potential for stale data

### Proposed Solution

Implement a `DynamicSettlementResolver` that queries the blockchain in real-time to verify settlement data.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Challenge/Attestation Request                    │
│   { chain: "rsk", contractAddress: "0x...", settlementId: "..." }   │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DynamicSettlementResolver                         │
│                                                                      │
│   1. Check cache (Durable Object or KV)                             │
│      └─▶ If fresh: return cached settlement                         │
│                                                                      │
│   2. Query blockchain via RPC                                        │
│      ├─▶ RSK: JSON-RPC to RSK node                                  │
│      └─▶ BSC: JSON-RPC to BSC node                                  │
│                                                                      │
│   3. Parse contract state                                            │
│      ├─▶ Call escrowContract.getSettlement(settlementId)            │
│      ├─▶ Extract: state, participants, outcome                       │
│      └─▶ Validate: is settlement finalized?                          │
│                                                                      │
│   4. Resolve participant identities                                  │
│      ├─▶ Query identity registry for wallet → npub mapping          │
│      └─▶ Or require client to provide binding proof                 │
│                                                                      │
│   5. Cache result (with TTL)                                         │
│      └─▶ Store in Durable Object or Cloudflare KV                   │
│                                                                      │
│   6. Return ReviewableSettlementRecord                               │
└─────────────────────────────────────────────────────────────────────┘
```

### Implementation Steps

#### Phase 1: Contract ABI Integration

1. **Define contract ABIs** for each settlement type:
   ```typescript
   // src/contracts/escrow-abi.ts
   export const ESCROW_ABI = [
     {
       name: 'getSettlement',
       type: 'function',
       inputs: [{ name: 'settlementId', type: 'bytes32' }],
       outputs: [
         { name: 'state', type: 'uint8' },
         { name: 'client', type: 'address' },
         { name: 'provider', type: 'address' },
         { name: 'amount', type: 'uint256' },
         { name: 'completedAt', type: 'uint256' }
       ]
     }
   ] as const;
   ```

2. **Create contract clients** using viem:
   ```typescript
   // src/settlement-resolvers/escrow-resolver.ts
   import { createPublicClient, http, getContract } from 'viem';
   import { rootstock, bsc } from 'viem/chains';
   import { ESCROW_ABI } from '../contracts/escrow-abi';

   export class EscrowSettlementResolver {
     private client: PublicClient;
     private contract: Contract;

     constructor(chain: 'rsk' | 'bsc', contractAddress: string, rpcUrl: string) {
       const chainConfig = chain === 'rsk' ? rootstock : bsc;
       this.client = createPublicClient({
         chain: chainConfig,
         transport: http(rpcUrl)
       });
       this.contract = getContract({
         address: contractAddress,
         abi: ESCROW_ABI,
         client: this.client
       });
     }

     async resolveSettlement(settlementId: string): Promise<BlockchainSettlement> {
       const result = await this.contract.read.getSettlement([settlementId]);
       return this.parseSettlementResult(result);
     }
   }
   ```

#### Phase 2: Identity Resolution

The challenge: blockchain knows wallets, but we need Nostr pubkeys.

**Option A: On-chain Identity Registry**
```typescript
// Query a deployed identity registry contract
const identityRegistry = getContract({
  address: IDENTITY_REGISTRY_ADDRESS,
  abi: IDENTITY_REGISTRY_ABI,
  client
});

const npub = await identityRegistry.read.getNpubForWallet([walletAddress]);
```

**Option B: Client-Provided Binding**
```typescript
// Client provides proof of wallet-npub binding
interface IdentityBinding {
  wallet: string;
  npub: string;
  signature: string; // wallet signs message containing npub
}

// Verify binding before accepting
const isValid = await verifyIdentityBinding(binding);
```

**Option C: Separate Identity Service**
```typescript
// Call external identity service
const response = await fetch(`https://identity.bittasker.io/resolve/${walletAddress}`);
const { npub, proof } = await response.json();
```

#### Phase 3: Caching Layer

Use Cloudflare KV or Durable Object storage for caching:

```typescript
// src/settlement-cache.ts
export class SettlementCache {
  constructor(private kv: KVNamespace, private ttlSeconds: number = 300) {}

  async get(chain: string, contract: string, settlementId: string): Promise<CachedSettlement | null> {
    const key = `settlement:${chain}:${contract}:${settlementId}`;
    const cached = await this.kv.get(key, 'json');
    if (!cached) return null;
    
    // Check if expired
    if (Date.now() > cached.expiresAt) {
      await this.kv.delete(key);
      return null;
    }
    return cached.data;
  }

  async set(chain: string, contract: string, settlementId: string, data: ReviewableSettlementRecord): Promise<void> {
    const key = `settlement:${chain}:${contract}:${settlementId}`;
    await this.kv.put(key, JSON.stringify({
      data,
      expiresAt: Date.now() + (this.ttlSeconds * 1000)
    }), { expirationTtl: this.ttlSeconds });
  }
}
```

#### Phase 4: Unified Resolver Interface

```typescript
// src/settlement-resolvers/index.ts
export interface SettlementResolver {
  resolve(input: SettlementResolutionInput): Promise<ReviewableSettlementRecord | null>;
}

export class DynamicSettlementResolver implements SettlementResolver {
  constructor(
    private cache: SettlementCache,
    private escrowResolver: EscrowSettlementResolver,
    private quoteResolver: QuoteContractResolver,
    private identityResolver: IdentityResolver,
  ) {}

  async resolve(input: SettlementResolutionInput): Promise<ReviewableSettlementRecord | null> {
    // 1. Check cache
    const cached = await this.cache.get(input.chain, input.contractAddress, input.settlementId);
    if (cached) return cached;

    // 2. Try dynamic resolution
    try {
      const blockchain = await this.resolveFromBlockchain(input);
      if (!blockchain) return null;

      const identities = await this.identityResolver.resolve(blockchain);
      const record = this.buildSettlementRecord(input, blockchain, identities);
      
      // 3. Cache for future requests
      await this.cache.set(input.chain, input.contractAddress, input.settlementId, record);
      return record;
    } catch (error) {
      console.error('Dynamic resolution failed, falling back to static', error);
    }

    // 4. Fallback to static registry
    return this.fallbackRegistry.resolve(input);
  }
}
```

### Configuration

```toml
# wrangler.toml additions
[vars]
RSK_RPC_URL = "https://public-node.rsk.co"
BSC_RPC_URL = "https://bsc-dataseed.binance.org"
IDENTITY_REGISTRY_ADDRESS = "0x..."
SETTLEMENT_CACHE_TTL_SECONDS = "300"
ENABLE_DYNAMIC_RESOLUTION = "true"

[[kv_namespaces]]
binding = "SETTLEMENT_CACHE"
id = "..."
```

### Migration Path

1. Deploy with `ENABLE_DYNAMIC_RESOLUTION=false` (use existing static registry)
2. Test dynamic resolver in staging with specific contracts
3. Gradually enable for production with fallback to static
4. Eventually deprecate static registry

---

## 2. Reply Attestation Flow

### Current State

The schema defines kind 6432 for review replies, but no attestation flow exists. Reviewees cannot officially respond to reviews.

### Proposed Solution

Allow the reviewee (person being reviewed) to submit a verified reply to any review.

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      REPLY ATTESTATION FLOW                          │
└─────────────────────────────────────────────────────────────────────┘

1. Reviewee sees a review about them (kind 6430)
   └─▶ Fetches from Nostr relays: kind:6430 where p-tag contains their pubkey

2. Reviewee creates reply content
   └─▶ { parentReviewEventId, content: { en, es }, attachments }

3. POST /review-reply-attestations/challenge
   Request:
   {
     "parentReviewEventId": "original-review-id",
     "replyDraftHash": "sha256-of-reply-content",
     "revieweeNpub": "npub1reviewee...",
     "revieweeWallet": "0x..."
   }
   
   Backend verifies:
   ├─▶ Original review exists and is attested (kind 6431 exists)
   ├─▶ Caller's npub matches the reviewee from the attestation
   ├─▶ No existing reply for this review (one reply per review)
   └─▶ Rate limit OK

   Response:
   {
     "challengeToken": "v1...",
     "challengeMessage": "BitTasker reply attestation\n..."
   }

4. Reviewee signs challenge
   ├─▶ Nostr signature (Schnorr)
   └─▶ Wallet signature (ECDSA)

5. POST /review-reply-attestations
   Request:
   {
     "parentReviewEventId": "...",
     "signedReplyEvent": { kind: 6432, ... },
     "challengeToken": "...",
     "nostrChallengeSignature": "...",
     "walletChallengeSignature": "...",
     "revieweeNpub": "...",
     "revieweeWallet": "..."
   }

   Backend verifies:
   ├─▶ Challenge valid and not expired
   ├─▶ Both signatures valid
   ├─▶ Reply author matches reviewee from original attestation
   ├─▶ Reply content matches hash
   ├─▶ Claim reply slot (prevent duplicates)
   └─▶ Create attestation event (kind 6433 or tagged 6431)

6. Backend publishes reply attestation to relays
```

### New Endpoints

```typescript
// POST /review-reply-attestations/challenge
interface ReplyChallengRequest {
  parentReviewEventId: string;
  replyDraftHash: string;
  revieweeNpub: string;
  revieweeWallet: string;
}

// POST /review-reply-attestations
interface ReplyAttestationRequest {
  parentReviewEventId: string;
  signedReplyEvent: NostrSignedEvent;  // kind 6432
  challengeToken: string;
  nostrChallengeSignature: string;
  walletChallengeSignature: string;
  revieweeNpub: string;
  revieweeWallet: string;
}
```

### New Schemas

```typescript
// In packages/reviews-contracts/src/schemas.ts
export const replyAttestationChallengeRequestSchema = z.object({
  parentReviewEventId: z.string().regex(/^[a-f0-9]{64}$/i),
  replyDraftHash: hexHashSchema,
  revieweeNpub: nostrPubkeySchema,
  revieweeWallet: chainAddressSchema
}).strict();

export const replyAttestationRequestSchema = z.object({
  parentReviewEventId: z.string().regex(/^[a-f0-9]{64}$/i),
  signedReplyEvent: reviewReplySignedEventSchema,
  challengeToken: challengeTokenSchema,
  nostrChallengeSignature: hexSignatureSchema,
  walletChallengeSignature: walletSignatureSchema,
  revieweeNpub: nostrPubkeySchema,
  revieweeWallet: chainAddressSchema
}).strict();
```

### Implementation Steps

1. **Add reply slot tracking** to Durable Object:
   ```typescript
   // Keys: "reply-slot:{parentReviewEventId}" → { replyEventId, attestationEventId, issuedAt }
   async getReplySlot(parentReviewEventId: string): Promise<ReplySlotRecord | null>;
   async claimReplySlot(record: ReplySlotRecord): Promise<{ created: boolean; existing: ReplySlotRecord | null }>;
   ```

2. **Create ReplyAttestationService**:
   ```typescript
   export class ReplyAttestationService {
     async createChallenge(input: ReplyChallengRequest, meta: RequestMeta): Promise<ChallengeResponse>;
     async issueAttestation(input: ReplyAttestationRequest, meta: RequestMeta): Promise<AttestationResponse>;
   }
   ```

3. **Verify original review** before issuing reply challenge:
   ```typescript
   private async verifyOriginalReview(parentReviewEventId: string): Promise<{
     reviewEvent: NostrEvent;
     attestationEvent: NostrEvent;
     revieweePubkey: string;
     revieweeWallet: string;  // from settlement
   }> {
     // Query relay for the original review and its attestation
     // Extract reviewee identity from attestation
   }
   ```

4. **Register new routes**:
   ```typescript
   app.openapi(replyChallengRoute, async (c) => { ... });
   app.openapi(replyAttestationRoute, async (c) => { ... });
   ```

---

## 3. Historical Attestation Queries

### Current Limitation

The service publishes attestations to Nostr relays but cannot query historical attestations. Clients must implement their own relay subscriptions.

### Proposed Solution

Add an optional query interface that fetches attestations from configured relays.

### Use Cases

1. **Verify a specific attestation exists** for a review
2. **List all attestations** by a user
3. **Check attestation status** of a settlement slot

### API Design

```typescript
// GET /review-attestations/{reviewEventId}
// Returns the attestation for a specific review
interface AttestationQueryResponse {
  schemaVersion: 1;
  attestation: NostrSignedEvent | null;  // kind 6431
  verificationStatus: 'verified' | 'not_found' | 'invalid';
}

// GET /review-attestations?reviewerPubkey={pubkey}&since={timestamp}&limit={n}
// Lists attestations involving a specific reviewer
interface AttestationListResponse {
  schemaVersion: 1;
  attestations: NostrSignedEvent[];
  hasMore: boolean;
}

// GET /settlements/{settlementId}/attestation-status
// Checks if a settlement has been reviewed
interface SettlementAttestationStatus {
  schemaVersion: 1;
  settlementId: string;
  isReviewed: boolean;
  reviewEventId?: string;
  attestationEventId?: string;
  issuedAt?: number;
}
```

### Implementation Using nostr-tools

```typescript
// src/attestation-query-service.ts
import { SimplePool } from 'nostr-tools';

export class AttestationQueryService {
  private pool: SimplePool;
  
  constructor(private relays: string[], private issuerPubkey: string) {
    this.pool = new SimplePool();
  }

  async getAttestationForReview(reviewEventId: string): Promise<NostrEvent | null> {
    const events = await this.pool.querySync(this.relays, {
      kinds: [6431],
      authors: [this.issuerPubkey],
      '#e': [reviewEventId],
      limit: 1
    });
    
    return events[0] || null;
  }

  async listAttestationsByReviewer(
    reviewerPubkey: string,
    since?: number,
    limit: number = 20
  ): Promise<NostrEvent[]> {
    return this.pool.querySync(this.relays, {
      kinds: [6431],
      authors: [this.issuerPubkey],
      '#p': [reviewerPubkey],
      since,
      limit
    });
  }

  async getSettlementAttestationStatus(slotHash: string): Promise<{
    isReviewed: boolean;
    attestation?: NostrEvent;
  }> {
    // First check local Durable Object storage
    const localRecord = await this.stateClient.getIssuedSlot(slotHash);
    if (localRecord) {
      // Optionally verify on relays
      const attestation = await this.pool.querySync(this.relays, {
        kinds: [6431],
        ids: [localRecord.attestationEventId],
        limit: 1
      });
      return { isReviewed: true, attestation: attestation[0] };
    }
    
    return { isReviewed: false };
  }
}
```

### Caching Strategy

To avoid hitting relays on every query:

```typescript
export class CachedAttestationQueryService extends AttestationQueryService {
  constructor(
    relays: string[],
    issuerPubkey: string,
    private cache: KVNamespace,
    private cacheTtlSeconds: number = 60
  ) {
    super(relays, issuerPubkey);
  }

  async getAttestationForReview(reviewEventId: string): Promise<NostrEvent | null> {
    const cacheKey = `attestation:review:${reviewEventId}`;
    const cached = await this.cache.get(cacheKey, 'json');
    if (cached) return cached;

    const attestation = await super.getAttestationForReview(reviewEventId);
    if (attestation) {
      await this.cache.put(cacheKey, JSON.stringify(attestation), {
        expirationTtl: this.cacheTtlSeconds
      });
    }
    return attestation;
  }
}
```

### WebSocket Subscription Support

For real-time updates, consider adding a WebSocket endpoint:

```typescript
// Future: WebSocket endpoint for real-time attestation notifications
// /ws/attestations?pubkey={pubkey}

// Using Cloudflare Durable Objects with WebSocket Hibernation
export class AttestationSubscriptionDO {
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    
    // Handle subscription setup
    // Forward events from relay subscriptions to connected clients
    
    return new Response(null, { status: 101, webSocket: client });
  }
}
```

---

## 4. Deployment Runbook with Secret Rotation

### Overview

This section documents procedures for deploying and operating the Reviews Attestation Backend, including secret rotation for the issuer key.

### Pre-Deployment Checklist

```markdown
## Deployment Checklist

### Environment Verification
- [ ] Verify target environment (staging/production)
- [ ] Check current deployment status: `npx wrangler deployments list`
- [ ] Review recent changes in git log
- [ ] Run tests locally: `npm test`
- [ ] Check for pending migrations

### Secret Verification
- [ ] Verify required secrets are set: `npx wrangler secret list`
- [ ] Confirm issuer npub/nsec match (derived from same keypair)
- [ ] Verify HMAC secret is set
- [ ] Check relay configuration

### Deployment
- [ ] Deploy: `npm run deploy` or `npx wrangler deploy --env <env>`
- [ ] Verify health: `curl https://<worker-url>/health`
- [ ] Test challenge endpoint with known settlement
- [ ] Monitor logs: `npx wrangler tail`
```

### Secret Rotation Procedure

#### Issuer Key Rotation

The issuer key (nsec/npub) signs all attestations. Rotation is necessary when:
- Key compromise suspected
- Scheduled rotation policy
- Personnel changes

**Rotation Steps:**

```markdown
## Issuer Key Rotation

### Phase 1: Preparation (Day 0)

1. Generate new keypair:
   ```javascript
   import { generateSecretKey, getPublicKey } from 'nostr-tools';
   import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
   
   const newSk = generateSecretKey();
   const newPk = getPublicKey(newSk);
   console.log('New nsec:', nsecEncode(newSk));
   console.log('New npub:', npubEncode(newPk));
   console.log('New keyId: reviews-attestation-issuer-v2');
   ```

2. Update issuer registry JSON to include both keys:
   ```json
   {
     "issuers": [
       {
         "keyId": "reviews-attestation-issuer-v1",
         "pubkey": "<old-pubkey-hex>",
         "status": "active",
         "validFrom": 0,
         "validUntil": <rotation-timestamp-ms>
       },
       {
         "keyId": "reviews-attestation-issuer-v2",
         "pubkey": "<new-pubkey-hex>",
         "status": "active",
         "validFrom": <rotation-timestamp-ms>,
         "validUntil": null
       }
     ]
   }
   ```

3. Deploy registry update (old key still active)
   ```bash
   npx wrangler secret put REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON
   # Paste the updated JSON
   npm run deploy
   ```

### Phase 2: Cutover (Rotation Timestamp)

4. Update active key configuration:
   ```bash
   npx wrangler secret put REVIEW_ATTESTATION_ISSUER_KEY_ID
   # Enter: reviews-attestation-issuer-v2
   
   npx wrangler secret put REVIEW_ATTESTATION_ISSUER_NPUB
   # Enter: <new-npub>
   
   npx wrangler secret put REVIEW_ATTESTATION_ISSUER_NSEC
   # Enter: <new-nsec>
   ```

5. Deploy:
   ```bash
   npm run deploy
   ```

6. Verify new key is active:
   ```bash
   curl https://<worker-url>/review-attestation-issuers | jq '.issuers[] | select(.status=="active")'
   ```

### Phase 3: Verification

7. Test challenge with new key:
   ```bash
   # Submit a test challenge request
   # Verify the challenge token is signed by new key
   ```

8. Verify old attestations still validate:
   - Old attestations remain valid (verify against old pubkey in registry)
   - New attestations use new key

### Phase 4: Cleanup (After Grace Period)

9. After grace period (e.g., 30 days), update registry:
   ```json
   {
     "issuers": [
       {
         "keyId": "reviews-attestation-issuer-v1",
         "pubkey": "<old-pubkey-hex>",
         "status": "retired",
         "validFrom": 0,
         "validUntil": <rotation-timestamp-ms>
       },
       {
         "keyId": "reviews-attestation-issuer-v2",
         "pubkey": "<new-pubkey-hex>",
         "status": "active",
         "validFrom": <rotation-timestamp-ms>,
         "validUntil": null
       }
     ]
   }
   ```

10. Securely destroy old nsec (if no longer needed for verification)
```

#### HMAC Secret Rotation

The HMAC secret is used for slot hashing. Rotation breaks in-progress challenges but doesn't affect issued attestations.

```markdown
## HMAC Secret Rotation

**Warning:** Rotating HMAC secret will invalidate all in-progress challenges.
Schedule rotation during low-traffic periods.

1. Generate new secret:
   ```javascript
   const newSecret = crypto.getRandomValues(new Uint8Array(32));
   console.log(Buffer.from(newSecret).toString('hex'));
   ```

2. Set new secret:
   ```bash
   npx wrangler secret put REVIEW_SLOT_HMAC_SECRET
   # Enter: <new-64-char-hex>
   ```

3. Deploy immediately:
   ```bash
   npm run deploy
   ```

4. Monitor for challenge_invalid errors (expected for in-flight challenges)
```

### Monitoring & Alerting

```typescript
// Recommended monitoring points

// 1. Health endpoint
// Alert if: /health returns non-200 for > 1 minute

// 2. Error rates
// Alert if: error_code="internal_error" rate > 1/minute

// 3. Rate limiting
// Alert if: error_code="rate_limited" rate > 100/minute (possible attack)

// 4. Challenge expiration
// Alert if: error_code="challenge_expired" rate > 50% of attestation attempts

// 5. Relay publishing
// Alert if: error_code="attestation_publish_failed" rate > 10/minute
```

### Rollback Procedure

```markdown
## Emergency Rollback

### If new deployment causes issues:

1. Identify the previous working deployment:
   ```bash
   npx wrangler deployments list
   ```

2. Rollback to previous version:
   ```bash
   npx wrangler rollback <deployment-id>
   ```

3. Verify rollback:
   ```bash
   curl https://<worker-url>/health
   ```

### If secret change causes issues:

1. Restore previous secret values (must have backup)
2. Redeploy is not required (secrets take effect immediately)
3. Verify with health check and test request
```

### Backup Procedures

```markdown
## Secret Backup

### What to Backup
- Issuer nsec (encrypted, offline storage)
- Issuer registry JSON (version controlled separately)
- HMAC secret (encrypted, offline storage)

### Backup Locations
- Primary: Hardware security module (HSM) or secure vault
- Secondary: Encrypted file in air-gapped storage
- Never: Git, cloud storage, email, chat

### Restoration Testing
- Quarterly: Test restoration of secrets to staging environment
- Document restoration procedure with timestamps
```

---

## Implementation Priority

| Feature | Priority | Complexity | Dependencies |
|---------|----------|------------|--------------|
| Dynamic Settlement Resolver | High | High | RPC nodes, Identity service |
| Reply Attestation Flow | Medium | Medium | None |
| Historical Queries | Low | Low | None |
| Secret Rotation Runbook | High | Low | None (documentation) |

## Next Steps

1. **Document existing blockchain contracts** - ABIs, addresses, state mappings
2. **Set up RPC endpoints** - RSK and BSC node access
3. **Design identity resolution** - Choose between on-chain registry vs binding proofs
4. **Create staging environment** - For testing dynamic resolution
5. **Write integration tests** - For new resolver implementations

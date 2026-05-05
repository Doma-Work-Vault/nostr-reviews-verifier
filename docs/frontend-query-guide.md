# Frontend Nostr Relay Query Guide

## Why query relays directly?

The reviews attestation backend is a cryptographic attestation issuer — its job is to verify settlements on-chain, verify dual signatures, and publish attestation events to Nostr relays. It is **not** a relay proxy.

Querying relays directly from the frontend:
- **Lower latency** — no extra hop through the Worker
- **Reduced backend load** — keeps the Worker focused on attestation issuance
- **Natural fit** — the frontend already holds Nostr connections for signing and publishing

## Prerequisites

- `nostr-tools` (`SimplePool`) or `@nostr-dev-kit/ndk` for relay subscriptions
- The issuer's pubkey (hex format, available from `GET /review-attestation-issuers`)
- Configured relay URLs (same as `REVIEW_ATTESTATION_NOSTR_RELAYS_JSON`)

## Query Patterns

### 1. Get attestation by event ID

```typescript
import { SimplePool } from 'nostr-tools';

const pool = new SimplePool();

async function getAttestationById(relays: string[], eventId: string): Promise<Event | null> {
  const events = await pool.querySync(relays, {
    kinds: [6431],
    ids: [eventId],
    limit: 1
  });
  return events[0] ?? null;
}
```

### 2. Get latest attestation for a settlement slot (NIP-33)

The `d` tag on Kind 6431 attestation events is the `slotHash` — an HMAC derived from settlement material. This is stable per settlement, enabling NIP-33 replaceable-event semantics.

```typescript
async function getAttestationBySlot(
  relays: string[],
  issuerPubkey: string,
  slotHash: string
): Promise<Event | null> {
  const events = await pool.querySync(relays, {
    kinds: [6431],
    authors: [issuerPubkey],
    '#d': [slotHash],
    limit: 1
  });
  return events[0] ?? null;
}
```

**How to compute `slotHash` on the frontend:**

The `slotHash` is returned inside the challenge token payload. Parse the challenge token to extract it:

```typescript
// After receiving a challenge response:
// GET /review-attestation-issuers to get the issuer pubkey
// Decode the base64url segment of the challenge token to get slotHash
```

Alternatively, if you have the settlement record and the HMAC secret (backend-only), use `buildSettlementSlotHash()` from `@bittasker/reviews-contracts`. The frontend should **not** have the HMAC secret — instead, extract `slotHash` from the challenge token or attestation event `d` tag.

### 3. List attestations by reviewer pubkey

```typescript
async function getAttestationsByPubkey(
  relays: string[],
  pubkey: string,
  limit = 20
): Promise<Event[]> {
  return pool.querySync(relays, {
    kinds: [6431],
    '#p': [pubkey],
    limit
  });
}
```

### 4. Subscribe to live attestation events

```typescript
import { Sub } from 'nostr-tools';

const sub = pool.sub(relays, [{
  kinds: [6431],
  authors: [issuerPubkey],
  since: Math.floor(Date.now() / 1000)
}]);

sub.on('event', (event: Event) => {
  console.log('New attestation:', event);
});
```

## Event Kinds Reference

| Kind | Name | Description |
|------|------|-------------|
| 6430 | Review | User's review content (signed by reviewer) |
| 6431 | Attestation | Issuer's cryptographic attestation of the review |
| 6432 | Reply | Reviewee's response to a review |
| 6433 | Reply Attestation | Issuer's attestation of the reply |

## Tag Reference

| Tag | Description | Example |
|-----|-------------|---------|
| `d` | NIP-33 instance identifier (slotHash for Kind 6431) | `["d", "<64-char-hex-slot-hash>"]` |
| `e` | Referenced event ID | `["e", "<review-event-id>"]` |
| `p` | Participant pubkey | `["p", "<hex-pubkey>"]` |

## Backend Endpoints Available for Query Support

The backend exposes one query endpoint served from Durable Object local state (fast, no relay round-trip):

| Endpoint | Description |
|----------|-------------|
| `GET /review-attestation-issuers` | Active issuer keys (pubkeys for subscription filtering) |
| `GET /health` | Backend health status |

For all attestation event retrieval, query relays directly.

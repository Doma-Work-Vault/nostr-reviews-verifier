# Settlement Registry Format

This document describes the format and field requirements for the `REVIEWS_SETTLEMENT_REGISTRY_JSON` configuration used by the Reviews Attestation Backend.

## Overview

The settlement registry is a JSON array of `ReviewableSettlementRecord` objects. Each record represents a completed blockchain settlement that is eligible for review.

**Important:** The current implementation uses a **static registry** loaded from environment variables. Settlements must be manually added to this JSON before users can submit reviews. See [docs/dynamic-settlement.md](./dynamic-settlement.md) for plans to implement dynamic resolution.

## Full Schema

```json
{
  "subjectType": "task" | "service_booking",
  "subjectId": "string (required, min 1 char)",
  "settlementType": "escrow" | "service_quote_contract" | "instant_buy_contract",
  "settlementId": "string (required, min 1 char)",
  "chain": "rsk" | "bsc",
  "asset": "rbtc" | "usdt",
  "contractAddress": "string (required, blockchain address)",
  "contractVersion": "string (required, min 1 char)",
  "reviewerRole": "tasker" | "taskee" | "client" | "freelancer" | "provider",
  "revieweeRole": "tasker" | "taskee" | "client" | "freelancer" | "provider",
  "reviewerNpub": "npub1... | hex pubkey (required when status=reviewable)",
  "revieweeNpub": "npub1... | hex pubkey (required when status=reviewable)",
  "reviewerWallet": "0x... (required when status=reviewable)",
  "revieweeWallet": "0x... (required when status=reviewable)",
  "blockchainState": "funds_released" | "funds_claimed" | "dispute_resolved" | "dispute_unresolved" | "refunded" | ...,
  "completedAt": "number (Unix timestamp in milliseconds)",
  "reviewableAt": "number (Unix timestamp in milliseconds)",
  "contractOutcome": "completed" | "disputed_resolved_payout" | "disputed_resolved_refund" | "refunded",
  "status": "reviewable" | "already_reviewed" | "not_reviewable",
  "sourceVisibility": "public_present" | "public_deleted" | "public_unknown",
  "sourcePresentation": {
    "label": "string (optional, display label)",
    "href": "string | null (optional, link to source)"
  },
  "sourceRefs": {
    "escrowId": "string (optional)",
    "quoteRequestId": "string (optional)",
    "proposalId": "string (optional)",
    "instantOrderId": "string (optional)"
  }
}
```

## Field Reference

### Subject Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subjectType` | enum | Yes | Type of subject being reviewed |
| `subjectId` | string | Yes | Unique identifier for the subject (e.g., task ID) |

**Subject Types:**
- `task` - A one-off task or job
- `service_booking` - A recurring or scheduled service

### Settlement Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `settlementType` | enum | Yes | Type of smart contract used |
| `settlementId` | string | Yes | Unique identifier for the settlement |

**Settlement Types:**
- `escrow` - BitTasker escrow contract for task payments
- `service_quote_contract` - Service booking quote contract
- `instant_buy_contract` - Instant purchase contract

### Blockchain Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | enum | Yes | Blockchain network |
| `asset` | enum | Yes | Payment asset |
| `contractAddress` | string | Yes | Smart contract address (0x format) |
| `contractVersion` | string | Yes | Contract version identifier |

**Supported Chains:**
- `rsk` - RSK (Rootstock) sidechain
- `bsc` - Binance Smart Chain

**Supported Assets:**
- `rbtc` - RSK Bitcoin (on RSK chain)
- `usdt` - Tether USD (on BSC chain)

### Participant Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reviewerRole` | enum | Yes | Role of the person submitting the review |
| `revieweeRole` | enum | Yes | Role of the person being reviewed |
| `reviewerNpub` | string | Conditional* | Nostr public key of reviewer |
| `revieweeNpub` | string | Conditional* | Nostr public key of reviewee |
| `reviewerWallet` | string | Conditional* | EVM wallet address of reviewer |
| `revieweeWallet` | string | Conditional* | EVM wallet address of reviewee |

*Required when `status` is `"reviewable"`.

**Roles:**
- `tasker` - Person who posted a task
- `taskee` - Person who completed a task
- `client` - Client in a service relationship
- `freelancer` - Freelancer in a service relationship
- `provider` - Service provider

### State Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `blockchainState` | enum | Yes | Current state of the smart contract |
| `contractOutcome` | enum | Yes | Final outcome of the contract |
| `status` | enum | Yes | Review eligibility status |

**Blockchain States:**
| State | Description |
|-------|-------------|
| `funded` | Contract has been funded |
| `in_dispute` | Dispute has been raised |
| `dispute_resolved` | Dispute has been resolved |
| `dispute_unresolved` | Dispute timed out without resolution |
| `completed` | Work marked as completed |
| `cancelled` | Contract was cancelled |
| `refunded` | Funds returned to payer |
| `funds_released` | Funds released to payee |
| `funds_claimed` | Funds claimed by payee |
| `work_in_progress` | Work is ongoing |
| `no_show` | Party failed to show/deliver |
| `in_dispute_wip` | Disputed while work in progress |

**Contract Outcomes (reviewable states):**
| Outcome | When Reviewable |
|---------|-----------------|
| `completed` | When `blockchainState` is `funds_released` or `funds_claimed` |
| `disputed_resolved_payout` | When `blockchainState` is `dispute_resolved` (payout to provider) |
| `disputed_resolved_refund` | When `blockchainState` is `dispute_resolved` (refund to client) |
| `refunded` | When `blockchainState` is `dispute_unresolved` or `refunded` |

**Status:**
- `reviewable` - Settlement can be reviewed
- `already_reviewed` - A review has already been submitted
- `not_reviewable` - Settlement cannot be reviewed (wrong state, missing data, etc.)

### Timestamp Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `completedAt` | number | Yes | When the settlement was finalized (Unix ms) |
| `reviewableAt` | number | Yes | When the review window opened (Unix ms) |

### Source Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceVisibility` | enum | Yes | Visibility of the source data |
| `sourcePresentation` | object | Yes | Display information |
| `sourceRefs` | object | Yes | Reference IDs for related entities |

**Source Visibility:**
- `public_present` - Source data is publicly visible
- `public_deleted` - Source data was deleted but was public
- `public_unknown` - Visibility unknown

**Source Presentation:**
```json
{
  "label": "Task #123: Website Bug Fix",
  "href": "https://bittasker.io/tasks/123"
}
```

**Source Refs:**
```json
{
  "escrowId": "esc-456",
  "quoteRequestId": "qr-789",
  "proposalId": "prop-012",
  "instantOrderId": "io-345"
}
```

## Complete Example

```json
[
  {
    "subjectType": "task",
    "subjectId": "task-2024-001",
    "settlementType": "escrow",
    "settlementId": "escrow-a1b2c3d4",
    "chain": "rsk",
    "asset": "rbtc",
    "contractAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE8C",
    "contractVersion": "2.1.0",
    "reviewerRole": "client",
    "revieweeRole": "provider",
    "reviewerNpub": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn",
    "revieweeNpub": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqeq6c2j",
    "reviewerWallet": "0x1234567890AbcdEF1234567890aBcDeF12345678",
    "revieweeWallet": "0xFeDcBa0987654321FeDcBa0987654321fEdCbA09",
    "blockchainState": "funds_released",
    "completedAt": 1713800000000,
    "reviewableAt": 1713800000000,
    "contractOutcome": "completed",
    "status": "reviewable",
    "sourceVisibility": "public_present",
    "sourcePresentation": {
      "label": "Task #2024-001: Smart Contract Audit",
      "href": "https://bittasker.io/tasks/2024-001"
    },
    "sourceRefs": {
      "escrowId": "escrow-a1b2c3d4",
      "proposalId": "prop-xyz789"
    }
  },
  {
    "subjectType": "service_booking",
    "subjectId": "booking-2024-055",
    "settlementType": "service_quote_contract",
    "settlementId": "quote-contract-e5f6g7h8",
    "chain": "bsc",
    "asset": "usdt",
    "contractAddress": "0x9876543210AbCdEf9876543210aBcDeF98765432",
    "contractVersion": "1.0.0",
    "reviewerRole": "client",
    "revieweeRole": "freelancer",
    "reviewerNpub": "npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9qcjk3",
    "revieweeNpub": "npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbh4xsmp",
    "reviewerWallet": "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
    "revieweeWallet": "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
    "blockchainState": "dispute_resolved",
    "completedAt": 1713900000000,
    "reviewableAt": 1713900000000,
    "contractOutcome": "disputed_resolved_payout",
    "status": "reviewable",
    "sourceVisibility": "public_present",
    "sourcePresentation": {
      "label": "Service Booking: Web Development",
      "href": "https://bittasker.io/bookings/2024-055"
    },
    "sourceRefs": {
      "quoteRequestId": "qr-booking-055"
    }
  }
]
```

## Validation Rules

### Required for Reviewable Status

When `status` is `"reviewable"`, the following fields **must** have values:
- `reviewerNpub`
- `revieweeNpub`
- `reviewerWallet`
- `revieweeWallet`

### Outcome-State Compatibility

Not all combinations of `blockchainState` and `contractOutcome` are valid:

| blockchainState | Valid contractOutcome |
|-----------------|----------------------|
| `funds_released` | `completed` |
| `funds_claimed` | `completed` |
| `dispute_resolved` | `disputed_resolved_payout`, `disputed_resolved_refund` |
| `dispute_unresolved` | `refunded` |
| `refunded` | `refunded` |

### Address Formats

- **Nostr pubkeys**: Either `npub1...` (bech32) or 64-char lowercase hex
- **Wallet addresses**: `0x` prefixed, 40 hex characters (checksummed or lowercase)

## Operator Workflow

### Adding a New Settlement

1. **Query the blockchain** for settlement details
2. **Verify the state** is reviewable (funds released, dispute resolved, etc.)
3. **Collect participant data** (wallet addresses, Nostr pubkeys)
4. **Create the settlement record** following this schema
5. **Add to the registry JSON** 
6. **Update the environment variable** `REVIEWS_SETTLEMENT_REGISTRY_JSON`
7. **Redeploy the Worker** (if production) or restart dev server

### Removing a Settlement

To mark a settlement as no longer reviewable:
1. Change `status` to `"already_reviewed"` or `"not_reviewable"`
2. Optionally remove participant fields to save space
3. Update and redeploy

### Registry Size Limits

Environment variables have size limits:
- Cloudflare Workers: ~1MB for all env vars combined
- For large registries, consider external storage (see dynamic settlement plans)

## Troubleshooting

### "resolver_not_found" Error

The settlement was not found in the registry. Check:
- All fields in the request match the registry entry exactly
- Contract address comparison is case-insensitive
- Settlement has been added to the JSON

### "contract_outcome_invalid" Error

The settlement's state doesn't allow reviews. Check:
- `blockchainState` matches one of the reviewable states
- `contractOutcome` is compatible with the state

### "settlement_not_reviewable" Error

Missing participant bindings. Ensure:
- `reviewerNpub`, `revieweeNpub` are set
- `reviewerWallet`, `revieweeWallet` are set
- `status` is `"reviewable"`

### "participant_mismatch" Error

Request participant data doesn't match settlement. Verify:
- `reviewerNpub` in request matches `reviewerNpub` in registry
- Same for `revieweeNpub`, `reviewerWallet`, `revieweeWallet`
- Addresses are in the correct format (checksummed vs lowercase)

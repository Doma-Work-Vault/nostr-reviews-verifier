# @bittasker/reviews-contracts

Shared **Zod** schemas, constants, hashing helpers, and minimal **viem** ABI fragments for BitTasker review attestation flows (Nostr kinds, challenge payloads, settlement typing, and on-chain verification).

## Install

```bash
npm install @bittasker/reviews-contracts
```

Peer dependencies (install in your app):

- `zod` ^3 or ^4
- `@noble/hashes` ^1.8
- `nostr-tools` ^2.13 (declared for ecosystem alignment; most APIs here only need `@noble/hashes`)

## Usage

```ts
import {
	reviewEventPayloadSchema,
	buildReviewDraftHash,
	V2_PAYMENT_STATE_ABI,
	LEGACY_ESCROW_ABI
} from '@bittasker/reviews-contracts';
```

The published artifact is **ESM** (`"type": "module"`) with TypeScript declarations under `dist/`.

## Develop

```bash
npm install
npm run build
npm test
```

## License

`UNLICENSED` — replace the `license` field in `package.json` and add a `LICENSE` file before publishing if you intend an open-source terms.

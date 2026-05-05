import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { bytesToHex } from 'nostr-tools/utils';

/** Raw noble SHA-256 hash function — for use with noble HMAC and Schnorr primitives. */
export { nobleSha256 as sha256Fn };

/** Synchronous SHA-256 hash — returns hex string. */
export function sha256Hex(input: string): string {
	return bytesToHex(nobleSha256(utf8ToBytes(input)));
}


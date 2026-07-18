import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  constantTimeInvitationTokenHashEqual,
  createInvitationTokenHint,
  createInvitationTokenStorage,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TOKEN_ENTROPY_BYTES,
  INVITATION_TOKEN_HASH_LENGTH,
  INVITATION_TOKEN_HINT_LENGTH,
  INVITATION_TOKEN_LENGTH,
  InvitationTokenError,
  invitationTokenMatchesHash,
  isValidInvitationToken,
  isValidInvitationTokenHash,
  type InvitationTokenRandomBytes,
} from "../modules/identity/invitation-token.ts";

function fixedRng(fill: number): InvitationTokenRandomBytes {
  return (size) => Buffer.alloc(size, fill);
}

describe("invitation token security", () => {
  it("requests at least 32 bytes of entropy and emits canonical unpadded base64url", () => {
    const requestedSizes: number[] = [];
    const token = generateInvitationToken((size) => {
      requestedSizes.push(size);
      return Buffer.alloc(size, 0xa5);
    });

    assert.ok(INVITATION_TOKEN_ENTROPY_BYTES >= 32);
    assert.deepEqual(requestedSizes, [INVITATION_TOKEN_ENTROPY_BYTES]);
    assert.equal(Buffer.from(token, "base64url").length, INVITATION_TOKEN_ENTROPY_BYTES);
    assert.equal(token.length, INVITATION_TOKEN_LENGTH);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(token, /=/);
    assert.equal(isValidInvitationToken(token), true);
  });

  it("uses the secure default RNG to produce unique tokens", () => {
    const tokens = Array.from({ length: 128 }, () => generateInvitationToken());

    assert.equal(new Set(tokens).size, tokens.length);
    for (const token of tokens) {
      assert.equal(isValidInvitationToken(token), true);
    }
  });

  it("supports an explicit deterministic RNG", () => {
    const first = generateInvitationToken(fixedRng(0x11));
    const second = generateInvitationToken(fixedRng(0x11));
    const different = generateInvitationToken(fixedRng(0x12));

    assert.equal(first, second);
    assert.notEqual(first, different);
  });

  it("produces stable fixed-length SHA-256 hashes that distinguish tokens", () => {
    const first = generateInvitationToken(fixedRng(0x21));
    const second = generateInvitationToken(fixedRng(0x22));
    const firstHash = hashInvitationToken(first);

    assert.equal(firstHash, hashInvitationToken(first));
    assert.notEqual(firstHash, hashInvitationToken(second));
    assert.equal(firstHash.length, INVITATION_TOKEN_HASH_LENGTH);
    assert.match(firstHash, /^[a-f0-9]{64}$/);
    assert.equal(isValidInvitationTokenHash(firstHash), true);
  });

  it("returns a database representation with only a hash and non-secret short hint", () => {
    const token = generateInvitationToken(fixedRng(0x31));
    const storage = createInvitationTokenStorage(token);

    assert.deepEqual(Object.keys(storage).sort(), ["tokenHash", "tokenHint"]);
    assert.equal(storage.tokenHash, hashInvitationToken(token));
    assert.equal(storage.tokenHash.length, INVITATION_TOKEN_HASH_LENGTH);
    assert.equal(storage.tokenHint, createInvitationTokenHint(token));
    assert.equal(storage.tokenHint.length, INVITATION_TOKEN_HINT_LENGTH);
    assert.match(storage.tokenHint, /^[a-f0-9]+$/);
    assert.equal(storage.tokenHash.includes(token), false);
    assert.equal(storage.tokenHint.includes(token), false);
  });

  it("never exposes a short invalid token through a hint or error", () => {
    const shortToken = "short-secret";

    assert.equal(isValidInvitationToken(shortToken), false);
    for (const operation of [
      () => createInvitationTokenHint(shortToken),
      () => createInvitationTokenStorage(shortToken),
      () => hashInvitationToken(shortToken),
    ]) {
      assert.throws(operation, (error: unknown) => {
        assert.ok(error instanceof InvitationTokenError);
        assert.equal(error.code, "invalid_token");
        assert.equal(error.message.includes(shortToken), false);
        return true;
      });
    }
  });

  it("strictly rejects malformed, padded, noncanonical, and wrong-length tokens", () => {
    const canonicalZeroToken = generateInvitationToken(fixedRng(0));
    const noncanonicalLastCharacter = `${canonicalZeroToken.slice(0, -1)}B`;
    const malformed = [
      "",
      canonicalZeroToken.slice(1),
      `${canonicalZeroToken}A`,
      `${canonicalZeroToken}=`,
      `${canonicalZeroToken.slice(0, -1)}+`,
      `${canonicalZeroToken.slice(0, -1)}/`,
      `${canonicalZeroToken.slice(0, -1)} `,
      `${canonicalZeroToken.slice(0, -1)}é`,
      noncanonicalLastCharacter,
      null,
      42,
    ];

    assert.equal(isValidInvitationToken(canonicalZeroToken), true);
    assert.equal(Buffer.from(noncanonicalLastCharacter, "base64url").toString("base64url"), canonicalZeroToken);
    for (const value of malformed) {
      assert.equal(isValidInvitationToken(value), false);
      assert.equal(invitationTokenMatchesHash(value, hashInvitationToken(canonicalZeroToken)), false);
    }
  });

  it("compares valid token hashes and handles all length mismatches without throwing", () => {
    const first = generateInvitationToken(fixedRng(0x41));
    const second = generateInvitationToken(fixedRng(0x42));
    const firstHash = hashInvitationToken(first);
    const secondHash = hashInvitationToken(second);

    assert.equal(constantTimeInvitationTokenHashEqual(firstHash, firstHash), true);
    assert.equal(constantTimeInvitationTokenHashEqual(firstHash, secondHash), false);
    assert.equal(invitationTokenMatchesHash(first, firstHash), true);
    assert.equal(invitationTokenMatchesHash(second, firstHash), false);

    for (const malformedHash of [
      firstHash.slice(1),
      `${firstHash}0`,
      firstHash.slice(0, -1),
      firstHash.toUpperCase(),
      `${firstHash.slice(0, -1)}z`,
      "",
      null,
    ]) {
      assert.doesNotThrow(() => constantTimeInvitationTokenHashEqual(firstHash, malformedHash));
      assert.equal(constantTimeInvitationTokenHashEqual(firstHash, malformedHash), false);
      assert.equal(invitationTokenMatchesHash(first, malformedHash), false);
      assert.equal(isValidInvitationTokenHash(malformedHash), false);
    }
  });

  it("fails closed and sanitizes RNG failures", () => {
    const providerSecret = "provider-leaked-secret";
    const throwingRng: InvitationTokenRandomBytes = () => {
      throw new Error(providerSecret);
    };

    for (const rng of [throwingRng, (() => Buffer.alloc(31)) as InvitationTokenRandomBytes]) {
      assert.throws(() => generateInvitationToken(rng), (error: unknown) => {
        assert.ok(error instanceof InvitationTokenError);
        assert.equal(error.code, "generation_failed");
        assert.equal(error.message.includes(providerSecret), false);
        return true;
      });
    }
  });
});

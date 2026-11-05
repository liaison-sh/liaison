// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  decryptSecret,
  encryptSecret,
  generateNumericCode,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "~/lib/crypto"

describe("password hashing", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct-password")
    expect(await verifyPassword("correct-password", hash)).toBe(true)
  })

  it("rejects wrong password", async () => {
    const hash = await hashPassword("correct-password")
    expect(await verifyPassword("wrong-password", hash)).toBe(false)
  })

  it("produces different hashes for same input (salt randomness)", async () => {
    const hash1 = await hashPassword("same-password")
    const hash2 = await hashPassword("same-password")
    expect(hash1).not.toBe(hash2)
  })
})

describe("token generation", () => {
  it("generates a base64url-encoded token", () => {
    const token = generateToken()
    expect(token.length).toBeGreaterThan(0)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()))
    expect(tokens.size).toBe(100)
  })

  it("hashToken produces consistent SHA-256 hash", () => {
    const token = "test-token"
    const hash1 = hashToken(token)
    const hash2 = hashToken(token)
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64)
  })

  it("different tokens produce different hashes", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"))
  })
})

describe("numeric code generation", () => {
  it("generates a zero-padded code of the requested width", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateNumericCode(6)
      expect(code).toHaveLength(6)
      expect(code).toMatch(/^\d{6}$/)
    }
  })

  it("honours a custom digit count", () => {
    expect(generateNumericCode(4)).toMatch(/^\d{4}$/)
    expect(generateNumericCode(8)).toMatch(/^\d{8}$/)
  })

  it("can produce leading-zero codes (padding, not truncation)", () => {
    // Across many samples at least one should start with 0 — proving we pad
    // rather than drop leading zeros (which would leak code length).
    const codes = Array.from({ length: 500 }, () => generateNumericCode(6))
    expect(codes.some((c) => c.startsWith("0"))).toBe(true)
    expect(codes.every((c) => c.length === 6)).toBe(true)
  })

  it("is not trivially constant (distribution sanity)", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateNumericCode(6)))
    // Collisions in 100 draws from 1e6 are astronomically unlikely.
    expect(codes.size).toBeGreaterThan(90)
  })
})

describe("secret encryption", () => {
  // Two distinct valid 32-byte (64 hex char) AES-256 keys.
  const KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const OTHER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  const CONTEXT = "kernel.connected_accounts:org-1:access_token"

  it("round-trips plaintext under the same key and context", () => {
    const encrypted = encryptSecret("super-secret-token", KEY, CONTEXT)
    expect(decryptSecret(encrypted, KEY, CONTEXT)).toBe("super-secret-token")
  })

  it("uses a random IV for each encryption", () => {
    const a = encryptSecret("same-plaintext", KEY, CONTEXT)
    const b = encryptSecret("same-plaintext", KEY, CONTEXT)
    expect(a).not.toBe(b)
    // The IV is the first dot-separated segment.
    expect(a.split(".")[0]).not.toBe(b.split(".")[0])
    // Both still decrypt to the same plaintext.
    expect(decryptSecret(a, KEY, CONTEXT)).toBe("same-plaintext")
    expect(decryptSecret(b, KEY, CONTEXT)).toBe("same-plaintext")
  })

  it("throws when decrypting with a different context (AAD binding)", () => {
    const encrypted = encryptSecret("token", KEY, CONTEXT)
    expect(() =>
      decryptSecret(encrypted, KEY, "kernel.connected_accounts:org-2:access_token"),
    ).toThrow()
    // Same row, different field — must also fail.
    expect(() =>
      decryptSecret(encrypted, KEY, "kernel.connected_accounts:org-1:refresh_token"),
    ).toThrow()
  })

  it("throws when decrypting with the wrong key", () => {
    const encrypted = encryptSecret("token", KEY, CONTEXT)
    expect(() => decryptSecret(encrypted, OTHER_KEY, CONTEXT)).toThrow()
  })

  it("throws on a flipped ciphertext byte", () => {
    const encrypted = encryptSecret("token", KEY, CONTEXT)
    const [iv, tag, data] = encrypted.split(".")
    const dataBytes = Buffer.from(data, "base64")
    dataBytes[0] ^= 0xff
    const tampered = `${iv}.${tag}.${dataBytes.toString("base64")}`
    expect(() => decryptSecret(tampered, KEY, CONTEXT)).toThrow()
  })

  it("throws on a flipped auth-tag byte", () => {
    const encrypted = encryptSecret("token", KEY, CONTEXT)
    const [iv, tag, data] = encrypted.split(".")
    const tagBytes = Buffer.from(tag, "base64")
    tagBytes[0] ^= 0xff
    const tampered = `${iv}.${tagBytes.toString("base64")}.${data}`
    expect(() => decryptSecret(tampered, KEY, CONTEXT)).toThrow()
  })

  it("throws on a malformed split (not exactly three parts)", () => {
    expect(() => decryptSecret("only-one-part", KEY, CONTEXT)).toThrow("Invalid ciphertext format")
    const encrypted = encryptSecret("token", KEY, CONTEXT)
    expect(() => decryptSecret(`${encrypted}.extra`, KEY, CONTEXT)).toThrow(
      "Invalid ciphertext format",
    )
  })

  it("throws on a truncated IV", () => {
    const encrypted = encryptSecret("token", KEY, CONTEXT)
    const [iv, tag, data] = encrypted.split(".")
    const shortIv = Buffer.from(iv, "base64").subarray(0, 8)
    const tampered = `${shortIv.toString("base64")}.${tag}.${data}`
    expect(() => decryptSecret(tampered, KEY, CONTEXT)).toThrow("Invalid ciphertext format")
  })

  it("throws on a truncated auth tag", () => {
    const encrypted = encryptSecret("token", KEY, CONTEXT)
    const [iv, tag, data] = encrypted.split(".")
    const shortTag = Buffer.from(tag, "base64").subarray(0, 8)
    const tampered = `${iv}.${shortTag.toString("base64")}.${data}`
    expect(() => decryptSecret(tampered, KEY, CONTEXT)).toThrow("Invalid ciphertext format")
  })
})

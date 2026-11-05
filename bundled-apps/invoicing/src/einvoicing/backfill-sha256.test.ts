// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pure-JS SHA-256 and base64 decoder the legacy-original backfill runs inside the sandbox
// (no node:crypto, no Buffer and no typed arrays there). Checked against published vectors and against the runtime's
// own hasher / decoder on a large patterned input.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { base64ToBytes, sha256Hex, sha256OfBase64 } from "./backfill-sha256"

const enc = (s: string) => new TextEncoder().encode(s)

function bunSha256(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256")
  h.update(bytes)
  return h.digest("hex")
}

function pattern(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff
  return out
}

describe("sha256Hex", () => {
  test("empty input", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })

  test('"abc"', () => {
    expect(sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("the two-block NIST vector", () => {
    expect(sha256Hex(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    )
  })

  test("lengths around the padding boundary match the runtime hasher", () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const bytes = pattern(n)
      expect(sha256Hex(bytes)).toBe(bunSha256(bytes))
    }
  })

  test("a 1 MiB patterned input matches the runtime hasher", () => {
    const bytes = pattern(1024 * 1024)
    expect(sha256Hex(bytes)).toBe(bunSha256(bytes))
  })
})

describe("base64ToBytes", () => {
  test("decodes every padding form", () => {
    for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      const b64 = Buffer.from(s, "utf8").toString("base64")
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(enc(s)))
    }
  })

  test("a 1 MiB binary input round-trips through the runtime encoder", () => {
    const bytes = pattern(1024 * 1024 + 1)
    const decoded = base64ToBytes(Buffer.from(bytes).toString("base64"))
    expect(decoded.length).toBe(bytes.length)
    expect(sha256Hex(decoded)).toBe(bunSha256(bytes))
  })

  test("ignores whitespace and rejects a non-base64 character", () => {
    expect(Array.from(base64ToBytes("Zm9v\nYmFy"))).toEqual(Array.from(enc("foobar")))
    expect(() => base64ToBytes("Zm9v*mFy")).toThrow()
  })
})

describe("sha256OfBase64", () => {
  test("hashes the decoded bytes and reports their length", () => {
    for (const n of [0, 1, 2, 3, 55, 64, 1000, 1024 * 1024 + 7]) {
      const bytes = pattern(n)
      expect(sha256OfBase64(Buffer.from(bytes).toString("base64"))).toEqual({ sha256: bunSha256(bytes), byteLength: n })
    }
  })
})

// red: the sandbox defines no typed arrays and no Buffer; a module that touches one fails to
// even load there ("'Uint32Array' is not defined"), taking every invoicing tool down with it.
describe("sandbox safety", () => {
  test("the backfill modules use no typed array, Buffer or node API", () => {
    for (const f of ["backfill-sha256.ts", "backfill-legacy.ts"]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8").replace(/\/\/.*$/gm, "")
      expect(src).not.toMatch(/\b(?:Uint8|Uint16|Uint32|Int8|Int16|Int32|Float32|Float64|BigInt64|BigUint64)Array\b|\bBuffer\b|\bArrayBuffer\b|from "node:/)
    }
  })
})

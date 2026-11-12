// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hashIdentifier, normalizeEmail, normalizePhone } from "./hash-identifier"

// ─── Known SHA-256 vectors ────────────────────────────────────────────────────
// hashIdentifier("phone", x) hashes x's digits only, so a digit string is a
// plain SHA-256 vector; an email one checks the normalization on top.

describe("hashIdentifier — known SHA-256 vectors", () => {
  it("phone '' hashes as the empty string", async () => {
    expect(await hashIdentifier("phone", "")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })

  it("phone '+1 (555) 123-4567' hashes as '15551234567'", async () => {
    expect(await hashIdentifier("phone", "+1 (555) 123-4567")).toBe(
      createHash("sha256").update("15551234567").digest("hex"),
    )
  })

  it("email ' A@B.com ' hashes as 'a@b.com' (UTF-8, also non-ASCII)", async () => {
    expect(await hashIdentifier("email", " A@B.com ")).toBe(
      createHash("sha256").update("a@b.com").digest("hex"),
    )
    expect(await hashIdentifier("email", "Zoë@Exämple.com")).toBe(
      createHash("sha256").update("zoë@exämple.com", "utf8").digest("hex"),
    )
  })
})

// ─── normalizeEmail ───────────────────────────────────────────────────────────

describe("normalizeEmail", () => {
  it("trims whitespace and lowercases", () => {
    expect(normalizeEmail(" A@B.com ")).toBe("a@b.com")
  })

  it("handles already-lowercase", () => {
    expect(normalizeEmail("user@example.com")).toBe("user@example.com")
  })

  it("handles mixed case", () => {
    expect(normalizeEmail("USER@EXAMPLE.COM")).toBe("user@example.com")
  })
})

// ─── normalizePhone ───────────────────────────────────────────────────────────

describe("normalizePhone", () => {
  // Meta's documented phone normalization is DIGITS-ONLY (country code, no '+',
  // no separators). A leading '+' makes the hash mismatch, so normalizePhone
  // strips the '+' along with every other non-digit.
  it("strips the leading '+' and all separators → digits only", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567")
  })

  it("handles plain digits unchanged", () => {
    expect(normalizePhone("15551234567")).toBe("15551234567")
  })

  it("handles dashes and spaces (no '+' added)", () => {
    expect(normalizePhone("555 123-4567")).toBe("5551234567")
  })

  it("output contains NO '+' (Meta wants digits only)", () => {
    expect(normalizePhone("+33 6 12 34 56 78")).not.toContain("+")
    expect(normalizePhone("+33 6 12 34 56 78")).toBe("33612345678")
  })
})

// ─── hashIdentifier ───────────────────────────────────────────────────────────

describe("hashIdentifier", () => {
  it("email: normalizes then hashes → stable 64-char hex", async () => {
    const h1 = await hashIdentifier("email", " A@B.com ")
    const h2 = await hashIdentifier("email", "a@b.com")
    expect(h1).toBe(h2) // normalization is idempotent
    expect(h1).toHaveLength(64)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("phone: normalizes then hashes → stable 64-char hex", async () => {
    const h1 = await hashIdentifier("phone", "+1 (555) 123-4567")
    const h2 = await hashIdentifier("phone", "15551234567")
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(64)
  })

  it("different identifiers produce different hashes", async () => {
    const h1 = await hashIdentifier("email", "alice@example.com")
    const h2 = await hashIdentifier("email", "bob@example.com")
    expect(h1).not.toBe(h2)
  })
})

// ─── Purity check (build-time static assertion) ───────────────────────────────
//
// NOTE: This is a BUILD-TIME STATIC CHECK — it asserts the source text has no
// forbidden imports. In bun:test, node:crypto IS available globally, so running
// in bun:test alone does NOT prove QuickJS sandbox purity. The REAL runtime
// purity guarantee is Task 11's build-roundtrip test which bundles this file
// and would fail if a forbidden import were present (QuickJS cannot load node:*
// modules). The static check here catches the most common mistake (explicit
// import statement) before it reaches the build.

describe("hash-identifier — purity check (build-time static, not runtime proof)", () => {
  it("hash-identifier.ts has NO import from node:crypto, crypto, or any non-@liaison/app-sdk module", () => {
    const source = readFileSync(join(import.meta.dir, "hash-identifier.ts"), "utf8")
    // Check only import statements (lines starting with 'import'), not comments
    const importLines = source.split("\n").filter((l) => l.trim().startsWith("import "))
    for (const line of importLines) {
      // No import of node:crypto
      expect(line, `forbidden import in hash-identifier.ts: ${line}`).not.toMatch(
        /from ['"]node:crypto['"]/,
      )
      // No import of bare 'crypto'
      expect(line, `forbidden import in hash-identifier.ts: ${line}`).not.toMatch(
        /from ['"]crypto['"]/,
      )
      // Any import must be from @liaison/app-sdk only
      if (!line.includes("@liaison/app-sdk")) {
        throw new Error(
          `hash-identifier.ts contains a forbidden import (only @liaison/app-sdk is allowed in bundled apps): ${line}`,
        )
      }
    }
  })
})

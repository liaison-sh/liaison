// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { hashFolder, normalizeFolderPath } from "./folder-hash"

/** The shell's salt, as this window would read it. */
const SHELL_SALT = "a".repeat(64)
vi.mock("./sidecar-client", () => ({ getInstallSalt: async () => SHELL_SALT }))

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

describe("hashFolder", () => {
  it("answers a 64 hex sha256 of the salted normalized path, never the path", async () => {
    const hash = await hashFolder("/Users/alice/secret-project")
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain("secret-project")
    expect(hash).toBe(await sha256Hex(`${SHELL_SALT}\n/users/alice/secret-project`))
    // The unsalted digest is the one a dictionary of common paths recovers, so
    // it is exactly the value this must NOT be.
    expect(hash).not.toBe(await sha256Hex("/users/alice/secret-project"))
  })

  /**
   * The salt is what stops the server turning a digest back into a path: two
   * installs hashing the same folder must not agree, or a dictionary built on
   * one machine reads every other machine's rows.
   */
  it("gives the same folder a different digest under a different salt", async () => {
    const mine = await hashFolder("/Users/alice/work", "a".repeat(64))
    const theirs = await hashFolder("/Users/alice/work", "b".repeat(64))
    expect(mine).not.toBe(theirs)
    expect(mine).toBe(await hashFolder("/Users/alice/work", "a".repeat(64)))
  })

  it("falls back to the shell's own salt when the caller names none", async () => {
    expect(await hashFolder("/Users/alice/work")).toBe(
      await hashFolder("/Users/alice/work", SHELL_SALT),
    )
  })

  it("treats a trailing separator and a case difference as the same folder", async () => {
    const plain = await hashFolder("/Users/alice/work")
    expect(await hashFolder("/Users/alice/work/")).toBe(plain)
    expect(await hashFolder("/users/ALICE/Work")).toBe(plain)
  })

  it("keeps two different folders apart", async () => {
    expect(await hashFolder("/a/one")).not.toBe(await hashFolder("/a/two"))
  })

  it("never normalizes a root away to the empty string", () => {
    expect(normalizeFolderPath("/")).toBe("/")
    expect(normalizeFolderPath("\\")).toBe("\\")
    // A drive root keeps its drive: only the separator goes.
    expect(normalizeFolderPath("C:\\")).toBe("c:")
  })
})

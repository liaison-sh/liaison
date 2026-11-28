// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The iOS served shell verifies with the keys and floor compiled into it
// (ios/LiaisonShell/Sources/LiaisonShell/PinnedKeys.swift), generated from the
// one source of truth every other client reads, keys.json. A key rotation that
// forgot the phone would leave it refusing every new build, or trusting a
// retired key.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SHELL_BRIDGE_RANGE } from "../web/src/lib/shell-bridge-range"
import { expectedPinnedKeys, KEYS_JSON, PINNED_KEYS_SWIFT } from "./scripts/gen-shell-keys"

const STORE_SWIFT = path.join(
  import.meta.dir,
  "ios/LiaisonShell/Sources/LiaisonShell/ShellStore.swift",
)

describe("iOS served shell pinned keys", () => {
  it("PinnedKeys.swift is keys.json, regenerated", () => {
    expect(readFileSync(PINNED_KEYS_SWIFT, "utf8")).toBe(expectedPinnedKeys())
  })

  it("names every pinned key", () => {
    const keys = JSON.parse(readFileSync(KEYS_JSON, "utf8")) as {
      keys: Array<{ keyId: string; publicKey: string }>
    }
    const swift = readFileSync(PINNED_KEYS_SWIFT, "utf8")
    expect(keys.keys.length).toBeGreaterThan(0)
    for (const key of keys.keys) {
      expect(swift).toContain(`(keyId: "${key.keyId}", publicKey: "${key.publicKey}")`)
    }
  })
})

describe("NATIVE_BRIDGE_VERSION", () => {
  it("is one integer, and the web build this binary bundles accepts it", () => {
    const match = /public let NATIVE_BRIDGE_VERSION = (\d+)\n/.exec(
      readFileSync(STORE_SWIFT, "utf8"),
    )
    expect(match).not.toBeNull()
    const version = Number(match?.[1])
    // The bundled shell is built from the same commit: its iOS range must
    // admit the host it ships in (a caret range on the current major).
    expect(String(SHELL_BRIDGE_RANGE.ios)).toBe(`^${version}`)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The passphrase unlock as the native mobile build runs it: `wraps.ts` bundled
// with `legacy-passphrase-kdf.native.ts` in place of the real legacy module,
// which is what the Vite alias of mode `native` does (apps/web/vite.config.ts).
// Bundled rather than module-mocked, because a mock cannot replace a module
// another test file in the same run already loaded.
//
// A PBKDF2 row opens; a legacy Argon2id row is refused with the typed error
// the UI translates, before any derivation runs; and the bundle holds no
// Argon2id code.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const SRC = import.meta.dir
const userId = "11111111-1111-4111-8111-111111111111"
const salt = () => crypto.getRandomValues(new Uint8Array(16))

let outDir = ""
let bundleText = ""
let wraps: typeof import("./wraps")

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [path.join(SRC, "wraps.ts")],
    target: "browser",
    format: "esm",
    plugins: [
      {
        name: "native-legacy-kdf",
        setup(build) {
          build.onResolve({ filter: /^\.\/legacy-passphrase-kdf$/ }, () => ({
            path: path.join(SRC, "legacy-passphrase-kdf.native.ts"),
          }))
        },
      },
    ],
  })
  if (!result.success) throw new Error(result.logs.join("\n"))
  bundleText = await result.outputs[0].text()
  outDir = mkdtempSync(path.join(tmpdir(), "wraps-native-"))
  const file = path.join(outDir, "wraps.native.mjs")
  writeFileSync(file, bundleText)
  wraps = await import(file)
})

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe("passphrase unlock without the legacy KDF", () => {
  it("bundles no Argon2id code", () => {
    expect(bundleText).not.toMatch(/hash-wasm|argon2/i)
  })

  it("opens a PBKDF2 row", async () => {
    const accountKey = crypto.getRandomValues(new Uint8Array(32))
    const wrap = await wraps.wrapWithPassphrase({
      accountKey: accountKey.slice(),
      passphrase: "pw pw pw",
      salt: salt(),
      userId,
    })
    const back = await wraps.unwrapWithPassphrase({ wrap, passphrase: "pw pw pw", userId })
    expect(Array.from(back)).toEqual(Array.from(accountKey))
  })

  it("refuses a legacy row with the typed error, before any derivation", async () => {
    let called = false
    const wrap = {
      wrapType: "passphrase" as const,
      wrappedAccountKey: new Uint8Array(40),
      kdfParams: { salt: salt() },
    }
    const refusal = await wraps
      .unwrapWithPassphrase({
        wrap,
        passphrase: "pw pw pw",
        userId,
        legacyKdf: async () => {
          called = true
          return new Uint8Array(32)
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(refusal).toBeInstanceOf(wraps.LegacyPassphraseUnavailableError)
    expect(called).toBe(false)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-1: the server seals, it never unseals.
//
// This is a STATIC test: it resolves the transitive import graph of every
// server entrypoint and asserts that graph never reaches a module able to turn
// mail ciphertext back into plaintext. Behavioural tests cannot prove this,
// because the property is about what code EXISTS on the server, not about what
// a particular call does.
//
// It must never be relaxed. If a legitimate-looking change makes it fail, the
// change is wrong, not the test. The negative half is driven by
// `CLIENT_ONLY_MODULES` so a client-only module added later is covered without
// editing this file, and the positive half exists so a graph walk that silently
// resolved nothing fails loudly instead of passing the negative half by
// vacuity.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { CLIENT_ONLY_MODULES } from "@liaison/mailbox-crypto/src/client-only-manifest"

const API_SRC = resolve(import.meta.dir, "../..")
const REPO_ROOT = resolve(API_SRC, "../../..")
const PACKAGES = join(REPO_ROOT, "packages")

/** Every file that boots a server process. The e2e entry is in the list even
 *  though it is a harness: it links the same app, so a client-only module that
 *  reached the server only through its graph would still exist on a running
 *  server. */
const ENTRYPOINTS = [join(API_SRC, "index.ts"), join(API_SRC, "../test-support/index.e2e.ts")]

/**
 * Specifiers `apps/api` is allowed to use for the crypto package. The package
 * ROOT is deliberately absent: a future root re-export would otherwise pull the
 * open primitives into the server without a single line of `apps/api` changing.
 */
const ALLOWED_CRYPTO_SPECIFIERS = new Set([
  "@liaison/mailbox-crypto/src/aad",
  "@liaison/mailbox-crypto/src/ack",
  "@liaison/mailbox-crypto/src/blob",
  "@liaison/mailbox-crypto/src/bytes",
  "@liaison/mailbox-crypto/src/client-only-manifest",
  "@liaison/mailbox-crypto/src/field-seal",
  "@liaison/mailbox-crypto/src/field-verify",
  "@liaison/mailbox-crypto/src/kdf",
  "@liaison/mailbox-crypto/src/keyring-attestation",
  "@liaison/mailbox-crypto/src/seal",
  "@liaison/mailbox-crypto/src/stream-seal",
])

/**
 * Symbols that can only exist in code capable of opening sealed mail, or of
 * unwrapping the key material that opens it.
 *
 * Every name except the WebCrypto call is a REAL export of a `CLIENT_ONLY_MODULES`
 * file, and the test below proves it: the list once carried `openStream`, which
 * is not an export of anything, so the attachment-stream half of this grep was
 * vacuous and an `apps/api` file could have named `decryptAttachmentStream`
 * without failing here.
 */
const FORBIDDEN_SYMBOLS = [
  "unsealContentKey",
  "openField",
  "decryptAttachmentChunks",
  "decryptAttachmentStream",
  "unwrapIdentityKey",
  "unwrapWithPrfSecret",
  "unwrapWithRecoveryPhrase",
  "unwrapWithPassphrase",
  "crypto.subtle.unwrapKey",
]

/** The one entry that names a platform API rather than a package export. */
const NON_EXPORT_FORBIDDEN_SYMBOLS = new Set(["crypto.subtle.unwrapKey"])

const IMPORT_RE =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g

function readSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8")
  const found: string[] = []
  for (const m of source.matchAll(IMPORT_RE)) found.push(m[1] as string)
  for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) found.push(m[1] as string)
  return found
}

function resolveFile(candidate: string): string | null {
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const path = candidate + suffix
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return null
}

function packageEntry(pkg: string): string | null {
  const pkgJson = join(PACKAGES, pkg, "package.json")
  if (!existsSync(pkgJson)) return null
  const main = JSON.parse(readFileSync(pkgJson, "utf8")).main as string | undefined
  if (!main) return null
  return resolveFile(join(PACKAGES, pkg, main))
}

/** Returns the absolute file a specifier resolves to, or null for anything
 *  outside the workspace (npm dependencies, node builtins). */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("~/")) return resolveFile(join(API_SRC, specifier.slice(2)))
  if (specifier.startsWith(".")) return resolveFile(resolve(dirname(fromFile), specifier))
  if (specifier.startsWith("@liaison/")) {
    const rest = specifier.slice("@liaison/".length)
    const slash = rest.indexOf("/")
    const pkg = slash === -1 ? rest : rest.slice(0, slash)
    if (slash === -1) return packageEntry(pkg)
    return resolveFile(join(PACKAGES, pkg, rest.slice(slash + 1)))
  }
  return null
}

function resolveGraph(entrypoints: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...entrypoints]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of readSpecifiers(file)) {
      const target = resolveSpecifier(specifier, file)
      if (target) queue.push(target)
    }
  }
  return seen
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      walkTsFiles(path, out)
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(path)
    }
  }
  return out
}

const graph = resolveGraph(ENTRYPOINTS)
const apiFiles = walkTsFiles(API_SRC)
const apiSourceFiles = apiFiles.filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))

describe("T-SEC-1: the server can seal mail and cannot open it", () => {
  test("the resolved server import graph is real and does reach the seal path", () => {
    // Non-vacuity. A walker that resolved nothing would satisfy every negative
    // assertion below, so prove the graph is a real one first.
    expect(graph.size).toBeGreaterThan(200)
    expect(graph).toContain(join(API_SRC, "modules/mailbox-crypto/seal-service.ts"))
    expect(graph).toContain(join(PACKAGES, "mailbox-crypto/src/field-seal.ts"))
  })

  test("the server import graph reaches no client-only crypto module", () => {
    expect(CLIENT_ONLY_MODULES.length).toBeGreaterThan(0)
    for (const name of CLIENT_ONLY_MODULES) {
      const path = join(PACKAGES, "mailbox-crypto/src", name)
      // A rename that emptied the manifest of meaning must fail here.
      expect(existsSync(path)).toBe(true)
      expect(graph.has(path)).toBe(false)
    }
  })

  test("no apps/api file imports the mailbox-crypto package root", () => {
    expect(apiSourceFiles.length).toBeGreaterThan(200)
    const offenders: string[] = []
    for (const file of apiSourceFiles) {
      for (const specifier of readSpecifiers(file)) {
        if (!specifier.startsWith("@liaison/mailbox-crypto")) continue
        if (!ALLOWED_CRYPTO_SPECIFIERS.has(specifier)) {
          offenders.push(`${file}: ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("no apps/api source file names an unseal primitive", () => {
    const offenders: string[] = []
    for (const file of apiSourceFiles) {
      const source = readFileSync(file, "utf8")
      for (const symbol of FORBIDDEN_SYMBOLS) {
        if (source.includes(symbol)) offenders.push(`${file}: ${symbol}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("every forbidden symbol is a real export of a client-only module", () => {
    // Without this, a renamed primitive silently drops out of the grep above and
    // the assertion keeps passing against a name nothing declares any more.
    const exported = new Set<string>()
    for (const name of CLIENT_ONLY_MODULES) {
      const source = readFileSync(join(PACKAGES, "mailbox-crypto/src", name), "utf8")
      for (const m of source.matchAll(
        /^export\s+(?:async\s+)?(?:function\*?|const|class)\s+([A-Za-z0-9_]+)/gm,
      )) {
        exported.add(m[1] as string)
      }
    }
    const stale = FORBIDDEN_SYMBOLS.filter(
      (symbol) => !NON_EXPORT_FORBIDDEN_SYMBOLS.has(symbol) && !exported.has(symbol),
    )
    expect(stale).toEqual([])
  })

  test("the sandbox bridge exposes no unseal-shaped method", async () => {
    // rpc-bridge.ts composes the per-capability factories in sandbox/bridge/.
    const bridgeDir = join(API_SRC, "modules/apps/sandbox/bridge")
    const bridgeSource = [
      join(API_SRC, "modules/apps/sandbox/rpc-bridge.ts"),
      ...readdirSync(bridgeDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(bridgeDir, name)),
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    expect(bridgeSource.length).toBeGreaterThan(0)
    const forbidden = bridgeSource.match(/\bmailbox_(unseal|open|requestPlaintext|decrypt)\w*/g)
    expect(forbidden).toBeNull()
  })
})

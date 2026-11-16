// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signing module stays apart from every other piece of crypto in the
// product: it imports no mailbox, key or at-rest encryption code, uses only
// hashes and randomness from node:crypto (signature and chain checks are the
// pkijs library's), and no change to it ever edits an existing crypto file.
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const API_SRC = path.resolve(import.meta.dir, "../..")
const REPO = path.resolve(API_SRC, "../../..")
const SIGNING = import.meta.dir
const BRIDGE = path.join(API_SRC, "modules/apps/sandbox/bridge/signing.ts")

function productFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === "test-fixtures") continue
      out.push(...productFiles(p))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p)
  }
  return out
}

/** Code paths that hold encryption, keys or key derivation: never imported from signing. */
const FORBIDDEN_IMPORTS = [
  /mailbox-crypto/,
  /mailbox-keys/,
  /mailbox-jobs/,
  /~\/lib\/crypto["']/,
  /lib\/crypto["']/,
  /argon2/,
  /modules\/files\/.*encrypt/,
  /storage-encryption/,
]

/** node:crypto members a hand-rolled primitive would need. Only hashes and randomness are used. */
const FORBIDDEN_NODE_CRYPTO =
  /\b(createCipheriv|createDecipheriv|createHmac|pbkdf2|pbkdf2Sync|scrypt|scryptSync|hkdf|hkdfSync|generateKeyPair|generateKeyPairSync|createSign|createVerify|privateEncrypt|publicDecrypt|publicEncrypt|privateDecrypt|diffieHellman|createECDH)\b/

/** Files a change to the signing module must never touch (D236: owner review only). */
const PROTECTED_PATHS = [
  "apps/api/src/lib/crypto.ts",
  "apps/api/src/modules/mailbox-crypto/",
  "apps/api/src/modules/mailbox-keys/",
  "packages/mailbox-crypto/",
]

describe("signing module scope", () => {
  it("the signing module imports no mailbox or at-rest crypto and edits no existing primitive", () => {
    const files = [...productFiles(SIGNING), BRIDGE]
    expect(files.length).toBeGreaterThanOrEqual(6)
    const findings: string[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      const imports = [...text.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => m[0])
      for (const line of imports) {
        for (const re of FORBIDDEN_IMPORTS) {
          if (re.test(line))
            findings.push(`${path.relative(REPO, file)}: ${line.replace(/\s+/g, " ")}`)
        }
      }
      if (FORBIDDEN_NODE_CRYPTO.test(text)) {
        findings.push(
          `${path.relative(REPO, file)}: uses ${text.match(FORBIDDEN_NODE_CRYPTO)?.[0]}`,
        )
      }
    }
    expect(findings).toEqual([])

    // Every commit that touched the signing module touched no protected crypto file.
    const log = spawnSync(
      "git",
      [
        "log",
        "--format=%H",
        "--",
        "apps/api/src/modules/signing",
        "apps/api/src/modules/apps/sandbox/bridge/signing.ts",
      ],
      { cwd: REPO, encoding: "utf8" },
    )
    if (log.status !== 0) return // no history here (an archive): the import scan above still ran
    const touched: string[] = []
    for (const sha of log.stdout.split("\n").filter(Boolean)) {
      const show = spawnSync("git", ["show", "--name-only", "--format=", sha], {
        cwd: REPO,
        encoding: "utf8",
      })
      for (const f of show.stdout.split("\n").filter(Boolean)) {
        if (PROTECTED_PATHS.some((p) => f === p || f.startsWith(p))) touched.push(`${sha}: ${f}`)
      }
    }
    expect(touched).toEqual([])
  })

  it("the guard's own scan sees a forbidden primitive", () => {
    expect(FORBIDDEN_NODE_CRYPTO.test("const h = createHmac('sha256', key)")).toBe(true)
    expect(FORBIDDEN_NODE_CRYPTO.test("createHash('sha256')")).toBe(false)
    expect(FORBIDDEN_IMPORTS.some((re) => re.test('import { x } from "~/lib/crypto"'))).toBe(true)
  })
})

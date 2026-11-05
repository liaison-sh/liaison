// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sha256Hex, utf8 } from "./encoding"
import { APP_SIGNING_KEYS } from "./keys"
import pinned from "./keys.json"
import { type AppStatement, canonicalJson, parseStatement, statementBytes } from "./statement"
import { createTestSigningKey } from "./testing"
import { checkArtifact, singleFileBundleProblems, verifyArtifact, verifyStatement } from "./verify"

const UI = utf8.encode('import { createSignal as a } from "solid-js";\nexport const x = a(1);\n')
const MANIFEST = utf8.encode(JSON.stringify({ name: "boxtal", version: "1.2.3", host: "^1" }))
const PACKAGE = utf8.encode("tarball bytes")

async function statementFor(
  keyId: string,
  over: Partial<AppStatement> = {},
): Promise<AppStatement> {
  return {
    v: 1,
    keyId,
    name: "boxtal",
    version: "1.2.3",
    hostApi: "^1",
    sha256: {
      ui: await sha256Hex(UI),
      manifest: await sha256Hex(MANIFEST),
      package: await sha256Hex(PACKAGE),
    },
    sourceDigest: "a".repeat(64),
    issuedAt: "2026-10-26T00:00:00.000Z",
    ...over,
  }
}

describe("canonical statement bytes", () => {
  it("sorts keys at every depth and drops whitespace, whatever the input order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}',
    )
  })

  it("is stable: the same statement always yields the same bytes", async () => {
    const s = await statementFor("k")
    const { v, ...rest } = s
    const shuffled: AppStatement = { ...rest, v }
    expect(utf8.decode(statementBytes(s))).toBe(utf8.decode(statementBytes(shuffled)))
    expect(utf8.decode(statementBytes(s)).includes(" ")).toBe(false)
  })

  it("parses only the exact statement shape", async () => {
    const s = await statementFor("k")
    expect(parseStatement(statementBytes(s))).toEqual(s)
    expect(parseStatement(utf8.encode(JSON.stringify({ ...s, extra: 1 })))).toBeNull()
    expect(parseStatement(utf8.encode(JSON.stringify({ ...s, v: 2 })))).toBeNull()
    expect(parseStatement(utf8.encode(JSON.stringify({ ...s, sha256: { ui: "x" } })))).toBeNull()
    expect(parseStatement(utf8.encode("not json"))).toBeNull()
  })
})

describe("verifyStatement", () => {
  it("accepts a good signature from a pinned key", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = statementBytes(await statementFor("test-1"))
    const result = await verifyStatement(bytes, await key.sign(bytes), [key.key])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.statement.name).toBe("boxtal")
  })

  it("accepts a statement signed by any key of the list (rotation)", async () => {
    const old = await createTestSigningKey("test-old")
    const next = await createTestSigningKey("test-new")
    const bytes = statementBytes(await statementFor("test-new"))
    const result = await verifyStatement(bytes, await next.sign(bytes), [old.key, next.key])
    expect(result.ok).toBe(true)
  })

  it("refuses a correct signature from a key that is not pinned", async () => {
    const pinned = await createTestSigningKey("test-1")
    const other = await createTestSigningKey("test-1")
    const bytes = statementBytes(await statementFor("test-1"))
    const result = await verifyStatement(bytes, await other.sign(bytes), [pinned.key])
    expect(result).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("refuses a statement naming a key id the list does not have", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = statementBytes(await statementFor("test-2"))
    const result = await verifyStatement(bytes, await key.sign(bytes), [key.key])
    expect(result).toEqual({ ok: false, reason: "unknown_key" })
  })

  it("refuses a statement altered after signing", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = statementBytes(await statementFor("test-1"))
    const sig = await key.sign(bytes)
    const altered = statementBytes(await statementFor("test-1", { version: "9.9.9" }))
    expect(await verifyStatement(altered, sig, [key.key])).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it("refuses non-canonical statement bytes even with a valid signature over them", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = utf8.encode(JSON.stringify(await statementFor("test-1"), null, 2))
    expect(await verifyStatement(bytes, await key.sign(bytes), [key.key])).toEqual({
      ok: false,
      reason: "malformed_statement",
    })
  })

  it("fails closed on an empty key list", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = statementBytes(await statementFor("test-1"))
    expect(await verifyStatement(bytes, await key.sign(bytes), [])).toEqual({
      ok: false,
      reason: "no_keys",
    })
  })

  it("the production key list is exactly the pinned keys, each a raw 32-byte Ed25519 key", () => {
    expect(APP_SIGNING_KEYS).toEqual(pinned.keys)
    expect(APP_SIGNING_KEYS.length).toBeGreaterThan(0)
    expect(new Set(APP_SIGNING_KEYS.map((k) => k.keyId)).size).toBe(APP_SIGNING_KEYS.length)
    for (const k of APP_SIGNING_KEYS) {
      expect(Buffer.from(k.publicKey, "base64").length).toBe(32)
    }
  })

  it("the production key list refuses a statement signed by an unpinned key", async () => {
    // An unknown keyId: no pinned key to check it against.
    const stranger = await createTestSigningKey("test-unpinned")
    const bytes = statementBytes(await statementFor("test-unpinned"))
    expect(await verifyStatement(bytes, await stranger.sign(bytes), APP_SIGNING_KEYS)).toEqual({
      ok: false,
      reason: "unknown_key",
    })
    // A pinned keyId, but signed by a key that is not the pinned one.
    const pinnedId = APP_SIGNING_KEYS[0]?.keyId ?? ""
    const impostor = await createTestSigningKey(pinnedId)
    const forged = statementBytes(await statementFor(pinnedId))
    expect(await verifyStatement(forged, await impostor.sign(forged), APP_SIGNING_KEYS)).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it("refuses a garbled signature", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = statementBytes(await statementFor("test-1"))
    expect((await verifyStatement(bytes, "not base64!", [key.key])).ok).toBe(false)
    expect((await verifyStatement(bytes, "AAAA", [key.key])).ok).toBe(false)
  })
})

describe("checkArtifact", () => {
  const files = { name: "boxtal", version: "1.2.3", uiBytes: UI, manifestBytes: MANIFEST }

  it("accepts files that match the statement", async () => {
    expect(await checkArtifact(await statementFor("k"), files)).toEqual([])
    expect(
      await checkArtifact(await statementFor("k"), { ...files, packageBytes: PACKAGE }),
    ).toEqual([])
  })

  it("refuses a ui.js with one byte changed", async () => {
    const tampered = new Uint8Array(UI)
    tampered[5] ^= 1
    const problems = await checkArtifact(await statementFor("k"), { ...files, uiBytes: tampered })
    expect(problems).toContain("ui_hash")
  })

  it("refuses a changed manifest or package", async () => {
    const s = await statementFor("k")
    const manifest = utf8.encode(JSON.stringify({ name: "boxtal", version: "1.2.3", host: "^2" }))
    expect(await checkArtifact(s, { ...files, manifestBytes: manifest })).toContain("manifest_hash")
    expect(await checkArtifact(s, { ...files, packageBytes: utf8.encode("x") })).toContain(
      "package_hash",
    )
  })

  it("refuses a statement for another app or another version (swap)", async () => {
    const s = await statementFor("k")
    expect(await checkArtifact(s, { ...files, name: "invoicing" })).toContain("name")
    expect(await checkArtifact(s, { ...files, version: "1.2.4" })).toContain("version")
  })

  it("refuses a manifest whose name, version or host API disagree with the statement", async () => {
    const manifest = utf8.encode(JSON.stringify({ name: "other", version: "1.2.3", host: "^1" }))
    const s = await statementFor("k", {
      sha256: {
        ui: await sha256Hex(UI),
        manifest: await sha256Hex(manifest),
        package: await sha256Hex(PACKAGE),
      },
    })
    expect(await checkArtifact(s, { ...files, manifestBytes: manifest })).toContain(
      "manifest_identity",
    )
  })

  it("refuses a bundle that is not a single file", async () => {
    const ui = utf8.encode('import x from "./chunk.js";\nexport default x\n')
    const s = await statementFor("k", {
      sha256: {
        ui: await sha256Hex(ui),
        manifest: await sha256Hex(MANIFEST),
        package: await sha256Hex(PACKAGE),
      },
    })
    expect(await checkArtifact(s, { ...files, uiBytes: ui })).toContain("not_single_file")
  })
})

describe("verifyArtifact (statement + files)", () => {
  it("accepts the good artifact and names the failure otherwise", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = statementBytes(await statementFor("test-1"))
    const sig = await key.sign(bytes)
    const files = { name: "boxtal", version: "1.2.3", uiBytes: UI, manifestBytes: MANIFEST }
    expect((await verifyArtifact(bytes, sig, files, { keys: [key.key] })).ok).toBe(true)
    const swapped = await verifyArtifact(
      bytes,
      sig,
      { ...files, name: "shopify" },
      {
        keys: [key.key],
      },
    )
    expect(swapped).toMatchObject({ ok: false, reason: "artifact_mismatch", problems: ["name"] })
  })
})

describe("singleFileBundleProblems (A8)", () => {
  it("accepts bare imports from the host import map", () => {
    expect(
      singleFileBundleProblems(
        'import { a } from "solid-js";\nimport * as w from "solid-js/web";\nimport { s } from "solid-js/store";\nexport { a, w, s };',
      ),
    ).toEqual([])
  })

  it("ignores import-like words inside strings", () => {
    expect(
      singleFileBundleProblems(
        'import { a } from "solid-js";\nthrow new Error(\n  "set at boot before any plugin dynamic-import"\n);',
      ),
    ).toEqual([])
  })

  it("refuses dynamic import, relative specifiers, import.meta, CSS and unknown bare imports", () => {
    expect(singleFileBundleProblems('const m = import("./x.js")')).not.toEqual([])
    expect(singleFileBundleProblems('import "./side.js"')).not.toEqual([])
    expect(singleFileBundleProblems('export { a } from "../a.js"')).not.toEqual([])
    expect(singleFileBundleProblems("const u = new URL('a.png', import.meta.url)")).not.toEqual([])
    expect(singleFileBundleProblems('import "./app.css"')).not.toEqual([])
    expect(singleFileBundleProblems('import x from "lodash"')).not.toEqual([])
    expect(singleFileBundleProblems('import x from "https://cdn.example/x.js"')).not.toEqual([])
  })
})

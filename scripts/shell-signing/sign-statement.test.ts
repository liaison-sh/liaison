// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signer takes two builders' manifests and signs only when they agree, and
// the verifier checks what the downloads host publishes. Throwaway keys only.
import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { utf8 } from "../../packages/shared/src/app-signing/encoding"
import { revocationBytes } from "../../packages/shared/src/app-signing/revocations"
import {
  parseShellStatement,
  verifyShellStatement,
} from "../../packages/shared/src/app-signing/shell-statement"
import { canonicalJson } from "../../packages/shared/src/app-signing/statement"
import {
  createTestSigningKey,
  type TestSigningKey,
} from "../../packages/shared/src/app-signing/testing"
import { keyIdFor } from "../app-signing/sign-artifact"
import {
  manifestFileName,
  parseShellManifest,
  RESULT_FILE,
  type ShellManifest,
  signShellManifests,
} from "./sign-statement"
import { verifyPublishedShell } from "./verify-statement"

const COMMIT = "c".repeat(40)
const SEQ = 1_764_300_000
const VERSION = "nightly-20261128"
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shell-sign-"))
  dirs.push(d)
  return d
}

function manifest(mode: "desktop" | "native", over: Partial<ShellManifest> = {}): ShellManifest {
  return {
    mode,
    buildId: mode === "desktop" ? "0123456789abcdef" : "fedcba9876543210",
    commit: COMMIT,
    seq: SEQ,
    liaisonVersion: "nightly-20261128",
    bridge: { desktop: "^1", ios: "^1", android: "^1" },
    settingsSchema: 1,
    files: { "index.html": "a".repeat(64), "build-id.txt": "b".repeat(64) },
    ...over,
  }
}

function builderDir(over: Partial<Record<"desktop" | "native", Partial<ShellManifest>>> = {}) {
  const d = tmp()
  for (const mode of ["desktop", "native"] as const) {
    writeFileSync(join(d, manifestFileName(mode)), canonicalJson(manifest(mode, over[mode])))
  }
  return d
}

async function keyFile(): Promise<{ path: string; signer: TestSigningKey; keyId: string }> {
  const signer = await createTestSigningKey()
  const path = join(tmp(), "key.pem")
  writeFileSync(path, await signer.privatePem())
  return { path, signer, keyId: await keyIdFor(signer.key.publicKey) }
}

describe("parseShellManifest", () => {
  it("takes exactly a manifest", () => {
    expect(parseShellManifest(canonicalJson(manifest("desktop")))).toEqual(manifest("desktop"))
    expect(parseShellManifest(JSON.stringify({ ...manifest("desktop"), keyId: "x" }))).toBeNull()
    expect(parseShellManifest(JSON.stringify({ ...manifest("desktop"), extra: 1 }))).toBeNull()
    expect(parseShellManifest("{")).toBeNull()
  })
})

describe("signShellManifests", () => {
  it("signs both modes when the two builders agree, and the output verifies", async () => {
    const { path, keyId } = await keyFile()
    const out = tmp()
    const { signed, refused } = await signShellManifests({
      a: builderDir(),
      b: builderDir(),
      commit: COMMIT,
      seq: SEQ,
      liaisonVersion: VERSION,
      keyPath: path,
      out,
      issuedAt: "2026-11-28T00:00:00.000Z",
    })
    expect(refused).toEqual({})
    expect(signed.map((s) => `${s.mode}/${s.buildId}`)).toEqual([
      "desktop/0123456789abcdef",
      "native/fedcba9876543210",
    ])
    const dir = join(out, "desktop", "0123456789abcdef")
    const bytes = new Uint8Array(readFileSync(join(dir, "statement.json")))
    const statement = parseShellStatement(bytes)
    expect(statement?.keyId).toBe(keyId)
    expect(statement?.files).toEqual(manifest("desktop").files)
    expect(utf8.decode(bytes)).toBe(canonicalJson(statement))
  })

  it("refuses a mode whose two builds differ, naming the file, and still signs the other", async () => {
    const { path } = await keyFile()
    const b = builderDir({
      native: { files: { "index.html": "a".repeat(64), "build-id.txt": "e".repeat(64) } },
    })
    const out = tmp()
    const r = await signShellManifests({
      a: builderDir(),
      b,
      commit: COMMIT,
      seq: SEQ,
      liaisonVersion: VERSION,
      keyPath: path,
      out,
    })
    expect(r.refused.native).toMatch(/native: the two builds differ.*build-id\.txt/)
    expect(r.signed.map((s) => s.mode)).toEqual(["desktop"])
    expect(existsSync(join(out, "native"))).toBe(false)
    expect(JSON.parse(readFileSync(join(out, RESULT_FILE), "utf8"))).toEqual({
      refused: r.refused,
      signed: ["desktop/0123456789abcdef"],
      skipped: [],
    })
  })

  it("refuses manifests of another commit, seq or release name than the signer computed", async () => {
    const { path } = await keyFile()
    const base = {
      a: builderDir(),
      b: builderDir(),
      keyPath: path,
      out: tmp(),
      commit: COMMIT,
      seq: SEQ,
      liaisonVersion: VERSION,
    }
    const refusal = async (over: Partial<typeof base>) =>
      (await signShellManifests({ ...base, ...over })).refused.desktop
    expect(await refusal({ commit: "d".repeat(40) })).toMatch(/built from/)
    expect(await refusal({ seq: SEQ + 1 })).toMatch(/seq/)
    expect(await refusal({ liaisonVersion: "nightly-20261129" })).toMatch(/release/)
  })

  it("refuses a manifest file that is not one", async () => {
    const { path } = await keyFile()
    const a = builderDir()
    writeFileSync(join(a, manifestFileName("desktop")), JSON.stringify({ mode: "desktop" }))
    const r = await signShellManifests({
      a,
      b: builderDir(),
      commit: COMMIT,
      seq: SEQ,
      liaisonVersion: VERSION,
      keyPath: path,
      out: tmp(),
    })
    expect(r.refused.desktop).toMatch(/builder A desktop: not a shell manifest/)
    expect(r.signed.map((s) => s.mode)).toEqual(["native"])
  })
})

describe("what the host already holds", () => {
  const ID = "0123456789abcdef"
  async function first(issuedAt = "2026-11-28T00:00:00.000Z") {
    const { path } = await keyFile()
    const out = tmp()
    const input = {
      a: builderDir(),
      b: builderDir(),
      commit: COMMIT,
      seq: SEQ,
      liaisonVersion: VERSION,
      keyPath: path,
      issuedAt,
    }
    await signShellManifests({ ...input, out })
    return { input, out }
  }
  function hostWith(
    from: string,
    files: Array<"statement.json" | "statement.sig">,
    mode = "desktop",
  ) {
    const existing = tmp()
    const dir = join(existing, mode, ID)
    mkdirSync(dir, { recursive: true })
    for (const f of files) writeFileSync(join(dir, f), readFileSync(join(from, mode, ID, f)))
    return existing
  }

  it("skips a mode whose statement is already signed, and signs the other", async () => {
    // A nightly that changed only the phone build: the desktop build id is the
    // one already published (by an earlier commit), so desktop is skipped.
    const { input, out } = await first()
    const existing = hostWith(out, ["statement.json", "statement.sig"])
    const r = await signShellManifests({
      ...input,
      commit: "e".repeat(40),
      a: builderDir({ desktop: { commit: "e".repeat(40) }, native: { commit: "e".repeat(40) } }),
      b: builderDir({ desktop: { commit: "e".repeat(40) }, native: { commit: "e".repeat(40) } }),
      out: tmp(),
      existing,
    })
    expect(r.skipped).toEqual([{ mode: "desktop", buildId: ID }])
    expect(r.signed.map((s) => s.mode)).toEqual(["native"])
    expect(r.refused).toEqual({})
  })

  it("completes a pair cut after statement.json: signs the host's bytes, not a fresh issuedAt", async () => {
    const { input, out } = await first("2026-11-28T00:00:00.000Z")
    const existing = hostWith(out, ["statement.json"])
    const retry = tmp()
    const r = await signShellManifests({
      ...input,
      issuedAt: "2026-11-29T12:00:00.000Z",
      out: retry,
      existing,
    })
    expect(r.refused).toEqual({})
    const desktop = r.signed.find((s) => s.mode === "desktop")
    expect(desktop?.resigned).toBe(true)
    expect(readFileSync(join(retry, "desktop", ID, "statement.json"))).toEqual(
      readFileSync(join(out, "desktop", ID, "statement.json")),
    )
    // Ed25519 is deterministic: the completed pair is exactly the first one.
    expect(readFileSync(join(retry, "desktop", ID, "statement.sig"), "utf8")).toBe(
      readFileSync(join(out, "desktop", ID, "statement.sig"), "utf8"),
    )
    expect(r.signed.find((s) => s.mode === "native")?.resigned).toBe(false)
  })

  it("never signs an unsigned statement.json that says something else", async () => {
    const { input, out } = await first()
    const existing = hostWith(out, ["statement.json"])
    const path = join(existing, "desktop", ID, "statement.json")
    const forged = JSON.parse(readFileSync(path, "utf8"))
    // A higher seq would sit above every future floor: never signed.
    writeFileSync(path, canonicalJson({ ...forged, seq: 9_999_999_999 }))
    const r = await signShellManifests({ ...input, out: tmp(), existing })
    expect(r.refused.desktop).toMatch(/says something else/)
    expect(r.signed.map((s) => s.mode)).toEqual(["native"])
    writeFileSync(path, `${canonicalJson(forged)} `)
    expect((await signShellManifests({ ...input, out: tmp(), existing })).refused.desktop).toMatch(
      /not a shell statement/,
    )
  })
})

describe("verifyPublishedShell", () => {
  async function published() {
    const { path, signer, keyId } = await keyFile()
    const out = tmp()
    await signShellManifests({
      a: builderDir(),
      b: builderDir(),
      commit: COMMIT,
      seq: SEQ,
      liaisonVersion: VERSION,
      keyPath: path,
      out,
    })
    const host = new Map<string, Uint8Array>()
    for (const mode of ["desktop", "native"] as const) {
      const id = manifest(mode).buildId
      for (const f of ["statement.json", "statement.sig"]) {
        host.set(`/shell/${mode}/${id}/${f}`, new Uint8Array(readFileSync(join(out, mode, id, f))))
      }
    }
    const fakeFetch = (async (url: string | URL | Request) => {
      const body = host.get(new URL(String(url)).pathname)
      return body ? new Response(body) : new Response("no", { status: 404 })
    }) as typeof fetch
    const keys = [{ keyId, publicKey: signer.key.publicKey }]
    return { host, fakeFetch, keys, signer }
  }

  it("ok for a published statement; refused once a byte of it is flipped", async () => {
    const { host, fakeFetch, keys } = await published()
    const input = {
      mode: "desktop" as const,
      buildId: "0123456789abcdef",
      base: "https://dl.test",
      keys,
      fetch: fakeFetch,
    }
    expect(await verifyPublishedShell(input)).toBe("ok")
    const path = "/shell/desktop/0123456789abcdef/statement.json"
    const text = utf8.decode(host.get(path) ?? new Uint8Array())
    host.set(path, utf8.encode(text.replace('"index.html":"a', '"index.html":"f')))
    expect(await verifyPublishedShell(input)).toBe("bad_signature")
  })

  it("names a missing statement, another build's statement, and a revoked one", async () => {
    const { host, fakeFetch, keys, signer } = await published()
    const base = { base: "https://dl.test", keys, fetch: fakeFetch }
    expect(
      await verifyPublishedShell({ ...base, mode: "desktop", buildId: "1111111111111111" }),
    ).toBe("not published")
    // The native statement served under a desktop path.
    for (const f of ["statement.json", "statement.sig"]) {
      host.set(
        `/shell/desktop/fedcba9876543210/${f}`,
        host.get(`/shell/native/fedcba9876543210/${f}`) as Uint8Array,
      )
    }
    expect(
      await verifyPublishedShell({ ...base, mode: "desktop", buildId: "fedcba9876543210" }),
    ).toBe("wrong_build")
    // A signed revocation list with a desktop floor above the statement's seq.
    const list = revocationBytes({
      v: 1,
      seq: 2,
      issuedAt: "2026-11-28T00:00:00.000Z",
      entries: [{ name: "shell:desktop", below: String(SEQ + 1) }],
    })
    host.set("/apps/revocations.json", list)
    host.set("/apps/revocations.json.sig", utf8.encode(await signer.sign(list)))
    expect(
      await verifyPublishedShell({ ...base, mode: "desktop", buildId: "0123456789abcdef" }),
    ).toBe("revoked")
    expect(
      await verifyPublishedShell({ ...base, mode: "native", buildId: "fedcba9876543210" }),
    ).toBe("ok")
  })
})

// The signer's own module set stays small: it runs where the key is, from a
// sparse checkout, so it must not reach the web app or any dependency.
describe("signer imports", () => {
  it("imports only the signing code", () => {
    const src = readFileSync(join(import.meta.dir, "sign-statement.ts"), "utf8")
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])
    for (const spec of imports) {
      expect(spec).toMatch(
        /^(node:|\.\.\/\.\.\/packages\/shared\/src\/app-signing\/|\.\.\/app-signing\/sign-artifact$)/,
      )
    }
  })

  it("verifyShellStatement accepts what it signs (sanity of the shared verifier)", async () => {
    const signer = await createTestSigningKey("k")
    const bytes = utf8.encode(
      canonicalJson({ v: 1, kind: "shell", keyId: "k", issuedAt: "x", ...manifest("desktop") }),
    )
    expect(
      (await verifyShellStatement(bytes, await signer.sign(bytes), [signer.key], { list: null }))
        .ok,
    ).toBe(true)
  })
})

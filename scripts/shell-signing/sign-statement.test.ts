// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signer takes two builders' manifests and signs only when they agree, and
// the verifier checks what the downloads host publishes. Throwaway keys only.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  type ShellManifest,
  signShellManifests,
} from "./sign-statement"
import { verifyPublishedShell } from "./verify-statement"

const COMMIT = "c".repeat(40)
const SEQ = 1_764_300_000
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
    const signed = await signShellManifests({
      a: builderDir(),
      b: builderDir(),
      commit: COMMIT,
      seq: SEQ,
      keyPath: path,
      out,
      issuedAt: "2026-11-28T00:00:00.000Z",
    })
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

  it("refuses when one file differs between the builds, naming it", async () => {
    const { path } = await keyFile()
    const b = builderDir({
      native: { files: { "index.html": "a".repeat(64), "build-id.txt": "e".repeat(64) } },
    })
    await expect(
      signShellManifests({
        a: builderDir(),
        b,
        commit: COMMIT,
        seq: SEQ,
        keyPath: path,
        out: tmp(),
      }),
    ).rejects.toThrow(/native: the two builds differ.*build-id\.txt/)
  })

  it("refuses manifests of another commit or seq than the forge says", async () => {
    const { path } = await keyFile()
    const base = { a: builderDir(), b: builderDir(), keyPath: path, out: tmp() }
    await expect(signShellManifests({ ...base, commit: "d".repeat(40), seq: SEQ })).rejects.toThrow(
      /built from/,
    )
    await expect(signShellManifests({ ...base, commit: COMMIT, seq: SEQ + 1 })).rejects.toThrow(
      /seq/,
    )
  })

  it("refuses a manifest file that is not one", async () => {
    const { path } = await keyFile()
    const a = builderDir()
    writeFileSync(join(a, manifestFileName("desktop")), JSON.stringify({ mode: "desktop" }))
    await expect(
      signShellManifests({
        a,
        b: builderDir(),
        commit: COMMIT,
        seq: SEQ,
        keyPath: path,
        out: tmp(),
      }),
    ).rejects.toThrow(/builder A desktop: not a shell manifest/)
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
    ).toBe("statement is for native")
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

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestSigningKey } from "../../packages/shared/src/app-signing/testing"
import { verifyArtifact } from "../../packages/shared/src/app-signing/verify"
import { keyIdFor, signArtifactDir } from "./sign-artifact"
import { sourceDigest } from "./source-digest"

const UI = 'import { createSignal as a } from "solid-js";\nexport const x = a(1);\n'
const MANIFEST = JSON.stringify({ name: "demoapp", version: "1.0.0", host: "^1" })

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "app-sign-"))
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

/** A built artifact dir holding only `<name>-<version>.liaisonapp`, like dist/. */
function buildArtifact(ui = UI, manifest = MANIFEST): string {
  const stage = join(work, "stage")
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, "app.manifest.json"), manifest)
  writeFileSync(join(stage, "bundle.js"), "export const handlers = {}\n")
  writeFileSync(join(stage, "ui.js"), ui)
  const out = join(work, "out")
  mkdirSync(out, { recursive: true })
  const { name, version } = JSON.parse(manifest)
  const tar = spawnSync("tar", [
    "-czf",
    join(out, `${name}-${version}.liaisonapp`),
    "-C",
    stage,
    "app.manifest.json",
    "bundle.js",
    "ui.js",
  ])
  if (tar.status !== 0) throw new Error(String(tar.stderr))
  return out
}

describe("sourceDigest", () => {
  function app(): string {
    const dir = join(work, "bundled-apps", "demoapp")
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "app.manifest.json"), MANIFEST)
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1\n")
    return dir
  }

  it("is a stable hex digest of the app's files", () => {
    const dir = app()
    const d = sourceDigest(dir)
    expect(d).toMatch(/^[0-9a-f]{64}$/)
    expect(sourceDigest(dir)).toBe(d)
  })

  it("ignores build output, installs, lockfiles and VCS metadata", () => {
    const dir = app()
    const before = sourceDigest(dir)
    for (const sub of ["node_modules/x", "dist", ".git"])
      mkdirSync(join(dir, sub), { recursive: true })
    writeFileSync(join(dir, "node_modules/x/index.js"), "x")
    writeFileSync(join(dir, "dist/demoapp-1.0.0.liaisonapp"), "x")
    writeFileSync(join(dir, ".git/HEAD"), "x")
    writeFileSync(join(dir, "bun.lock"), "x")
    writeFileSync(join(dir, ".DS_Store"), "x")
    expect(sourceDigest(dir)).toBe(before)
  })

  it("changes when a source byte, a file name or a symlink target changes", () => {
    const dir = app()
    const before = sourceDigest(dir)
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2\n")
    const edited = sourceDigest(dir)
    expect(edited).not.toBe(before)
    rmSync(join(dir, "src", "a.ts"))
    writeFileSync(join(dir, "src", "b.ts"), "export const a = 2\n")
    expect(sourceDigest(dir)).not.toBe(edited)
    symlinkSync("b.ts", join(dir, "src", "link.ts"))
    const linked = sourceDigest(dir)
    rmSync(join(dir, "src", "link.ts"))
    symlinkSync("../app.manifest.json", join(dir, "src", "link.ts"))
    expect(sourceDigest(dir)).not.toBe(linked)
  })
})

describe("signArtifactDir", () => {
  it("writes ui.js, manifest.json and a statement the pinned key verifies", async () => {
    const key = await createTestSigningKey()
    const dir = buildArtifact()
    const keyPath = join(work, "signing.pem")
    writeFileSync(keyPath, await key.privatePem())
    const keyId = await keyIdFor(key.key.publicKey)
    const statement = await signArtifactDir(dir, {
      keyPath,
      sourceDigest: "b".repeat(64),
      issuedAt: "2026-10-26T00:00:00.000Z",
    })
    expect(statement).toMatchObject({ keyId, name: "demoapp", version: "1.0.0", hostApi: "^1" })
    expect(readFileSync(join(dir, "ui.js"), "utf8")).toBe(UI)
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(MANIFEST)
    const result = await verifyArtifact(
      new Uint8Array(readFileSync(join(dir, "statement.json"))),
      readFileSync(join(dir, "statement.sig"), "utf8"),
      {
        name: "demoapp",
        version: "1.0.0",
        uiBytes: new Uint8Array(readFileSync(join(dir, "ui.js"))),
        manifestBytes: new Uint8Array(readFileSync(join(dir, "manifest.json"))),
        packageBytes: new Uint8Array(readFileSync(join(dir, "demoapp-1.0.0.liaisonapp"))),
      },
      { keys: [{ keyId, publicKey: key.key.publicKey }] },
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a bundle that is not a single file (A8) and writes no statement", async () => {
    const key = await createTestSigningKey()
    const dir = buildArtifact('import x from "./chunk.js";\nexport default x\n')
    const keyPath = join(work, "signing.pem")
    writeFileSync(keyPath, await key.privatePem())
    await expect(signArtifactDir(dir, { keyPath, sourceDigest: "b".repeat(64) })).rejects.toThrow(
      /single-file/,
    )
    expect(() => readFileSync(join(dir, "statement.json"))).toThrow()
  })

  it("refuses a loose ui.js that differs from the one inside the package", async () => {
    const key = await createTestSigningKey()
    const dir = buildArtifact()
    writeFileSync(join(dir, "ui.js"), `${UI}// changed\n`)
    const keyPath = join(work, "signing.pem")
    writeFileSync(keyPath, await key.privatePem())
    await expect(signArtifactDir(dir, { keyPath, sourceDigest: "b".repeat(64) })).rejects.toThrow(
      /ui\.js/,
    )
  })

  it("refuses a manifest without a host API range", async () => {
    const key = await createTestSigningKey()
    const dir = buildArtifact(UI, JSON.stringify({ name: "demoapp", version: "1.0.0" }))
    const keyPath = join(work, "signing.pem")
    writeFileSync(keyPath, await key.privatePem())
    await expect(signArtifactDir(dir, { keyPath, sourceDigest: "b".repeat(64) })).rejects.toThrow(
      /host/,
    )
  })
})

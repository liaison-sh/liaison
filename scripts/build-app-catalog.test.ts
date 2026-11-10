// SPDX-License-Identifier: FSL-1.1-ALv2
// The catalog's choice per bundled app (A3): the signed artifact when one with
// this source digest verifies against the pinned keys, the local unsigned build
// otherwise, and never a failed build because the artifacts host is away.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTestSigningKey,
  type TestSigningKey,
} from "../packages/shared/src/app-signing/testing"
import { signArtifactDir } from "./app-signing/sign-artifact"
import { sourceDigest } from "./app-signing/source-digest"
import { artifactsBaseOf, buildAppCatalog, parseCliArgs } from "./build-app-catalog"

const UI = 'import { createSignal as a } from "solid-js";\nexport const x = a(1);\n'

function manifest(version: string): string {
  return JSON.stringify({
    name: "demoapp",
    version,
    host: "^1",
    license: "FSL-1.1-ALv2",
    listing: {
      publisher: "Liaison",
      category: "Finance",
      icon: "notebook-pen",
      summary: "Demo app used by the catalog tests.",
      sourceRepository: "https://github.com/liaison-sh/liaison/tree/main/bundled-apps/demoapp",
    },
    scopes: ["demoapp:things:read"],
  })
}

let work: string
let bundledRoot: string
let outDir: string
let key: TestSigningKey
let keyPath: string
let lines: string[]
let localBuilds: string[]

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "app-catalog-"))
  bundledRoot = join(work, "bundled-apps")
  outDir = join(work, "app-catalog")
  mkdirSync(join(bundledRoot, "demoapp"), { recursive: true })
  writeFileSync(join(bundledRoot, "demoapp", "app.manifest.json"), manifest("1.0.0"))
  writeFileSync(join(bundledRoot, "demoapp", "ui.tsx"), "export {}\n")
  key = await createTestSigningKey("unused")
  keyPath = join(work, "signing.pem")
  writeFileSync(keyPath, await key.privatePem())
  lines = []
  localBuilds = []
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

/** Stand-in for the freeze: a package from the app's manifest and a fixed ui.js. */
function freeze(name: string, tag = "local"): string {
  const appDir = join(bundledRoot, name)
  const m = JSON.parse(readFileSync(join(appDir, "app.manifest.json"), "utf8"))
  const stage = join(work, `stage-${tag}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(join(appDir, "app.manifest.json"), join(stage, "app.manifest.json"))
  writeFileSync(join(stage, "ui.js"), `${UI}// ${tag}\n`)
  const out = join(work, `dist-${tag}`)
  mkdirSync(out, { recursive: true })
  const tarball = join(out, `${m.name}-${m.version}.liaisonapp`)
  spawnSync("tar", ["-czf", tarball, "-C", stage, "app.manifest.json", "ui.js"])
  return tarball
}

const buildLocal = (name: string): string => {
  localBuilds.push(name)
  return freeze(name, "local")
}

/** Publish a signed artifact for the current source into a mirror dir. */
async function publishMirror(): Promise<{ mirror: string; keyId: string }> {
  const tarball = freeze("demoapp", "release")
  const mirror = join(work, "mirror")
  const dir = join(mirror, "demoapp", "1.0.0")
  mkdirSync(dir, { recursive: true })
  cpSync(tarball, join(dir, "demoapp-1.0.0.liaisonapp"))
  const digest = sourceDigest(join(bundledRoot, "demoapp"))
  const statement = await signArtifactDir(dir, { keyPath, sourceDigest: digest })
  writeFileSync(
    join(mirror, "index.json"),
    JSON.stringify({ v: 1, apps: [{ name: "demoapp", version: "1.0.0", sourceDigest: digest }] }),
  )
  return { mirror, keyId: statement.keyId }
}

describe("buildAppCatalog", () => {
  it("uses the signed artifact whose source digest matches, and keeps its statement", async () => {
    const { mirror, keyId } = await publishMirror()
    const entries = await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { dir: mirror },
      keys: [{ keyId, publicKey: key.key.publicKey }],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(localBuilds).toEqual([])
    expect(entries[0]).toMatchObject({
      name: "demoapp",
      version: "1.0.0",
      file: "demoapp-1.0.0.liaisonapp",
      signed: {
        statement: "demoapp-1.0.0.statement.json",
        signature: "demoapp-1.0.0.statement.sig",
      },
    })
    expect(readFileSync(join(outDir, "demoapp-1.0.0.liaisonapp"))).toEqual(
      readFileSync(join(mirror, "demoapp", "1.0.0", "demoapp-1.0.0.liaisonapp")),
    )
    expect(existsSync(join(outDir, "demoapp-1.0.0.statement.json"))).toBe(true)
    expect(existsSync(join(outDir, "demoapp-1.0.0.statement.sig"))).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("signed")
  })

  it("builds locally, unsigned, when the source differs from the signed one (a fork's change)", async () => {
    const { mirror, keyId } = await publishMirror()
    writeFileSync(join(bundledRoot, "demoapp", "ui.tsx"), "export const forked = 1\n")
    const entries = await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { dir: mirror },
      keys: [{ keyId, publicKey: key.key.publicKey }],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(localBuilds).toEqual(["demoapp"])
    expect(entries[0].signed).toBeUndefined()
    expect(existsSync(join(outDir, "demoapp-1.0.0.statement.json"))).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("unsigned")
  })

  it("never uses an artifact whose statement fails: unpinned key, tampered ui.js", async () => {
    const { mirror, keyId } = await publishMirror()
    const other = await createTestSigningKey(keyId)
    await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { dir: mirror },
      keys: [other.key],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(localBuilds).toEqual(["demoapp"])

    const ui = join(mirror, "demoapp", "1.0.0", "ui.js")
    writeFileSync(ui, `${readFileSync(ui, "utf8")} `)
    await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { dir: mirror },
      keys: [{ keyId, publicKey: key.key.publicKey }],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(localBuilds).toEqual(["demoapp", "demoapp"])
  })

  it("refuses a package whose inner ui.js is not the signed loose one", async () => {
    const { mirror, keyId } = await publishMirror()
    // Re-pack the package with another ui.js: its sha256 no longer matches.
    cpSync(freeze("demoapp", "evil"), join(mirror, "demoapp", "1.0.0", "demoapp-1.0.0.liaisonapp"))
    await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { dir: mirror },
      keys: [{ keyId, publicKey: key.key.publicKey }],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(localBuilds).toEqual(["demoapp"])
  })

  it("does not fail when the artifacts host is unreachable: one line per app, local build", async () => {
    const entries = await buildAppCatalog({
      bundledRoot,
      outDir,
      source: {
        url: "https://downloads.invalid/apps",
        fetch: async () => {
          throw new Error("getaddrinfo ENOTFOUND")
        },
      },
      keys: [key.key],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(entries.map((e) => e.name)).toEqual(["demoapp"])
    expect(localBuilds).toEqual(["demoapp"])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/demoapp@1\.0\.0.*unsigned.*ENOTFOUND/)
  })

  it("reads index and files over HTTP the same way as from a mirror dir", async () => {
    const { mirror, keyId } = await publishMirror()
    const requested: string[] = []
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      requested.push(url)
      const rel = url.slice("https://downloads.example/apps/".length)
      const path = join(mirror, rel)
      return existsSync(path)
        ? new Response(readFileSync(path))
        : new Response("not found", { status: 404 })
    }
    const entries = await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { url: "https://downloads.example/apps", fetch: fakeFetch },
      keys: [{ keyId, publicKey: key.key.publicKey }],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(entries[0].signed).toBeDefined()
    expect(requested[0]).toBe("https://downloads.example/apps/index.json")
    expect(requested).toContain("https://downloads.example/apps/demoapp/1.0.0/statement.sig")
  })

  it("with no pinned key, fetches nothing and builds locally", async () => {
    let fetched = false
    await buildAppCatalog({
      bundledRoot,
      outDir,
      source: {
        url: "https://downloads.example/apps",
        fetch: async () => {
          fetched = true
          return new Response("{}")
        },
      },
      keys: [],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(fetched).toBe(false)
    expect(localBuilds).toEqual(["demoapp"])
    expect(lines[0]).toContain("no pinned app-signing key")
  })

  it("reads the index from --index-file and only the artifacts over HTTP (the image build ADDs it)", async () => {
    const { mirror, keyId } = await publishMirror()
    const indexFile = join(work, "fetched-index.json")
    cpSync(join(mirror, "index.json"), indexFile)
    const requested: string[] = []
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      requested.push(url)
      const path = join(mirror, url.slice("https://downloads.example/apps/".length))
      return existsSync(path)
        ? new Response(readFileSync(path))
        : new Response("not found", { status: 404 })
    }
    const entries = await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { url: "https://downloads.example/apps", fetch: fakeFetch },
      indexFile,
      keys: [{ keyId, publicKey: key.key.publicKey }],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(entries[0].signed).toBeDefined()
    expect(localBuilds).toEqual([])
    expect(requested).not.toContain("https://downloads.example/apps/index.json")
    expect(requested).toContain("https://downloads.example/apps/demoapp/1.0.0/statement.sig")

    // The index file decides: one that does not list this source means a local build.
    writeFileSync(indexFile, JSON.stringify({ v: 1, apps: [] }))
    requested.length = 0
    const again = await buildAppCatalog({
      bundledRoot,
      outDir,
      source: { url: "https://downloads.example/apps", fetch: fakeFetch },
      indexFile,
      keys: [{ keyId, publicKey: key.key.publicKey }],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(again[0].signed).toBeUndefined()
    expect(localBuilds).toEqual(["demoapp"])
    expect(requested).toEqual([])
  })

  it("builds locally when the index file is unreadable, without fetching", async () => {
    let fetched = false
    await buildAppCatalog({
      bundledRoot,
      outDir,
      source: {
        url: "https://downloads.example/apps",
        fetch: async () => {
          fetched = true
          return new Response("{}")
        },
      },
      indexFile: join(work, "missing-index.json"),
      keys: [key.key],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(fetched).toBe(false)
    expect(localBuilds).toEqual(["demoapp"])
    expect(lines[0]).toMatch(/unsigned.*missing-index\.json unreadable/)
  })

  it("with no artifacts location (--no-artifacts), builds locally", async () => {
    await buildAppCatalog({
      bundledRoot,
      outDir,
      source: null,
      keys: [key.key],
      buildLocal,
      log: (l) => lines.push(l),
    })
    expect(localBuilds).toEqual(["demoapp"])
    expect(lines[0]).toContain("signed artifacts lookup off")
  })
})

describe("build-app-catalog command line", () => {
  it("parses --index-file, --index-url and --no-artifacts", () => {
    expect(parseCliArgs(["--out-dir", "/o", "--index-file", "/i.json"])).toMatchObject({
      outDir: "/o",
      indexFile: "/i.json",
      indexUrl: "https://downloads.liaison.sh/apps/index.json",
      noArtifacts: false,
    })
    expect(parseCliArgs(["--no-artifacts"]).noArtifacts).toBe(true)
    expect(parseCliArgs(["--index-url", "https://m.example/a/index.json"]).indexUrl).toBe(
      "https://m.example/a/index.json",
    )
  })

  it("takes the artifacts base from the index URL, which must end in /index.json", () => {
    expect(artifactsBaseOf("https://downloads.liaison.sh/apps/index.json")).toBe(
      "https://downloads.liaison.sh/apps",
    )
    expect(() => artifactsBaseOf("https://downloads.liaison.sh/apps/")).toThrow(/index\.json/)
    expect(() => artifactsBaseOf("none")).toThrow()
  })
})

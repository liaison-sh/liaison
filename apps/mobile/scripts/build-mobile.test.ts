// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two things that make a mobile build trustworthy, pinned: the web bundle
// is rebuilt BEFORE it is synced (a sync against a stale dist ships yesterday's
// app and says nothing), and the synced assets carry no absolute path from the
// machine that built them.

import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { absolutePathOffenders, BUILD_STEPS, nonExemptCryptoOffenders } from "./build-mobile"

const SCRIPT = path.join(import.meta.dir, "build-mobile.ts")

describe("build-mobile steps", () => {
  it("builds the web bundle before it syncs it", () => {
    const names = BUILD_STEPS.map((step) => step.name)
    expect(names).toEqual(["web build", "capacitor sync", "boot bundle", "synced asset scan"])
    // The native mode: the build that leaves the legacy Argon2id KDF out.
    expect(BUILD_STEPS[0].command).toEqual(["bun", "run", "--cwd", "../web", "build:native"])
    // The web script itself must run Vite in that mode: `bun run build --mode native` once
    // appended the flag to the last command of a chained script, so Vite built `dist`.
    const webScripts = (
      JSON.parse(readFileSync(path.join(import.meta.dir, "../../web/package.json"), "utf8")) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(webScripts["build:native"]).toMatch(/^vite build --mode native(\s|$)/)
    expect(BUILD_STEPS[1].command).toEqual(["bunx", "cap", "sync"])
  })

  it("prints the steps in order and runs none of them in a dry run", () => {
    const result = Bun.spawnSync(["bun", SCRIPT, "--dry-run"], { stdout: "pipe", stderr: "pipe" })
    const out = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    const positions = BUILD_STEPS.map((step) => out.indexOf(step.name))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(out).toContain("dry run")
  })
})

describe("synced asset scan", () => {
  const fixture = (contents: string): string => {
    const root = mkdtempSync(path.join(tmpdir(), "mobile-sync-"))
    mkdirSync(path.join(root, "assets"), { recursive: true })
    writeFileSync(path.join(root, "assets", "index-abc.js"), contents)
    return root
  }

  it("flags an absolute host path baked into a synced asset", () => {
    const root = fixture(
      'const x="/Users/someone/tessera-monorepo/liaison/apps/web/src/main.tsx"\n',
    )
    try {
      const offenders = absolutePathOffenders([root])
      expect(offenders.length).toBe(1)
      expect(offenders[0].match).toContain("/Users/someone/tessera-monorepo")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("passes a clean synced tree", () => {
    const root = fixture('fetch("/api/settings/branding")\n')
    try {
      expect(absolutePathOffenders([root])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("synced Argon2id scan", () => {
  const tree = (files: Record<string, string>): string => {
    const root = mkdtempSync(path.join(tmpdir(), "mobile-crypto-"))
    mkdirSync(path.join(root, "assets"), { recursive: true })
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(path.join(root, "assets", name), contents)
    }
    return root
  }

  it("flags Argon2id code, a hash-wasm trace and a WebAssembly module", () => {
    const root = tree({
      "crypto-worker-a.js": 'const t="argon2id";',
      "index-b.js": "/* hash-wasm */",
      "mod.wasm": "\0asm",
    })
    try {
      const found = nonExemptCryptoOffenders([root]).map((o) => path.basename(o.file))
      expect(found.sort()).toEqual(["crypto-worker-a.js", "index-b.js", "mod.wasm"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("passes a tree that uses WebCrypto only", () => {
    const root = tree({ "crypto-worker-a.js": 'crypto.subtle.deriveBits({name:"PBKDF2"})' })
    try {
      expect(nonExemptCryptoOffenders([root])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The only supported way to build the mobile app. Three steps, in this order,
// and the order is the point:
//
//   1. build apps/web in its `native` mode (into `apps/web/dist-native`),
//      because a `cap sync` against a stale build copies yesterday's app into
//      the native projects and says nothing. The native mode leaves out the
//      legacy Argon2id passphrase KDF (apps/web/vite.config.ts), so the app
//      ships only the cryptography the operating system provides,
//   2. `cap sync`, which copies that build into ios/ and android/ and updates
//      the native plugin lists,
//   3. scan what was just copied for an absolute path from THIS machine. A
//      bundle carrying `/Users/<someone>/...` works on the machine that built
//      it and fails everywhere else, which is the shape of failure that is
//      invisible until a tester opens the app. The same scan refuses any trace
//      of Argon2id or hash-wasm: the store declaration (export compliance,
//      STORE_CHECKLIST.md) is only true while there is none. And the synced
//      index.html must carry the phone's Content Security Policy with no
//      inline script left (scripts/boot-injection.ts, src/csp-pin.test.ts).
//
// `--dry-run` prints the steps and runs nothing.
//
// Usage: bun run scripts/build-mobile.ts [--dry-run]

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  applyMobileCsp,
  BOOT_SCRIPT_NAME,
  injectBootScript,
  inlineScripts,
  MOBILE_CSP,
  pinViewportScale,
} from "./boot-injection"

export interface BuildStep {
  name: string
  command: string[]
  why: string
}

const MOBILE_ROOT = path.resolve(import.meta.dir, "..")

export const BUILD_STEPS: BuildStep[] = [
  {
    name: "web build",
    command: ["bun", "run", "--cwd", "../web", "build:native"],
    why: "the wrapped bundle is apps/web's own Vite build in its native mode, never a second frontend",
  },
  {
    name: "capacitor sync",
    command: ["bunx", "cap", "sync"],
    why: "copies that build into the two native projects and updates their plugin lists",
  },
  {
    name: "boot bundle",
    command: [],
    why: "apps/mobile's own boot code and the page's policy, injected into the synced copy of the web app",
  },
  {
    name: "synced asset scan",
    command: [],
    why: "a machine absolute path, any Argon2id code, or an inline script, in the shipped assets",
  },
]

/** The synced web assets inside each native project, relative to apps/mobile. */
export const SYNCED_ASSET_DIRS = [
  "ios/App/App/public",
  "android/app/src/main/assets/public",
] as const

/**
 * An absolute POSIX path into a user or build directory. `/api/...` and
 * `/assets/...` are the app's own runtime paths and are not this.
 */
const HOST_PATH = /\/(?:Users|home|private\/tmp|var\/folders|builds)\/[A-Za-z0-9._-]+\/\S*/

export interface AbsolutePathOffender {
  file: string
  match: string
}

function filesIn(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) stack.push(full)
      else out.push(full)
    }
  }
  return out
}

/**
 * Traces of the one cryptographic primitive the operating system does not
 * provide that the app ever carried: Argon2id, through hash-wasm. The native
 * build leaves both out; a match means the web build (or a stale sync) was
 * copied instead, and the export compliance declaration would be false.
 */
const NON_EXEMPT_CRYPTO = /hash-wasm|argon2/i

/** Assets under the given trees that carry Argon2id or hash-wasm code, or any WASM module. */
export function nonExemptCryptoOffenders(dirs: readonly string[]): AbsolutePathOffender[] {
  const offenders: AbsolutePathOffender[] = []
  for (const dir of dirs) {
    for (const file of filesIn(dir)) {
      if (file.endsWith(".wasm")) {
        offenders.push({ file, match: "a WebAssembly module" })
        continue
      }
      if (!/\.(?:js|mjs|html|json|map)$/.test(file)) continue
      let content: string
      try {
        content = readFileSync(file, "utf8")
      } catch {
        continue
      }
      const found = content.match(NON_EXEMPT_CRYPTO)
      if (found) offenders.push({ file, match: found[0] })
    }
  }
  return offenders
}

/** Text assets under the given trees that carry a host absolute path. */
export function absolutePathOffenders(dirs: readonly string[]): AbsolutePathOffender[] {
  const offenders: AbsolutePathOffender[] = []
  for (const dir of dirs) {
    for (const file of filesIn(dir)) {
      if (!/\.(?:js|css|html|json|map|svg)$/.test(file)) continue
      let content: string
      try {
        content = readFileSync(file, "utf8")
      } catch {
        continue
      }
      const found = content.match(HOST_PATH)
      if (found) offenders.push({ file, match: found[0].slice(0, 120) })
    }
  }
  return offenders
}

/**
 * Synced index.html files that are not under the phone's policy: the CSP meta
 * missing or changed, or an inline script left that it would block.
 */
export function policyOffenders(dirs: readonly string[]): AbsolutePathOffender[] {
  const offenders: AbsolutePathOffender[] = []
  for (const dir of dirs) {
    const file = path.join(dir, "index.html")
    let html: string
    try {
      html = readFileSync(file, "utf8")
    } catch {
      offenders.push({ file, match: "no index.html" })
      continue
    }
    if (!html.includes(`content="${MOBILE_CSP}"`)) {
      offenders.push({ file, match: "no Content-Security-Policy meta" })
    }
    if (inlineScripts(html).length > 0) offenders.push({ file, match: "an inline script" })
  }
  return offenders
}

/**
 * Bundles src/boot-entry.ts into every synced asset tree and points that tree's
 * index.html at it. Done on the COPY, after the sync: apps/web is wrapped
 * unmodified.
 */
async function buildBootBundle(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    const result = await Bun.build({
      entrypoints: [path.join(MOBILE_ROOT, "src", "boot-entry.ts")],
      target: "browser",
      format: "iife",
      minify: true,
    })
    if (!result.success) {
      for (const log of result.logs) console.log(`  ${log}`)
      console.log("the mobile boot bundle did not build")
      process.exit(1)
    }
    writeFileSync(path.join(dir, BOOT_SCRIPT_NAME), await result.outputs[0].text())
    const indexHtml = path.join(dir, "index.html")
    const { html, files } = applyMobileCsp(
      pinViewportScale(injectBootScript(readFileSync(indexHtml, "utf8"))),
    )
    for (const file of files) writeFileSync(path.join(dir, file.name), file.content)
    writeFileSync(indexHtml, html)
    console.log(
      `  ${path.relative(MOBILE_ROOT, indexHtml)} runs ${BOOT_SCRIPT_NAME} first, under the phone's policy`,
    )
  }
}

function run(step: BuildStep): void {
  const result = Bun.spawnSync(step.command, {
    cwd: MOBILE_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) {
    console.log(`mobile build failed at step: ${step.name}`)
    process.exit(result.exitCode ?? 1)
  }
}

if (import.meta.main) {
  const dryRun = process.argv.slice(2).includes("--dry-run")
  for (const [index, step] of BUILD_STEPS.entries()) {
    console.log(`${index + 1}. ${step.name}${dryRun ? " (dry run)" : ""}: ${step.why}`)
    if (dryRun) continue
    const dirs = SYNCED_ASSET_DIRS.map((d) => path.join(MOBILE_ROOT, d))
    if (step.command.length > 0) {
      run(step)
      continue
    }
    if (step.name === "boot bundle") {
      await buildBootBundle(dirs)
      continue
    }
    const offenders = absolutePathOffenders(dirs)
    for (const offender of offenders) {
      console.log(`  ${path.relative(MOBILE_ROOT, offender.file)}: ${offender.match}`)
    }
    if (offenders.length > 0) {
      console.log(
        "The synced assets carry an absolute path from this machine. A bundle like that " +
          "works here and nowhere else.",
      )
      process.exit(1)
    }
    const cryptoOffenders = nonExemptCryptoOffenders(dirs)
    for (const offender of cryptoOffenders) {
      console.log(`  ${path.relative(MOBILE_ROOT, offender.file)}: ${offender.match}`)
    }
    if (cryptoOffenders.length > 0) {
      console.log(
        "The synced assets carry Argon2id code. The app is declared as using only the " +
          "encryption the operating system provides (STORE_CHECKLIST.md, Export compliance).",
      )
      process.exit(1)
    }
    const policy = policyOffenders(dirs)
    for (const offender of policy) {
      console.log(`  ${path.relative(MOBILE_ROOT, offender.file)}: ${offender.match}`)
    }
    if (policy.length > 0) {
      console.log(
        "The synced page is not under the phone's Content Security Policy, or still carries " +
          "an inline script it would block.",
      )
      process.exit(1)
    }
    console.log(
      `  scanned ${dirs.length} synced asset trees: no host path, no Argon2id, no inline script`,
    )
  }
}

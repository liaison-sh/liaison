// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The release handshake between the app and the sandbox service. Both run
// from the same image, so after an upgrade the sandbox container must be
// recreated with the app: a sandbox service left running from the previous
// image would run the new app's runs on its old loader.
//
// `sandboxRelease()` names what the service runs: the image's LIAISON_VERSION
// plus a digest of the code that decides how a run is run (this package, the
// shared app loader, the pinned workerd version). The app computes the same
// value from the same files and sends it with every request
// (`x-liaison-sandbox-release`). The service refuses a run, a module push and
// a health probe of another release (409 `sandbox_release_mismatch`, a message
// that says what to do), and its own health check reports unhealthy while
// only callers of another release reach it (supervisor.ts).

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pinnedWorkerdVersion } from "./workerd-bin"

export const RELEASE_HEADER = "x-liaison-sandbox-release"
export const RELEASE_MISMATCH_CODE = "sandbox_release_mismatch"

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|js)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

let memo: string | null = null

/** This image's sandbox release: `<LIAISON_VERSION>+<digest>`. */
export function sandboxRelease(env: NodeJS.ProcessEnv = process.env): string {
  if (memo) return memo
  const req = createRequire(import.meta.url)
  // The loader's entry is src/index.ts: its directory holds the loader's code.
  const loaderDir = dirname(req.resolve("@liaison/app-loader"))
  const h = createHash("sha256")
  h.update(`workerd ${pinnedWorkerdVersion()}\0`)
  for (const [label, dir] of [
    ["supervisor", import.meta.dir],
    ["app-loader", loaderDir],
  ] as const) {
    for (const file of sourceFiles(dir)) {
      h.update(`${label}/${file.slice(dir.length + 1)}\0`)
      h.update(readFileSync(file))
      h.update("\0")
    }
  }
  memo = `${env.LIAISON_VERSION || "dev"}+${h.digest("hex").slice(0, 16)}`
  return memo
}

/** The operator's fix, in the words every refusal uses. */
export function releaseMismatchMessage(service: string, caller: string): string {
  return (
    `The sandbox service runs release ${service} but the app runs release ${caller}: ` +
    "recreate the sandbox service with the app's image " +
    "(docker compose --profile sandbox up -d sandbox), see docs/self-hosting/sandbox.md"
  )
}

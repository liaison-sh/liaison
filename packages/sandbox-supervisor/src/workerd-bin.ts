// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The workerd binary this package pins (package.json: `workerd`, an exact
// version). The npm package ships one binary per platform as an optional
// dependency; its own `bin/workerd` is a launcher script, so the binary is
// resolved directly from the platform package. WORKERD_BIN overrides it (an
// image that installs the binary elsewhere).
//
// The pin is deliberate: the Worker Loader binding needs `--experimental`,
// so its behaviour is not covered by workerd's compatibility promise. A bump
// re-runs the executor parity suite on workerd (.claude/test-map.ts maps this
// package's manifest to it).

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const PLATFORMS: Record<string, string> = {
  "darwin-arm64": "@cloudflare/workerd-darwin-arm64",
  "darwin-x64": "@cloudflare/workerd-darwin-64",
  "linux-arm64": "@cloudflare/workerd-linux-arm64",
  "linux-x64": "@cloudflare/workerd-linux-64",
}

/** The pinned workerd version, as package.json names it. */
export function pinnedWorkerdVersion(): string {
  const req = createRequire(import.meta.url)
  const pkg = req("workerd/package.json") as { version: string }
  return pkg.version
}

export function resolveWorkerdBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WORKERD_BIN
  if (override) {
    if (!existsSync(override)) throw new Error(`WORKERD_BIN does not exist: ${override}`)
    return override
  }
  const platformPkg = PLATFORMS[`${process.platform}-${process.arch}`]
  if (!platformPkg) {
    throw new Error(`workerd has no binary for ${process.platform}-${process.arch}`)
  }
  const req = createRequire(import.meta.url)
  const workerdDir = dirname(req.resolve("workerd/package.json"))
  const fromWorkerd = createRequire(join(workerdDir, "package.json"))
  const bin = join(dirname(fromWorkerd.resolve(`${platformPkg}/package.json`)), "bin", "workerd")
  if (!existsSync(bin)) throw new Error(`workerd binary missing at ${bin}`)
  return bin
}

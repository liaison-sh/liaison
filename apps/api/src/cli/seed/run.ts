// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison seed --tier <tier> [tier flags]`: fill an org from the seed engine
 * (`~/seed`). Tier `demo`: the Resonant Audio Labs world the demo signup and
 * warm pool seed (`seedDemoWorld`'s CLI in `seed/tiers/demo/seed-demo.ts`).
 * Tier `lively`: that world with ten people and fourteen days of activity, for
 * private boxes (`seed/tiers/lively/seed-lively.ts`). Tier `load`: N disposable
 * busy orgs for a load run, with `--volume` thousands of rows each
 * (`seed/tiers/load/seed-load.ts`). Tier `standard`: the QA world the test
 * lanes and `bun run dev` start from, in the org of the admin `--admin` names
 * (`seed/tiers/standard/seed-standard.ts`).
 *
 * The CLI process is never a job host (`cli/cli-env.ts`), so the search and
 * outbox work a seed queues stays for the app process.
 *
 * Exit codes: 0 seeded in full, 1 a layer failed, 2 usage.
 */
import path from "node:path"
import { usageOf } from "~/cli/commands"
import { resolveSeedAppDirs } from "~/cli/seed/app-dirs"

/** This checkout's repository root (apps/api/src/cli/seed -> five levels up). */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")

export const SEED_TIERS = ["demo", "lively", "load", "standard"] as const
export type SeedTier = (typeof SEED_TIERS)[number]

export interface SeedCliResult {
  exitCode: 0 | 1 | 2
  message?: string
}

/** The tier `--tier` names, or null when it is missing or unknown. */
export function parseSeedTier(argv: readonly string[]): SeedTier | null {
  const i = argv.indexOf("--tier")
  const inline = argv.find((a) => a.startsWith("--tier="))
  const value = i >= 0 ? argv[i + 1] : inline?.slice("--tier=".length)
  return SEED_TIERS.find((t) => t === value) ?? null
}

/** The flags after `seed`, without `--tier <tier>`: what the tier's own CLI reads. */
export function tierArgs(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === "--tier") {
      i++
      continue
    }
    if (a.startsWith("--tier=")) continue
    out.push(a)
  }
  return out
}

/** `argv` starts after `seed`. */
export async function runSeedCli(argv: readonly string[]): Promise<SeedCliResult> {
  const tier = parseSeedTier(argv)
  if (!tier) return { exitCode: 2, message: usageOf("seed") }
  if (tier === "standard") {
    const { runSeedStandardCli } = await import("~/seed/tiers/standard/seed-standard")
    const { exitCode } = await runSeedStandardCli(tierArgs(argv))
    return { exitCode }
  }
  // The other tiers install the catalog apps: outside the image, find them in
  // this checkout. The commerce layer writes their tables, so without a catalog
  // it stops here naming the variable to set (cli/seed/app-dirs.ts).
  const needsCatalog = tier !== "lively" || !argv.includes("--no-commerce")
  const dirs = resolveSeedAppDirs({ env: process.env, repoRoot: REPO_ROOT, needsCatalog })
  if (!dirs.ok) return { exitCode: 2, message: dirs.message }
  Object.assign(process.env, dirs.set)
  if (tier === "lively") {
    const { runSeedLivelyCli } = await import("~/seed/tiers/lively/seed-lively")
    const { exitCode } = await runSeedLivelyCli(tierArgs(argv))
    return { exitCode }
  }
  if (tier === "load") {
    const { runSeedLoadCli } = await import("~/seed/tiers/load/seed-load")
    const { exitCode } = await runSeedLoadCli(tierArgs(argv))
    return { exitCode }
  }
  const { runSeedDemoCli } = await import("~/seed/tiers/demo/seed-demo")
  const { exitCode } = await runSeedDemoCli(tierArgs(argv))
  return { exitCode }
}

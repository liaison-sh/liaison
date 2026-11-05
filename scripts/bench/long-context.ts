// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The long context bench entry point (spec-context-bench.md). It runs ON
// DEMAND and is wired into no CI lane.
//
//   bun scripts/bench/long-context.ts \
//     --corpus <dir> --strategies S0,S1,S2,S3,S4,S5,S6 \
//     --answerer gemini|sdk --resume-points 2,4,6 --out <dir>
//
// Keys: GOOGLE_API_KEY only, read from the repo root `.env.test` unless the
// environment already carries one. Claude models are reached ONLY through this
// Mac's Claude Code login (the Claude Agent SDK), never through an Anthropic
// API key.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runBench } from "../../apps/api/src/tests/bench/long-context/run"

const ROOT = join(import.meta.dir, "..", "..")

/** Load `.env.test` from the repo root without clobbering a real environment. */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as string
    let value = (match[2] ?? "").trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

function arg(name: string, fallback?: string): string | undefined {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && argv[index + 1]) return argv[index + 1]
  return fallback
}

async function main(): Promise<void> {
  loadEnvFile(join(ROOT, ".env.test"))
  const corpusDir = arg("corpus")
  const outDir = arg("out")
  if (!corpusDir || !outDir) {
    console.error(
      "usage: bun scripts/bench/long-context.ts --corpus <dir> --out <dir> [--strategies S0,S2] [--answerer gemini|sdk] [--resume-points 2,4,6] [--model <id>] [--concurrency 4] [--tail-tokens n] [--big-tail-tokens n] [--probe-limit n] [--embedding-cache <dir>]",
    )
    process.exit(1)
    return
  }
  const answerer = (arg("answerer", "gemini") as "gemini" | "sdk") ?? "gemini"
  if (answerer !== "gemini" && answerer !== "sdk") {
    console.error(`unknown answerer: ${answerer}`)
    process.exit(1)
    return
  }
  const strategyIds = (arg("strategies", "S0,S1,S2,S3,S4,S5,S6") as string)
    .split(",")
    .map((s) => s.trim())
  const resumePoints = (arg("resume-points", "2,4,6") as string)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
  const out = await runBench({
    corpusDir,
    outDir,
    strategyIds,
    answerer,
    resumePoints,
    modelId: arg("model"),
    concurrency: Number(arg("concurrency", "4")),
    smallTailTokens: arg("tail-tokens") ? Number(arg("tail-tokens")) : undefined,
    probeLimit: arg("probe-limit") ? Number(arg("probe-limit")) : undefined,
    embeddingCacheDir: arg("embedding-cache"),
    bigTailTokens: arg("big-tail-tokens") ? Number(arg("big-tail-tokens")) : undefined,
  })
  console.log(`report written: ${out.reportPath}`)
}

await main()

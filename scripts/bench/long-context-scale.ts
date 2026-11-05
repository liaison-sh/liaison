// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scale bench entry point (spec-context-bench.md, phase 3). It runs ON
// DEMAND and is wired into no CI lane.
//
//   bun scripts/bench/long-context-scale.ts \
//     --corpus <dir> --sizes 100k,1m,10m --strategy S4 \
//     --answerer gemini --probe-limit 40 --out <dir>
//
// Retrieval and assembly are measured with no model at all: the thread is
// generated deterministically from a seed and the summarizer used for the
// flatness numbers is a counting stub. A live answerer runs only when
// `--answerer` is given. `--no-embeddings` measures the keyword leg alone,
// which needs no key and no budget. `--drop-needles` removes the probed facts
// from every mutated copy, so the needle really is unique at the deepest point
// while every other fact shape still repeats.
//
// Keys: GOOGLE_API_KEY only, read from the repo root `.env.test` unless the
// environment already carries one.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runScaleBench } from "../../apps/api/src/tests/bench/long-context/scale"

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

const argv = process.argv.slice(2)

function arg(name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && argv[index + 1]) return argv[index + 1]
  return fallback
}

function flag(name: string): boolean {
  return argv.includes(`--${name}`)
}

const USAGE = [
  "usage: bun scripts/bench/long-context-scale.ts --corpus <dir> --out <dir>",
  "  [--sizes 100k,1m,10m] [--strategy S4] [--answerer gemini|sdk] [--probe-limit 40]",
  "  [--seed n] [--decoy-ratio 1.0] [--drop-needles] [--no-embeddings] [--embedding-cache <dir>]",
  "  [--model <id>] [--concurrency 4] [--keep-artifacts]",
].join("\n")

async function main(): Promise<void> {
  loadEnvFile(join(ROOT, ".env.test"))
  const corpusDir = arg("corpus")
  const outDir = arg("out")
  if (!corpusDir || !outDir) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  const answererArg = arg("answerer")
  if (answererArg && answererArg !== "gemini" && answererArg !== "sdk") {
    console.error(`unknown answerer: ${answererArg}`)
    process.exit(1)
    return
  }
  const result = await runScaleBench({
    corpusDir,
    outDir,
    sizes: (arg("sizes", "100k,1m,10m") as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    strategyId: arg("strategy", "S4") as string,
    answerer: (answererArg as "gemini" | "sdk" | undefined) ?? null,
    probeLimit: arg("probe-limit") ? Number(arg("probe-limit")) : undefined,
    seed: arg("seed") ? Number(arg("seed")) : undefined,
    decoyRatio: arg("decoy-ratio") ? Number(arg("decoy-ratio")) : undefined,
    dropNeedles: flag("drop-needles"),
    noEmbeddings: flag("no-embeddings"),
    embeddingCacheDir: arg("embedding-cache"),
    modelId: arg("model"),
    concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
    keepArtifacts: flag("keep-artifacts"),
  })
  for (const verdict of result.verdicts) {
    console.log(`${verdict.pass ? "PASS" : "FAIL"}: ${verdict.property}. ${verdict.detail}`)
  }
  console.log(`report written: ${result.reportPath}`)
  if (result.verdicts.some((v) => !v.pass)) process.exit(2)
}

await main()

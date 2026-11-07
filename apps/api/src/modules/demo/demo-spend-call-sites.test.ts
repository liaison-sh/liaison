// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY MODEL CALL SITE IS REVIEWED FOR DEMO VISITORS. The visitor spend gate
// (demo-spend.ts, credit-meter.ts) is complete only if every path that can
// reach a model key is one whose demo disposition was decided: reserved and
// settled, refused, or off. A new file that calls one of the entry points
// below fails here until it is added to the list WITH its disposition, so a
// new path cannot appear unreviewed.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "..", "..")
const ENTRY_POINTS =
  /\b(resolveKey|preCheck|openRouterFetch|createOpenRouterModel|resolveOrgEmbedder)\(/

/** Each reviewed file and what a demo visitor org gets there. */
const REVIEWED: Record<string, string> = {
  "infra/jobs/kernel-jobs.ts":
    "routine credit gate: reserve then finish at once (the run is a turn)",
  "modules/agent/context/checkpoint.ts": "reservation + settle (meterSideCall)",
  "modules/agent/context/compaction.ts":
    "reservation + settle (finalizeUsage demo, finally finish)",
  "modules/agent/context/warm-compaction.ts":
    "idle brief: preCheck reservation, meterSideCall in finally",
  "modules/agent/credits/credit-meter.ts":
    "the gate itself: resolveKey capability, visitor preCheck",
  "modules/agent/credits/managed-side-call.ts":
    "managed edition only (the demo runs self-hosted); resolveKey applies the visitor gate anyway",
  "modules/agent/credits/openrouter-catalogue.ts": "GET /models with no key: no spend",
  "modules/agent/credits/unreported-generations.ts":
    "GET /generation (a stopped step's record): no spend, the step meter already billed it",
  "modules/agent/media/media-analysis-client.ts":
    "OpenRouter call on a key managedSideCallGate returned: managed edition only, never a demo",
  "modules/agent/media/media-analysis-tool.ts":
    "refused (demoMediaAnalysisRefusal) before preCheck",
  "modules/agent/memory/consolidation.ts": "off for every demo org",
  "modules/agent/memory/memory-search.ts": "embedder: Google only, never the box key for a visitor",
  "modules/agent/providers/openrouter-embeddings.ts":
    "embeddings on a key managedSideCallGate returned: managed edition only, never a demo",
  "modules/agent/providers/openrouter-host-ranking.ts":
    "GET /models/:id/endpoints with no key: no spend",
  "modules/agent/providers/openrouter.ts":
    "the box key request guard (assertBoxKeyRequest + max_price)",
  "modules/agent/providers/provider.ts": "createOpenRouterModel: guarded fetch on the box key",
  "modules/agent/runtime/agent-service.ts": "turn: reservation per step (DemoStepMeter)",
  "modules/agent/runtime/auto-title.ts": "off for visitor orgs (heuristic title)",
  "modules/agent/subruns/subrun-worker.ts": "turn: reservation per step, counts as a turn",
  "modules/agent/tools/web-search-openrouter.ts":
    "box key only through visitorBoxKeySearch's reservation",
  "modules/agent/tools/web-tools.ts": "web_search: reservation per search; extract side call off",
  "modules/apps/sandbox/bridge/tickets.ts": "ticket summary: reservation + settle",
  "modules/assist/proofread-service.ts": "wand / clean-up: reservation + settle",
  "modules/assist/transcribe-service.ts": "reservation per call (seconds x worst price)",
  "modules/demo/demo-alerts.ts": "GET /models price drift check with no key: no spend",
  "modules/files/media-analysis-job.ts": "refused (demoMediaAnalysisRefusal) before preCheck",
  "modules/search/message-indexer.ts": "embedder: Google only, BYOK only for a visitor",
  "modules/settings/ai-models-admin.ts":
    "add-model test call: the page and ai_models_set refuse visitors (demo_models_locked) first",
  "modules/settings/ai-models-routes.ts":
    "writes and add-model refused for visitors (demo_models_locked)",
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) {
      if (name === "tests" || name === "node_modules" || name === "__fixtures__") continue
      out.push(...sourceFiles(abs))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(abs)
    }
  }
  return out
}

describe("demo visitor spend: every model call site is reviewed", () => {
  it("lists exactly the files that call a model entry point", () => {
    const found = sourceFiles(SRC)
      .filter((f) => ENTRY_POINTS.test(readFileSync(f, "utf-8")))
      .map((f) => path.relative(SRC, f))
      .sort()
    expect(found).toEqual(Object.keys(REVIEWED).sort())
  })
})

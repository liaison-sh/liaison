// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE LOCAL MODELS ARE THE INSTALLED SDK'S OWN. The shell offered a list
// written into the app, so a model the Agent SDK learned about appeared only
// after a code change. A session now asks its SDK and says the answer on
// stdout; a session whose SDK cannot answer says nothing, and the shell keeps
// its fallback.

import { describe, expect, it } from "bun:test"
import { currentNodeModels } from "../../../packages/shared/src/node-models"
import type { SessionHandle, SessionRunner } from "./index"
import {
  AsyncQueue,
  announceLocalModels,
  isLocalModelsCall,
  LOCAL_MODELS,
  LOCAL_MODELS_FLAG,
  localModelsMain,
  runMain,
} from "./index"
import type { SdkModelInfo } from "./sdk-runner"
import { localModelsFrom } from "./sdk-runner"

// What `Query.supportedModels()` answered on a Claude Max login, SDK 0.3.286
// (2026-10-01), trimmed to the fields the mapping reads.
const SDK_ANSWER: SdkModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
]

const EXPECTED = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
]

function sessionAnswering(answer: () => Promise<SdkModelInfo[]>): SessionHandle {
  return {
    async *[Symbol.asyncIterator]() {},
    supportedModels: answer,
  }
}

async function linesFrom(session: SessionHandle, timeoutMs?: number) {
  const lines: Record<string, unknown>[] = []
  await announceLocalModels(session, (event) => lines.push(event), timeoutMs)
  return lines
}

describe("localModelsFrom", () => {
  it("names every model by the id that answers, aliases resolved, explicit ids kept", () => {
    expect(localModelsFrom(SDK_ANSWER)).toEqual(EXPECTED)
  })

  it("falls back to the display name when the description has no model name", () => {
    expect(
      localModelsFrom([{ value: "claude-next-1", displayName: "Next", description: "New" }]),
    ).toEqual([{ id: "claude-next-1", label: "Claude Next" }])
  })

  // 2026-10-01: another login's answer on the same SDK names the version in
  // the display name and not in the description. Its labels came out as
  // "Opus 5.5" beside the fallback's "Claude Haiku 4.5".
  it("labels a row named only by its display name like every other row", () => {
    const rows: SdkModelInfo[] = [
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
        description: "For complex work and everyday tasks",
      },
      {
        value: "claude-fable-5-1",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable 5.1",
        description: "For your toughest challenges",
      },
      {
        value: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        displayName: "Haiku 4.5",
        description: "Fastest for quick answers",
      },
    ]
    expect(localModelsFrom(rows)).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ])
  })

  it("S25: a model with supportedEffortLevels carries efforts", () => {
    const rows: SdkModelInfo[] = [
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
        description: "For complex work and everyday tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "haiku",
        resolvedModel: "claude-haiku-5-5",
        displayName: "Haiku 5.5",
        description: "Fastest for quick answers",
      },
      {
        // Levels listed but effort not supported: nothing is offered.
        value: "claude-sonnet-5",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet 5",
        description: "Efficient for routine tasks",
        supportsEffort: false,
        supportedEffortLevels: ["low", "high"],
      },
    ]
    expect(localModelsFrom(rows)).toEqual([
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    ])
  })
})

// 2026-10-15, SDK 0.3.296 on the owner's Mac: the answer lists every pinned
// older version beside the family aliases, twelve models, and an agent offered
// them all picked claude-opus-4-6. Only what each family's alias resolves to
// is offered. Trimmed to the fields the mapping reads, order as answered.
const SDK_0_3_296: SdkModelInfo[] = [
  [
    "default",
    "claude-sonnet-5-5",
    "Default (recommended)",
    "Sonnet 5.5 · Efficient for routine tasks",
  ],
  ["opus", "claude-opus-5-5", "Opus 5.5", "For complex work and everyday tasks"],
  ["fable", "claude-fable-5-1", "Fable 5.1", "For your toughest challenges"],
  ["sonnet", "claude-sonnet-5-5", "Sonnet 5.5", "Most efficient for simpler tasks"],
  ["haiku", "claude-haiku-5-5", "Haiku 5.5", "Fastest for quick answers"],
  [
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5-20251001",
    "Haiku 4.5",
    "Fastest for quick answers",
  ],
  ["claude-sonnet-5", "claude-sonnet-5", "Sonnet 5", "Efficient for routine tasks"],
  ["claude-opus-5", "claude-opus-5", "Opus 5", "Best for everyday, complex tasks"],
  [
    "claude-fable-5",
    "claude-fable-5",
    "Fable 5",
    "Most capable for your hardest and longest-running tasks",
  ],
  ["claude-opus-4-8", "claude-opus-4-8", "Opus 4.8", "Best for everyday, complex tasks"],
  ["claude-opus-4-7", "claude-opus-4-7", "Opus 4.7", "Best for everyday, complex tasks"],
  ["claude-opus-4-6", "claude-opus-4-6", "Opus 4.6", "Best for everyday, complex tasks"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6", "Sonnet 4.6", "Efficient for routine tasks"],
].map(([value, resolvedModel, displayName, description]) => ({
  value: value as string,
  resolvedModel: resolvedModel as string,
  displayName: displayName as string,
  description: description as string,
}))

describe("every model the SDK runs, each family's current one offered", () => {
  const ids = (models: { id: string }[]) => models.map((model) => model.id)

  // Review of #63: the list is what a session may START on, so an older
  // version the SDK runs stays in it; only the offer is narrowed.
  it("keeps every pinned version, and offers what each family's alias resolves to", () => {
    const all = localModelsFrom(SDK_0_3_296)
    expect(ids(all)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ])
    expect(currentNodeModels(all)).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ])
  })

  it("follows the SDK when an alias moves to a newer model, with no change here", () => {
    const next = SDK_0_3_296.map((row) =>
      row.value === "opus"
        ? { ...row, resolvedModel: "claude-opus-6", displayName: "Opus 6" }
        : row,
    )
    next.push({
      value: "claude-opus-5-5",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus 5.5",
      description: "Best for everyday, complex tasks",
    })
    const all = localModelsFrom(next)
    expect(ids(all)).toContain("claude-opus-5-5")
    expect(ids(currentNodeModels(all))).toEqual([
      "claude-opus-6",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ])
  })

  // Review of #63: an alias row the SDK did not resolve was kept as "opus"
  // beside claude-opus-5-5, and offered twice.
  it("drops a bare alias whose family is listed by id, keeps one that is not", () => {
    const rows: SdkModelInfo[] = [
      { value: "opus", displayName: "Opus", description: "Opus 5.5 · Best for complex work" },
      { value: "lyric", displayName: "Lyric", description: "New" },
      ...SDK_0_3_296.filter((row) => row.value !== "opus"),
      {
        value: "claude-opus-5-5",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
        description: "Best for complex work",
      },
    ]
    const offered = ids(currentNodeModels(localModelsFrom(rows)))
    expect(offered).not.toContain("opus")
    expect(offered).toContain("claude-opus-5-5")
    expect(offered).toContain("lyric")
  })
})

// 2026-10-14, SDK 0.3.296: a superseded row is described by a pointer to its
// successor, not by its name. It was labelled "Claude Newer version available".
it("never takes a description that names no model for the label", () => {
  expect(
    localModelsFrom([
      {
        value: "claude-haiku-4-5",
        resolvedModel: "claude-haiku-4-5",
        displayName: "Haiku 4.5",
        description: "Newer version available · select Haiku for Haiku 5.5",
      },
    ]),
  ).toEqual([{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }])
})

// THE NODE'S OWN DISCOVERY (2026-10-14). A node whose computer never ran a
// local chat heard no `local_models` line and published the fallback written
// into the app. The shell now asks the bundled SDK at launch, no session.
describe("--local-models", () => {
  async function discovered(
    answer: () => Promise<SdkModelInfo[]>,
    timeoutMs?: number,
  ): Promise<{ code: number; lines: unknown[]; closed: boolean }> {
    const written: string[] = []
    let closed = false
    const code = await localModelsMain("/bundled/claude", {
      write: (line) => written.push(line),
      query: (cliPath) => {
        expect(cliPath).toBe("/bundled/claude")
        return {
          async *[Symbol.asyncIterator]() {},
          supportedModels: answer,
          close: () => {
            closed = true
          },
        }
      },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    return { code, lines: written.map((line) => JSON.parse(line)), closed }
  }

  it("is its own mode, never a session", () => {
    expect(isLocalModelsCall([LOCAL_MODELS_FLAG])).toBe(true)
    expect(isLocalModelsCall([LOCAL_MODELS_FLAG, "--model", "x"])).toBe(false)
    expect(isLocalModelsCall(["--mcp-config", "/tmp/m.json"])).toBe(false)
  })

  it("says the bundled SDK's list, resolved ids and labels, and closes its query", async () => {
    const out = await discovered(async () => SDK_ANSWER)
    expect(out).toEqual({
      code: 0,
      lines: [{ type: LOCAL_MODELS, models: EXPECTED }],
      closed: true,
    })
  })

  it("says it failed, in one line, when the SDK refuses or is silent", async () => {
    const refused = await discovered(async () => {
      throw new Error("not signed in")
    })
    expect(refused).toEqual({
      code: 1,
      lines: [{ type: LOCAL_MODELS, error: "unavailable" }],
      closed: true,
    })
    const silent = await discovered(() => new Promise<SdkModelInfo[]>(() => {}), 10)
    expect(silent.lines).toEqual([{ type: LOCAL_MODELS, error: "unavailable" }])
  })
})

describe("announceLocalModels", () => {
  it("says the SDK's list, a model the app never listed included", async () => {
    const lines = await linesFrom(sessionAnswering(async () => SDK_ANSWER))
    expect(lines).toEqual([{ type: LOCAL_MODELS, models: EXPECTED }])
  })

  it("says nothing when the SDK refuses, so the shell keeps its fallback", async () => {
    const lines = await linesFrom(
      sessionAnswering(async () => {
        throw new Error("control request failed")
      }),
    )
    expect(lines).toEqual([])
  })

  it("says nothing when the SDK does not answer in time", async () => {
    const lines = await linesFrom(
      sessionAnswering(() => new Promise<SdkModelInfo[]>(() => {})),
      10,
    )
    expect(lines).toEqual([])
  })

  it("says nothing for a session that cannot list models, or lists none", async () => {
    expect(await linesFrom({ async *[Symbol.asyncIterator]() {} })).toEqual([])
    expect(await linesFrom(sessionAnswering(async () => []))).toEqual([])
  })
})

describe("a session", () => {
  it("says its SDK's models without waiting for a turn", async () => {
    const written: string[] = []
    const runner: SessionRunner = ({ prompts }) => {
      async function* run() {
        for await (const prompt of prompts) yield { type: "echo", prompt }
      }
      const iterator = run()
      return { [Symbol.asyncIterator]: () => iterator, supportedModels: async () => SDK_ANSWER }
    }
    const control = new AsyncQueue<string>()
    const done = runMain({
      config: {
        mcpConfigPath: "/tmp/mcp.json",
        cwd: "/tmp/work",
        permissionMode: "manual",
        model: "claude-haiku-4-5",
        isolateConfig: false,
      },
      runner,
      write: (line) => written.push(line),
      control,
    })
    // No turn is sent: the list must not depend on one.
    await Bun.sleep(5)
    control.push(JSON.stringify({ type: "shutdown" }))
    control.close()
    await done
    const events = written.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events).toContainEqual({ type: LOCAL_MODELS, models: EXPECTED })
  })
})

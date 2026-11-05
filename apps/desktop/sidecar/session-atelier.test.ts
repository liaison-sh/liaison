// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { nodeSessionAtelierStateSchema } from "../../../packages/shared/src/node-session-protocol"
import {
  AtelierWatch,
  findWorkspaceRoot,
  isAtelierStatePath,
  readAtelierState,
} from "./session-atelier"

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-atelier-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const FIXTURES = path.join(import.meta.dir, "__fixtures__", "atelier")
const SDK_ID = "5122ce99-0000-4000-8000-000000000001"
const OTHER_ID = "5122ce99-0000-4000-8000-000000000002"

/** A fixture's JSON, owned by `owner`, with `patch` applied. */
function fixture(
  name: "state-valid.json" | "state-hostile.json",
  owner = SDK_ID,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>
  return { ...raw, sourceSessionId: owner, ...patch }
}

/** A fresh workspace root (a git-less folder holding `.atelier/`). */
function workspace(): string {
  const root = realpathSync(mkdtempSync(path.join(scratch, "ws-")))
  mkdirSync(path.join(root, ".atelier", "pipelines"), { recursive: true })
  return root
}

function writeState(root: string, id: string, body: unknown): string {
  const dir = path.join(root, ".atelier", "pipelines", id)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "state.json")
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body))
  return file
}

describe("P2-T08 the Atelier state reader (S35, A12)", () => {
  it("S35: a state.json owned by one of the session's SDK ids is read and mapped", () => {
    const root = workspace()
    writeState(root, "p1", fixture("state-valid.json"))
    const read = readAtelierState(root, new Set([OTHER_ID, SDK_ID]))
    expect(read.invalid).toEqual([])
    expect(read.state).toEqual({
      id: "p1",
      rung: "R2",
      phase: "execute",
      plan: ["frame", "brainstorm", "spec", "review", "execute", "validate", "handoff"],
      done: ["frame", "brainstorm", "spec", "review"],
      status: "running",
      awaiting: null,
      boards: [{ title: "Proof board", url: "https://claude.ai/artifact/proof-board" }],
    })
    expect(nodeSessionAtelierStateSchema.safeParse(read.state).success).toBe(true)
  })

  it("S35: the workspace root is found as Atelier finds it (first ancestor with .atelier/ or .git/)", () => {
    const root = workspace()
    const deep = path.join(root, "src", "lib")
    mkdirSync(deep, { recursive: true })
    expect(findWorkspaceRoot(deep)).toBe(root)
    const repo = realpathSync(mkdtempSync(path.join(scratch, "repo-")))
    mkdirSync(path.join(repo, ".git"))
    mkdirSync(path.join(repo, "pkg"))
    expect(findWorkspaceRoot(path.join(repo, "pkg"))).toBe(repo)
  })

  it("S35: a foreign sourceSessionId is ignored", () => {
    const root = workspace()
    writeState(root, "p1", fixture("state-valid.json", OTHER_ID))
    writeState(root, "p2", fixture("state-valid.json", ""))
    expect(readAtelierState(root, new Set([SDK_ID]))).toEqual({ state: null, invalid: [] })
  })

  it("S35: a symlinked state.json, a symlinked pipeline dir, and a path escaping the root are refused", () => {
    const outside = realpathSync(mkdtempSync(path.join(scratch, "outside-")))
    const target = path.join(outside, "state.json")
    writeFileSync(target, JSON.stringify(fixture("state-valid.json")))

    const fileLink = workspace()
    mkdirSync(path.join(fileLink, ".atelier", "pipelines", "p1"))
    symlinkSync(target, path.join(fileLink, ".atelier", "pipelines", "p1", "state.json"))
    expect(readAtelierState(fileLink, new Set([SDK_ID]))).toEqual({ state: null, invalid: [] })

    const dirLink = workspace()
    symlinkSync(outside, path.join(dirLink, ".atelier", "pipelines", "p1"))
    expect(readAtelierState(dirLink, new Set([SDK_ID]))).toEqual({ state: null, invalid: [] })

    // The pipelines folder itself leads out of the root.
    const escaping = realpathSync(mkdtempSync(path.join(scratch, "ws-")))
    mkdirSync(path.join(escaping, ".atelier"))
    mkdirSync(path.join(outside, "p1"))
    writeFileSync(
      path.join(outside, "p1", "state.json"),
      JSON.stringify(fixture("state-valid.json")),
    )
    symlinkSync(outside, path.join(escaping, ".atelier", "pipelines"))
    expect(readAtelierState(escaping, new Set([SDK_ID]))).toEqual({ state: null, invalid: [] })

    // The same content as a real file is read (the refusals above are the links).
    const plain = workspace()
    writeState(plain, "p1", fixture("state-valid.json"))
    expect(readAtelierState(plain, new Set([SDK_ID])).state?.id).toBe("p1")
  })

  it("S35: a 1 MB file is refused", () => {
    const root = workspace()
    const big = { ...fixture("state-valid.json"), padding: "x".repeat(1024 * 1024) }
    writeState(root, "p1", big)
    expect(readAtelierState(root, new Set([SDK_ID]))).toEqual({ state: null, invalid: [] })
  })

  it("S35: a javascript: and an http: board URL are dropped, an https one kept", () => {
    const root = workspace()
    writeState(root, "p1", fixture("state-hostile.json", SDK_ID, { failure: null }))
    expect(readAtelierState(root, new Set([SDK_ID])).state?.boards).toEqual([
      { title: "Kept", url: "https://example.com/board" },
    ])
  })

  it("S35: status 'paused' gives atelier_invalid", () => {
    const root = workspace()
    writeState(root, "p1", fixture("state-valid.json", SDK_ID, { status: "paused" }))
    writeState(root, "p2", fixture("state-valid.json", SDK_ID, { awaiting: "someone" }))
    // Not the session's: never reported, valid or not.
    writeState(root, "p3", fixture("state-valid.json", OTHER_ID, { status: "paused" }))
    const read = readAtelierState(root, new Set([SDK_ID]))
    expect(read.state).toBeNull()
    expect(read.invalid.sort()).toEqual(["p1", "p2"])
    // Unparsable JSON naming nobody cannot be attributed: ignored, not reported.
    const broken = workspace()
    writeState(broken, "p1", "{ not json")
    expect(readAtelierState(broken, new Set([SDK_ID]))).toEqual({ state: null, invalid: [] })
  })

  it("S35: a 10 kB failure.reason is clipped to 300", () => {
    const root = workspace()
    const reason = "r".repeat(10 * 1024)
    writeState(
      root,
      "p1",
      fixture("state-hostile.json", SDK_ID, {
        failure: { phase: "validate", reason, lastError: "x" },
        phase: "p".repeat(500),
        plan: Array.from({ length: 40 }, (_, i) => `${"s".repeat(100)}${i}`),
        boards: [{ title: "t".repeat(500), url: "https://example.com/b" }],
      }),
    )
    const state = readAtelierState(root, new Set([SDK_ID])).state
    expect(state?.status).toBe("failed")
    expect(state?.failureReason).toBe("r".repeat(300))
    expect(state?.phase).toHaveLength(40)
    expect(state?.plan).toHaveLength(12)
    expect(state?.plan.every((s) => s.length === 40)).toBe(true)
    expect(state?.boards?.[0]?.title).toHaveLength(80)
    expect(nodeSessionAtelierStateSchema.safeParse(state).success).toBe(true)
  })

  it("S35: two matching pipelines → the latest updatedAt", () => {
    const root = workspace()
    writeState(
      root,
      "older",
      fixture("state-valid.json", SDK_ID, { updatedAt: "2026-10-16T08:00:00Z" }),
    )
    writeState(
      root,
      "newer",
      fixture("state-valid.json", OTHER_ID, {
        updatedAt: "2026-10-16T10:00:00Z",
        phase: "validate",
      }),
    )
    writeState(
      root,
      "middle",
      fixture("state-valid.json", SDK_ID, { updatedAt: "2026-10-16T09:00:00Z" }),
    )
    const state = readAtelierState(root, new Set([SDK_ID, OTHER_ID])).state
    expect(state?.id).toBe("newer")
    expect(state?.phase).toBe("validate")
  })

  it("S35: with more than 200 pipelines the session's newest one is still read (newest state.json first)", () => {
    const root = workspace()
    const old = new Date("2026-01-01T00:00:00Z")
    for (let i = 0; i < 205; i++) {
      // Names that sort before the session's own, written long ago by another session.
      const file = writeState(
        root,
        `2026-01-01-p${String(i).padStart(3, "0")}`,
        fixture("state-valid.json", OTHER_ID),
      )
      utimesSync(file, old, old)
    }
    writeState(root, "2026-10-16-mine", fixture("state-valid.json", SDK_ID, { phase: "execute" }))
    const state = readAtelierState(root, new Set([SDK_ID])).state
    expect(state?.id).toBe("2026-10-16-mine")
    expect(state?.phase).toBe("execute")
  })

  it("S35: the trigger is a structural path test on the tool input", () => {
    expect(isAtelierStatePath("/w/.atelier/pipelines/p1/state.json")).toBe(true)
    expect(isAtelierStatePath("/w/.atelier/pipelines/p1/brief.md")).toBe(false)
    expect(isAtelierStatePath("/w/.atelier/pipelines/a/b/state.json")).toBe(false)
    expect(isAtelierStatePath(42)).toBe(false)
  })

  it("S35: the watch emits atelier once per distinct state and atelier_invalid once per file", () => {
    const root = workspace()
    const watch = new AtelierWatch(path.join(root))
    watch.ids.add(SDK_ID)
    expect(watch.check().events).toEqual([])
    writeState(root, "p1", fixture("state-valid.json"))
    const first = watch.check()
    expect(first.events.map((e) => e.subtype)).toEqual(["atelier"])
    expect(first.state?.phase).toBe("execute")
    expect(watch.check().events).toEqual([])
    expect(watch.check().state?.phase).toBe("execute")
    writeState(root, "p1", fixture("state-valid.json", SDK_ID, { phase: "validate" }))
    expect(watch.check().events.map((e) => e.data)).toEqual([
      expect.objectContaining({ id: "p1", phase: "validate" }),
    ])
    writeState(root, "p2", fixture("state-valid.json", SDK_ID, { status: "paused" }))
    expect(watch.check().events).toEqual([{ subtype: "atelier_invalid", data: { id: "p2" } }])
    expect(watch.check().events).toEqual([])
  })
})

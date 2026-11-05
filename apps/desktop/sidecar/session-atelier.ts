// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ATELIER STATE READER (P2-T08; S35, A12, spec §5.17).
//
// An owner session runs in the owner's folder (D13), where an Atelier run of
// this session writes `<root>/.atelier/pipelines/<id>/state.json`. The node
// reads it to show the phase stepper and to decide at the turn end (T09); it
// never writes it. The root is found as Atelier finds it (atelier-cc
// lib/common.sh `find_workspace_root`): the first ancestor of the session cwd
// holding a `.atelier/` or `.git/` directory.
//
// The file is hostile input: the folder may be anyone's repository and this
// reader runs unsandboxed in the sidecar. So every path is `lstat`ed (a
// symlinked pipeline dir or state file is skipped), its real path must stay
// under the root's, the file is opened without following links and capped at
// 64 KB, every string is clipped, `status` and `awaiting` are enum-checked, and
// a board URL is kept only when it is `https:`. Only a file whose
// `sourceSessionId` is one of this Liaison session's SDK session ids counts;
// of several, the latest `updatedAt` (§5.17). A matching file whose fields
// fail the checks is reported once as `atelier_invalid` and otherwise ignored.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs"
import path from "node:path"
import {
  type NodeSessionAtelierState,
  nodeSessionAtelierStateSchema,
} from "../../../packages/shared/src/node-session-protocol"

/** The largest `state.json` the reader opens (A12). */
export const ATELIER_STATE_MAX_BYTES = 64 * 1024
/** Pipelines looked at per read: a folder full of them is not a reason to stall a turn end. */
const MAX_PIPELINES = 200
const CLIP = { id: 80, rung: 8, step: 40, steps: 12, reason: 300, title: 80, boards: 8 } as const

/** A tool input's `file_path` names a pipeline's `state.json` (a path test, never text). */
export function isAtelierStatePath(filePath: unknown): boolean {
  return (
    typeof filePath === "string" && /\/\.atelier\/pipelines\/[^/]+\/state\.json$/.test(filePath)
  )
}

/** Atelier's `find_workspace_root`: the first ancestor with `.atelier/` or `.git/`, else `cwd`. */
export function findWorkspaceRoot(cwd: string): string {
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  let dir = path.resolve(cwd)
  for (;;) {
    if (isDir(path.join(dir, ".atelier")) || isDir(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

export interface AtelierRead {
  /** This session's pipeline (the latest `updatedAt` of the valid matches), or none. */
  state: NodeSessionAtelierState | null
  /** Pipelines of this session whose file failed the checks, by directory name. */
  invalid: string[]
}

/** Read this session's Atelier state under `root`, refusing anything hostile (A12). */
export function readAtelierState(root: string, sdkSessionIds: ReadonlySet<string>): AtelierRead {
  const none: AtelierRead = { state: null, invalid: [] }
  if (sdkSessionIds.size === 0) return none
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return none
  }
  const pipelines = path.join(root, ".atelier", "pipelines")
  let names: string[]
  try {
    if (!lstatSync(path.join(root, ".atelier")).isDirectory()) return none
    if (!lstatSync(pipelines).isDirectory()) return none
    names = newestFirst(pipelines, readdirSync(pipelines)).slice(0, MAX_PIPELINES)
  } catch {
    return none
  }
  const invalid: string[] = []
  let best: { state: NodeSessionAtelierState; at: number } | null = null
  for (const name of names) {
    const raw = readOne(realRoot, path.join(pipelines, name))
    if (raw === null) continue
    const owner = (raw as { sourceSessionId?: unknown }).sourceSessionId
    if (typeof owner !== "string" || !sdkSessionIds.has(owner)) continue
    const state = mapState(name, raw)
    if (!state) {
      invalid.push(name)
      continue
    }
    const at = Date.parse(String((raw as { updatedAt?: unknown }).updatedAt ?? ""))
    const time = Number.isFinite(at) ? at : 0
    if (!best || time > best.at) best = { state, at: time }
  }
  return { state: best?.state ?? null, invalid }
}

/**
 * Pipeline names, the most recently written `state.json` first (its mtime,
 * never following a link; none sorts last), so the cap never drops the
 * session's own, newest pipeline in a folder that holds many.
 */
function newestFirst(pipelines: string, names: string[]): string[] {
  const mtime = (name: string): number => {
    try {
      return lstatSync(path.join(pipelines, name, "state.json")).mtimeMs
    } catch {
      return Number.NEGATIVE_INFINITY
    }
  }
  return names
    .map((name) => ({ name, at: mtime(name) }))
    .sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => p.name)
}

/** One pipeline's parsed `state.json`, or null when it is absent, linked, outside, too big or not JSON. */
function readOne(realRoot: string, dir: string): unknown {
  const file = path.join(dir, "state.json")
  let fd: number | undefined
  try {
    if (!lstatSync(dir).isDirectory()) return null
    if (!lstatSync(file).isFile()) return null
    const real = realpathSync(file)
    if (!real.startsWith(realRoot + path.sep)) return null
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const size = fstatSync(fd).size
    if (size > ATELIER_STATE_MAX_BYTES) return null
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off)
      if (n <= 0) break
      off += n
    }
    const parsed = JSON.parse(buf.subarray(0, off).toString("utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** At most `n` UTF-16 units, never ending in half a surrogate pair. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

function steps(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) return null
  return (v as string[]).slice(0, CLIP.steps).map((s) => clip(s, CLIP.step))
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || !URL.canParse(v)) return null
  return new URL(v).protocol === "https:" ? v : null
}

/** The file's fields as the node reports them, or null when they fail the checks (S35). */
function mapState(id: string, raw: unknown): NodeSessionAtelierState | null {
  const r = raw as Record<string, unknown>
  const status = r.status
  if (status !== "running" && status !== "complete" && status !== "failed") return null
  const awaiting = r.awaiting ?? null
  if (awaiting !== null && awaiting !== "user" && awaiting !== "workflow") return null
  if (typeof r.rung !== "string" || typeof r.phase !== "string") return null
  const plan = steps(r.plan)
  const done = steps(r.done ?? [])
  if (!plan || !done) return null
  const failure = r.failure as { reason?: unknown } | null | undefined
  const reason =
    failure && typeof failure === "object" && typeof failure.reason === "string"
      ? clip(failure.reason, CLIP.reason)
      : undefined
  const boards = Array.isArray(r.boards)
    ? r.boards
        .flatMap((b) => {
          const board = b as { title?: unknown; url?: unknown } | null
          if (!board || typeof board !== "object" || typeof board.title !== "string") return []
          const url = httpsUrl(board.url)
          return url ? [{ title: clip(board.title, CLIP.title), url }] : []
        })
        .slice(0, CLIP.boards)
    : []
  const state: NodeSessionAtelierState = {
    id: clip(id, CLIP.id),
    rung: clip(r.rung, CLIP.rung),
    phase: clip(r.phase, CLIP.step),
    plan,
    done,
    status,
    awaiting,
    ...(reason !== undefined ? { failureReason: reason } : {}),
    ...(boards.length > 0 ? { boards } : {}),
  }
  // The shared schema is the contract the store parses with: a last check.
  return nodeSessionAtelierStateSchema.safeParse(state).success ? state : null
}

/** A `system` event the session emits for its Atelier state. */
export type AtelierEvent =
  | { subtype: "atelier"; data: NodeSessionAtelierState }
  | { subtype: "atelier_invalid"; data: { id: string } }

/**
 * One session's view of its Atelier state: the SDK session ids it has had
 * (every run's init, plus the one it resumed), and what it last reported, so
 * an unchanged state is not emitted twice and an invalid file once.
 */
export class AtelierWatch {
  readonly ids = new Set<string>()
  private readonly root: string
  private last: string | null = null
  private current: NodeSessionAtelierState | null = null
  private readonly reportedInvalid = new Set<string>()

  constructor(cwd: string) {
    this.root = findWorkspaceRoot(cwd)
  }

  /** The state as of the last check (T09's turn-end input). */
  get state(): NodeSessionAtelierState | null {
    return this.current
  }

  /** Read now; the events to emit (none when nothing changed). */
  check(): { state: NodeSessionAtelierState | null; events: AtelierEvent[] } {
    const read = readAtelierState(this.root, this.ids)
    const events: AtelierEvent[] = []
    for (const id of read.invalid) {
      if (this.reportedInvalid.has(id)) continue
      this.reportedInvalid.add(id)
      events.push({ subtype: "atelier_invalid", data: { id } })
    }
    this.current = read.state
    if (read.state) {
      const key = JSON.stringify(read.state)
      if (key !== this.last) {
        this.last = key
        events.push({ subtype: "atelier", data: read.state })
      }
    }
    return { state: read.state, events }
  }
}

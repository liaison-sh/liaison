// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE DRIVER AT A TIME (P1-T22; S51, owner D13, OPEN-3).
//
// An owner session runs in the real folder and writes its transcript to the
// owner's `~/.claude/projects/<slug>/<sdkSessionId>.jsonl` (S48, S49), so VS
// Code or a terminal can resume it while Liaison also holds it. Before the
// node resumes a run of such a session (D28: checked at run start), this says
// whether another Claude Code drives it. While it is ended and another Claude
// Code drives it, the shell's one follow host (follow-host.ts, D28 b, wave 3)
// polls this verdict every 10 s and tails the transcript read only.
//
// The signals, as the OPEN-3 probe measured them on macOS (CLI 2.1.286 and
// 2.1.296, a stream-json session like VS Code's, fresh then resumed):
//
// - registry: every running Claude Code writes `<config>/sessions/<pid>.json`
//   naming its `sessionId` (and its `entrypoint`: `claude-vscode`, `cli`,
//   `sdk-ts`...) and removes it when it exits, for a fresh session and a
//   resumed one alike. A crash can leave the file behind, so an entry counts
//   only while its pid is still a `claude` process in the process table.
//   D33 (batch-4 F3): an extension host restart leaves the old VS Code child
//   running with parent pid 1 (seen 2026-10-15), holding the entry and its
//   `--resume` argument with no editor behind it; so does `claude -p … &`
//   from a closed terminal. Such an orphan may still be mid-turn (a long tool
//   call writes nothing), so it still drives the session: the verdict names
//   it (`orphanPid`, `via` null) and the owner can stop it from the desktop
//   (the shell's `stop_orphan_claude`, which re-checks the pid), never
//   Liaison silently.
//   The node's own runs register in their per-session mirror config, never in
//   the owner's, so the owner's registry names only the others. W1-D3: that
//   mirror's registry is read too (`nodeConfigDir`). A runner killed outright
//   leaves its claude child running (parent pid 1) under the node's own
//   entrypoint, with no `--resume` in its arguments when it was the session's
//   first run, so neither the owner's registry nor the transcript names it; a
//   live claude registered there on this session id that is not this
//   process's own is the node's leftover: an orphan ("Stop it") when its
//   runner is gone, another live run otherwise. Never a second run beside it.
// - argv: a resumed session carries `--resume=<id>` in its arguments (VS
//   Code's extension and `claude --resume <id>` alike). A fresh session does
//   not name its id there, so this only backs the registry up.
// - recent write: the transcript's mtime is within 60 s and its last line
//   that names an `entrypoint` is not the node's (`liaison-node`, S49): VS
//   Code writes `claude-vscode`, a terminal `cli`, another SDK `sdk-*`. The
//   transcript says who wrote it, so a run that died before recording its own
//   write (a crash, an offline node) is not mistaken for another driver (F3).
//   Only a transcript whose tail names no entrypoint falls back to the node's
//   recorded last write. True for a while after the other side exits, which
//   is the safe side.
// - `lsof` on the transcript is never true: the CLI appends and closes, it
//   holds no descriptor (probe: empty while live, both binaries). Not used.
//
// Off macOS only the recent write counts (documented fallback): the registry
// and the argv form were measured on macOS only.

import { spawnSync } from "node:child_process"
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs"
import path from "node:path"
import type { NodeSessionDriver } from "../../../packages/shared/src/node-session-protocol"
import { selfCommand, startWatchdog } from "./claude-auth"
import { identityReader } from "./process-identity"
import { OWNER_SESSION_ENTRYPOINT } from "./session-config"

/** A transcript written this recently by someone else means it is driven elsewhere. */
export const DRIVER_RECENT_WRITE_MS = 60_000
/** The node's own write and the file's mtime may differ by this much (clock and flush). */
const OWN_WRITE_SLACK_MS = 2_000
/** How much of the transcript's end is read for its last entrypoint. */
const TAIL_BYTES = 256 * 1024

export interface DriverProbe {
  /** The transcript's mtime in ms, or null when it does not exist. */
  mtimeMs(file: string): number | null
  /**
   * The `entrypoint` of the transcript's last line that names one, or null
   * (F3). Absent: only the node's recorded last write tells its own write.
   */
  lastEntrypoint?(file: string): string | null
  /** The live Claude Code registry of a config dir (`<config>/sessions/<pid>.json`). */
  registry(configDir: string): RegistryEntry[]
  /**
   * The process table (pid, parent pid when known, full arguments), or null
   * where it is not read.
   */
  processes(): ProcessRow[] | null
  platform: string
}

export interface ProcessRow {
  pid: number
  /** The parent pid; 1 (launchd) means the process was orphaned. */
  ppid?: number
  args: string
}

export interface RegistryEntry {
  pid: number
  sessionId: string
  entrypoint: string | null
}

export interface DriverCheck {
  /** `<owner config>/projects/<slug>/<sdkSessionId>.jsonl`. */
  jsonl: string
  /** The CLI's session id (Liaison's sdkSessionId), never Liaison's session id. */
  sessionId: string
  /** The owner's Claude config dir, whose registry names the other drivers. */
  configDir: string
  /**
   * W1-D3: the node's own per-session config dir (its runs register there).
   * A live claude registered there on this session id, not in `ownPids`, is a
   * leftover of an earlier run of this node.
   */
  nodeConfigDir?: string
  /** The node's own Claude processes: never another driver. */
  ownPids: ReadonlySet<number>
  /** When the node's own run last wrote the transcript (ms), or null. */
  ownLastWriteMs: number | null
  now: number
}

export interface DriverVerdict {
  elsewhere: boolean
  signal: "registry" | "argv" | "recent_write" | null
  via: NodeSessionDriver | null
  /** D33: the driver is an orphaned claude (parent launchd), this pid. */
  orphanPid?: number
}

const NOT_DRIVEN: DriverVerdict = { elsewhere: false, signal: null, via: null }

/** The registry entries of a config dir; an unreadable entry, a `.key` or `.lock` file is skipped. */
export function liveRegistry(configDir: string): RegistryEntry[] {
  const dir = path.join(configDir, "sessions")
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: RegistryEntry[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
        pid?: unknown
        sessionId?: unknown
        entrypoint?: unknown
      }
      if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") continue
      out.push({
        pid: raw.pid,
        sessionId: raw.sessionId,
        entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : null,
      })
    } catch {
      // Half written or gone between the listing and the read: not an entry.
    }
  }
  return out
}

function psTable(): ProcessRow[] | null {
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,args="], {
    encoding: "utf8",
    timeout: 5_000,
  })
  if (ps.status !== 0 || typeof ps.stdout !== "string") return null
  const out: ProcessRow[] = []
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] as string })
  }
  return out
}

export function systemDriverProbe(): DriverProbe {
  return {
    mtimeMs: (file) => {
      try {
        return statSync(file).mtimeMs
      } catch {
        return null
      }
    },
    registry: liveRegistry,
    lastEntrypoint,
    processes: () => (process.platform === "win32" ? null : psTable()),
    platform: process.platform,
  }
}

/**
 * The `entrypoint` of the last line in the transcript's tail that carries one
 * (the CLI's bookkeeping lines, `last-prompt`, `cost-state`..., carry none).
 * Reads only the end of the file; a line cut by the tail's start is skipped.
 */
export function lastEntrypoint(file: string): string | null {
  let text: string
  try {
    // Sized through the open descriptor: the file measured is the file read.
    const fd = openSync(file, "r")
    let got: number
    let start: number
    let buf: Buffer
    try {
      const size = fstatSync(fd).size
      start = Math.max(0, size - TAIL_BYTES)
      buf = Buffer.alloc(size - start)
      got = readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    text = buf.toString("utf8", 0, got)
    if (start > 0) text = text.slice(text.indexOf("\n") + 1)
  } catch {
    return null
  }
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!line.includes('"entrypoint"')) continue
    try {
      const entrypoint = (JSON.parse(line) as { entrypoint?: unknown }).entrypoint
      if (typeof entrypoint === "string") return entrypoint
    } catch {
      // A partial last line (still being written): look further up.
    }
  }
  return null
}

const isClaude = (args: string) => /claude/i.test(args)
/** Reparented to launchd: an orphaned extension child or a terminal's leftover. */
const isOrphan = (p: ProcessRow) => p.ppid === 1
const viaOfArgs = (args: string): NodeSessionDriver =>
  /[/\\]\.vscode[^/\\]*[/\\]extensions[/\\]|anthropic\.claude-code-/.test(args) ? "vscode" : "cli"
function viaOfEntrypoint(entrypoint: string | null): NodeSessionDriver | null {
  if (entrypoint === "claude-vscode") return "vscode"
  if (entrypoint === "cli") return "cli"
  return null
}

function namesSession(args: string, id: string): boolean {
  // Every pattern character escaped, whatever the id's validation allowed.
  const escaped = id.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")
  return new RegExp(`(?:^|\\s)(?:--resume[= ]|-r |--session-id[= ])${escaped}(?:\\s|$)`).test(args)
}

/** Whether another Claude Code drives the session now (S51). Reads only, never writes. */
export function drivenElsewhere(
  check: DriverCheck,
  probe: DriverProbe = systemDriverProbe(),
): DriverVerdict {
  if (probe.platform === "darwin") {
    const table = probe.processes()
    if (table) {
      const byPid = new Map(table.map((p) => [p.pid, p]))
      for (const entry of probe.registry(check.configDir)) {
        if (entry.sessionId !== check.sessionId || check.ownPids.has(entry.pid)) continue
        const proc = byPid.get(entry.pid)
        // A crash leaves the entry: only a pid that is still a claude counts.
        if (proc === undefined || !isClaude(proc.args)) continue
        // D33: an orphan still holds it; who it was no longer says anything.
        if (isOrphan(proc)) {
          return { elsewhere: true, signal: "registry", via: null, orphanPid: proc.pid }
        }
        return {
          elsewhere: true,
          signal: "registry",
          via: viaOfEntrypoint(entry.entrypoint) ?? viaOfArgs(proc.args),
        }
      }
      // W1-D3: the node's own earlier run, still alive under its mirror config.
      if (check.nodeConfigDir && check.nodeConfigDir !== check.configDir) {
        for (const entry of probe.registry(check.nodeConfigDir)) {
          if (entry.sessionId !== check.sessionId || check.ownPids.has(entry.pid)) continue
          const proc = byPid.get(entry.pid)
          if (proc === undefined || !isClaude(proc.args)) continue
          if (isOrphan(proc)) {
            return { elsewhere: true, signal: "registry", via: null, orphanPid: proc.pid }
          }
          return { elsewhere: true, signal: "registry", via: null }
        }
      }
      for (const p of table) {
        if (check.ownPids.has(p.pid) || !isClaude(p.args)) continue
        if (!namesSession(p.args, check.sessionId)) continue
        if (isOrphan(p)) return { elsewhere: true, signal: "argv", via: null, orphanPid: p.pid }
        return { elsewhere: true, signal: "argv", via: viaOfArgs(p.args) }
      }
    }
  }
  const mtime = probe.mtimeMs(check.jsonl)
  if (mtime === null || check.now - mtime > DRIVER_RECENT_WRITE_MS) return NOT_DRIVEN
  // F3: the transcript names who wrote it last; the node's record is the fallback.
  const entrypoint = probe.lastEntrypoint?.(check.jsonl) ?? null
  if (entrypoint === OWNER_SESSION_ENTRYPOINT) return NOT_DRIVEN
  if (entrypoint !== null) {
    return { elsewhere: true, signal: "recent_write", via: viaOfEntrypoint(entrypoint) }
  }
  if (check.ownLastWriteMs !== null && mtime <= check.ownLastWriteMs + OWN_WRITE_SLACK_MS)
    return NOT_DRIVEN
  return { elsewhere: true, signal: "recent_write", via: null }
}

/**
 * W1-D3: the claude processes THIS process started for the session, read from
 * the session's own config dir registry (the CLI registers on start) and tied
 * to it by parent pid. Empty where the process table is not read (Windows).
 */
export function ownClaudeChildren(
  configDir: string,
  sessionId: string,
  parentPid: number = process.pid,
  probe: DriverProbe = systemDriverProbe(),
): number[] {
  const table = probe.processes()
  if (!table) return []
  const byPid = new Map(table.map((p) => [p.pid, p]))
  const out: number[] = []
  for (const entry of probe.registry(configDir)) {
    if (entry.sessionId !== sessionId) continue
    const proc = byPid.get(entry.pid)
    if (proc && proc.ppid === parentPid && isClaude(proc.args)) out.push(proc.pid)
  }
  return out
}

/** A run's watchdog ends its claude once the runner is gone; the ceiling only bounds the watchdog. */
export const RUN_WATCHDOG_CEILING_MS = 365 * 24 * 3_600_000

/**
 * W1-D3: the node's claude dies with its runner. The SDK spawns the CLI as a
 * plain child, so a runner killed outright (the shell's kill after its grace,
 * a crash, a force quit) used to leave it running with parent pid 1, mid-turn,
 * still holding the session. Each claude this process started for the session
 * gets the sign-in's watchdog (claude-auth.ts: this binary again, detached,
 * naming both processes by pid AND start time), which ends the CLI the moment
 * the runner is gone and ends itself when the CLI exits. Nothing changes while
 * the runner lives: a page reload, a level restart or a normal end never
 * touch it (the runner itself ends its claude then). Answers the claude pids
 * found (watched before or now).
 */
export function guardOwnClaude(
  configDir: string,
  sessionId: string,
  watched: Set<number>,
  deps: {
    children?: (configDir: string, sessionId: string) => number[]
    /** This binary's own command line (claude-auth.ts `selfCommand`). */
    command?: readonly string[]
  } = {},
): number[] {
  const found = (deps.children ?? ((dir, id) => ownClaudeChildren(dir, id)))(configDir, sessionId)
  const command = deps.command ?? selfCommand()
  // Only the sidecar itself answers a watchdog call: compiled, or `bun index.ts`
  // (never a test file run by `bun test`).
  const self = command.length === 1 || path.basename(command[1] ?? "") === "index.ts"
  const start = (pid: number) =>
    self && startWatchdog(command, process.pid, pid, identityReader(), RUN_WATCHDOG_CEILING_MS)
  for (const pid of found) {
    if (watched.has(pid)) continue
    watched.add(pid)
    start(pid)
  }
  return found
}

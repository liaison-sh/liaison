// SPDX-License-Identifier: FSL-1.1-ALv2
//
// STEERING COMMANDS, DELIVERED TO THE LIVE SESSIONS OF THIS COMPUTER (P3-T13;
// C5, D36, spec-protocol.md "Commands").
//
// The owner's commands (a message, Stop, a permission decision, an answer, a
// model) are stored on the server in order. This node pulls the unacked ones
// of its current runs and writes each, once per page life and in seq order,
// to its session's stdin through the shell (`node_session_write`, the only way
// a line reaches a session). The sidecar records each id before applying it,
// so a line written again after a page reload is applied once (T05); the
// server acks a command only from the sidecar's `command_applied`.
//
// A pull happens on a wake (the server's `node_session_command` frame), after
// each run starts, on each reconnect, and every 30 s while a run is live, so a
// dropped wake is healed.

import {
  commandLine,
  type NodeSessionCommand,
  nodeSessionCommandSchema,
} from "@liaison/shared/node-session-protocol"
import type { Clock } from "./runner"

/** How often commands are pulled while a session runs here (a dropped wake heals). */
export const COMMAND_PULL_MS = 30_000

/** One unacked command, as `GET /api/node/sessions/commands?unacked=1` answers it. */
export interface PulledCommand {
  commandId: string
  sessionId: string
  jobId: string
  seq: number
  type: string
  payload: unknown
}

export interface CommandDeliveryOptions {
  /** The node's unacked commands for its current runs, in (session, seq) order. */
  pull: () => Promise<PulledCommand[]>
  /** One line to one session's stdin; false when it has no live run here. */
  write: (sessionId: string, line: string) => Promise<boolean>
  /** The sessions running here now: session id to its run's job id. */
  live: () => ReadonlyMap<string, string>
  clock: Clock
  log?: (message: string, detail?: unknown) => void
  /** A command reached its session's stdin (the runner keeps a level raise's confirmation, T24). */
  onWritten?: (command: PulledCommand & { command: NodeSessionCommand }) => void
}

export interface CommandDelivery {
  /** Pulls now and writes what is new. Calls made while a pull runs are folded into one more. */
  pull(): Promise<void>
  /** The set of live runs changed: the 30 s timer runs only while one is live. */
  runsChanged(): void
  /**
   * The session's process was replaced (a level restart, D34): what it had
   * not applied is written again to the new one (the sidecar's applied log
   * keeps an applied command from being applied twice).
   */
  forget(sessionId: string): void
  stop(): void
}

export function createCommandDelivery(options: CommandDeliveryOptions): CommandDelivery {
  const log = options.log ?? (() => {})
  /**
   * Command ids already written to each session's current process in this
   * page's life. A new run (another job) or a replaced process starts afresh.
   */
  const written = new Map<string, { jobId: string; ids: Set<string> }>()
  const writtenTo = (sessionId: string, jobId: string): Set<string> => {
    const held = written.get(sessionId)
    if (held && held.jobId === jobId) return held.ids
    const ids = new Set<string>()
    written.set(sessionId, { jobId, ids })
    return ids
  }
  let running: Promise<void> | null = null
  let again = false
  let timer: (() => void) | null = null
  let stopped = false

  async function once(): Promise<void> {
    let commands: PulledCommand[]
    try {
      commands = await options.pull()
    } catch (error) {
      log("node session commands not pulled", error)
      return
    }
    const live = options.live()
    const ordered = [...commands].sort((a, b) =>
      a.sessionId === b.sessionId ? a.seq - b.seq : a.sessionId < b.sessionId ? -1 : 1,
    )
    /** A session whose write failed gets nothing after it this pull: order is kept. */
    const halted = new Set<string>()
    for (const command of ordered) {
      if (halted.has(command.sessionId)) continue
      // Only a session running here, in the very run the server pulled it for.
      if (live.get(command.sessionId) !== command.jobId) continue
      const sent = writtenTo(command.sessionId, command.jobId)
      if (sent.has(command.commandId)) continue
      const parsed = nodeSessionCommandSchema.safeParse({
        type: command.type,
        payload: command.payload,
      })
      if (!parsed.success || !Number.isInteger(command.seq) || command.seq < 1) {
        log("node session command refused (malformed)", command.commandId)
        continue
      }
      const line = commandLine({
        type: "command",
        commandId: command.commandId,
        seq: command.seq,
        command: parsed.data as NodeSessionCommand,
      })
      try {
        if (await options.write(command.sessionId, line)) {
          sent.add(command.commandId)
          options.onWritten?.({ ...command, command: parsed.data as NodeSessionCommand })
        } else {
          halted.add(command.sessionId)
        }
      } catch (error) {
        log("node session command not written", error)
        halted.add(command.sessionId)
      }
    }
  }

  function pull(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await once()
      } while (again && !stopped)
    })().finally(() => {
      running = null
    })
    return running
  }

  function runsChanged(): void {
    if (stopped) return
    const anyLive = options.live().size > 0
    if (anyLive && !timer) {
      timer = options.clock.every(COMMAND_PULL_MS, () => {
        void pull()
      })
    } else if (!anyLive && timer) {
      timer()
      timer = null
    }
  }

  return {
    pull,
    runsChanged,
    forget: (sessionId) => {
      written.delete(sessionId)
    },
    stop: () => {
      stopped = true
      timer?.()
      timer = null
    },
  }
}

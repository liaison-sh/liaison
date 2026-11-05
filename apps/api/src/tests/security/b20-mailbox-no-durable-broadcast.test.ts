// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-13, static half. Nothing in the mailbox flow may put mail content into a
// DURABLE broadcast.
//
// `bufferAndBroadcast` is the WS fan-out that also writes into the late-joiner
// replay buffer, so a payload handed to it survives the turn and can be read by
// a socket that joins afterwards. The mailbox modules are allowed to broadcast
// ephemerally (`broadcastEphemeral` explicitly does not write to the outbox) and
// they are allowed to emit ids, but a `bufferAndBroadcast` call inside them is a
// design error rather than a bug to be reviewed case by case.
//
// The dynamic half of T-SEC-13 (a real turn, a real Redis SCAN, a real registry
// snapshot) lives in `b19-mailbox-control-plane-clean.test.ts`. This file is the
// cheap always-on guard that keeps the property from being reopened by a file
// that no dynamic test happens to exercise.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const API_SRC = path.resolve(import.meta.dir, "../..")

/** Directories whose files carry the mailbox flow. */
const MAILBOX_DIRS = [
  path.join(API_SRC, "modules", "mailbox-crypto"),
  path.join(API_SRC, "modules", "mail"),
  path.join(API_SRC, "apps", "mail"),
]

/** Individual mailbox files that live outside those directories. */
const MAILBOX_FILES = [
  path.join(API_SRC, "modules", "agent", "mailbox-plaintext", "mail-plaintext-redaction.ts"),
]

function collectSourceFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full))
      continue
    }
    if (!entry.endsWith(".ts")) continue
    if (entry.endsWith(".test.ts")) continue
    out.push(full)
  }
  return out
}

describe("T-SEC-13 (static): no durable broadcast from the mailbox flow", () => {
  const files = [...MAILBOX_DIRS.flatMap(collectSourceFiles), ...MAILBOX_FILES]

  it("non-vacuity: the scan actually covers the mailbox source files", () => {
    // A scan over an empty file list reports "no offenders" forever. Both the
    // count and one known member are asserted, so a moved directory fails here
    // instead of silently disarming the guard.
    expect(files.length).toBeGreaterThan(10)
    expect(
      files.some((f) => f.endsWith(path.join("modules", "mailbox-crypto", "seal-service.ts"))),
    ).toBe(true)
    expect(files.some((f) => f.endsWith(path.join("apps", "mail", "handlers.ts")))).toBe(true)
    expect(
      files.some((f) =>
        f.endsWith(
          path.join("modules", "agent", "mailbox-plaintext", "mail-plaintext-redaction.ts"),
        ),
      ),
    ).toBe(true)
  })

  it("no mailbox source file calls bufferAndBroadcast", () => {
    const offenders = files.filter((f) => /\bbufferAndBroadcast\b/.test(readFileSync(f, "utf8")))
    expect(offenders.map((f) => path.relative(API_SRC, f))).toEqual([])
  })

  it("the redaction module is imported by the agent stream loop", () => {
    // The closure that keeps Task 6.6 from being dead code: the predicate exists
    // AND the site that persists tool results calls it.
    const agentService = readFileSync(
      path.join(API_SRC, "modules", "agent", "runtime", "agent-service.ts"),
      "utf8",
    )
    expect(agentService).toContain("redactMailToolResult")
    expect(agentService).toContain("mail-plaintext-redaction")
  })
})

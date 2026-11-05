// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison mailbox purge`, the operator command for spec section 7 step 7.
//
// This is the only invocation path for the most destructive operation in the
// product, so its tests are about how hard it is to fire by accident:
//
//   * both ids are explicit, and there is no "all users" form,
//   * a run is a DRY RUN unless `--execute` is passed,
//   * `--execute` also needs `--confirm <the same user id>` typed out,
//   * a refusal from the acknowledgement gate is a non-zero exit and destroys
//     nothing,
//   * there is no cron and no schedule anywhere near it.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseMailboxPurgeArgv, runMailboxPurgeCli } from "~/cli/mailbox-purge"
import { MailboxAckError } from "~/modules/mailbox-crypto/ack-verify"

const USER = "11111111-1111-4111-8111-111111111111"
const ORG = "22222222-2222-4222-8222-222222222222"

function quiet(): { out: string[]; err: string[] } {
  return { out: [], err: [] }
}

function deps(overrides: Parameters<typeof runMailboxPurgeCli>[1] = {}) {
  return {
    inspect: async () => ({
      messagesWithPlaintext: 12,
      conversationsWithPlaintext: 1,
      draftsWithPlaintext: 1,
      headersToReduce: 12,
      gate: "passed" as const,
    }),
    ...overrides,
  }
}

describe("liaison mailbox purge", () => {
  test("refuses without an explicit user and org", async () => {
    expect(parseMailboxPurgeArgv([]).ok).toBe(false)
    expect(parseMailboxPurgeArgv(["--user", USER]).ok).toBe(false)
    expect(parseMailboxPurgeArgv(["--org", ORG]).ok).toBe(false)
    expect(parseMailboxPurgeArgv(["--user", "not-a-uuid", "--org", ORG]).ok).toBe(false)
    expect(parseMailboxPurgeArgv(["--user", USER, "--org", ORG]).ok).toBe(true)
  })

  test("has no all-users or all-orgs form", () => {
    const source = readFileSync(path.resolve(import.meta.dir, "mailbox-purge.ts"), "utf8")
    expect(source).not.toContain("--all")
    // A schedule would make this fire without a person. There must be none.
    expect(source).not.toMatch(/registerScheduledJob|cron|schedule\(/i)
  })

  test("a run without --execute is a dry run and calls the purge zero times", async () => {
    let purgeCalls = 0
    const io = quiet()
    const code = await runMailboxPurgeCli(
      ["--user", USER, "--org", ORG],
      deps({
        purge: async () => {
          purgeCalls++
          throw new Error("the dry run must never reach the purge")
        },
        write: (line: string) => io.out.push(line),
        writeErr: (line: string) => io.err.push(line),
      }),
    )
    expect(code).toBe(0)
    expect(purgeCalls).toBe(0)
    expect(io.out.join("")).toContain("dryRun")
    expect(io.err.join(" ")).toMatch(/dry run/i)
  })

  test("--execute without a matching --confirm refuses and calls the purge zero times", async () => {
    let purgeCalls = 0
    const io = quiet()
    const code = await runMailboxPurgeCli(
      ["--user", USER, "--org", ORG, "--execute"],
      deps({
        purge: async () => {
          purgeCalls++
          return {} as never
        },
        write: (line: string) => io.out.push(line),
        writeErr: (line: string) => io.err.push(line),
      }),
    )
    expect(code).toBe(2)
    expect(purgeCalls).toBe(0)

    const wrong = await runMailboxPurgeCli(
      ["--user", USER, "--org", ORG, "--execute", "--confirm", ORG],
      deps({
        purge: async () => {
          purgeCalls++
          return {} as never
        },
        write: () => {},
        writeErr: () => {},
      }),
    )
    expect(wrong).toBe(2)
    expect(purgeCalls).toBe(0)
  })

  test("--execute with a matching --confirm runs the purge once, for that one user", async () => {
    const calls: Array<{ userId: string; orgId: string }> = []
    const io = quiet()
    const code = await runMailboxPurgeCli(
      ["--user", USER, "--org", ORG, "--execute", "--confirm", USER],
      deps({
        purge: async (userId: string, orgId: string) => {
          calls.push({ userId, orgId })
          return {
            userId,
            orgId,
            messagesPurged: 12,
            conversationsPurged: 1,
            draftsPurged: 1,
            headersReduced: 12,
            derivativesCleared: 0,
            searchDocumentsDeleted: 0,
            plaintextPurgedAt: new Date("2026-08-28T00:00:00.000Z"),
            plaintextPurgeRanAt: new Date("2026-08-28T00:00:00.000Z"),
            remainingPlaintext: {
              messages: 0,
              conversations: 0,
              drafts: 0,
              messagesWithNonAllowlistedHeaders: 0,
            },
            backupsClearAfter: new Date("2026-09-13T00:00:00.000Z"),
            backupClearance: null,
            alreadyPurged: false,
            unsealedAttachments: 0,
            cutoverComplete: true,
          } as never
        },
        write: (line: string) => io.out.push(line),
        writeErr: (line: string) => io.err.push(line),
      }),
    )
    expect(code).toBe(0)
    expect(calls).toEqual([{ userId: USER, orgId: ORG }])
    expect(io.out.join("")).toContain("messagesPurged")
    // Loud: the operator sees what is about to happen and what happened.
    expect(io.err.join(" ")).toMatch(/irreversible/i)
    // And the honest witness: what is STILL readable, not just a flag.
    expect(io.err.join(" ")).toMatch(/still readable after this run/i)
  })

  test("an incomplete cutover says the destruction happened and warns against reading the NULL", async () => {
    // The dangerous misreading: `plaintext_purged_at IS NULL` on a mailbox
    // whose every body has just been destroyed, because historical attachment
    // bytes are unsealed and the cutover cannot be declared complete.
    const io = quiet()
    const code = await runMailboxPurgeCli(
      ["--user", USER, "--org", ORG, "--execute", "--confirm", USER],
      deps({
        purge: async (userId: string, orgId: string) =>
          ({
            userId,
            orgId,
            messagesPurged: 12,
            conversationsPurged: 1,
            draftsPurged: 1,
            headersReduced: 12,
            derivativesCleared: 0,
            searchDocumentsDeleted: 0,
            plaintextPurgedAt: new Date("2026-08-28T00:00:00.000Z"),
            plaintextPurgeRanAt: new Date("2026-08-28T00:00:00.000Z"),
            remainingPlaintext: {
              messages: 0,
              conversations: 0,
              drafts: 0,
              messagesWithNonAllowlistedHeaders: 0,
            },
            backupsClearAfter: new Date("2026-09-13T00:00:00.000Z"),
            backupClearance: null,
            alreadyPurged: false,
            unsealedAttachments: 3,
            cutoverComplete: false,
          }) as never,
        write: (line: string) => io.out.push(line),
        writeErr: (line: string) => io.err.push(line),
      }),
    )
    expect(code).toBe(0)
    const err = io.err.join(" ")
    expect(err).toMatch(/irreversible/i)
    expect(err).toContain("plaintext_purge_ran_at")
    expect(err).toMatch(/do not read the null as/i)
  })

  test("a refusal from the acknowledgement gate exits non-zero and names the code", async () => {
    const io = quiet()
    const code = await runMailboxPurgeCli(
      ["--user", USER, "--org", ORG, "--execute", "--confirm", USER],
      deps({
        purge: async () => {
          throw new MailboxAckError("NO_NONCE_ISSUED", "no client acknowledgement is on file")
        },
        write: (line: string) => io.out.push(line),
        writeErr: (line: string) => io.err.push(line),
      }),
    )
    expect(code).toBe(1)
    expect(io.err.join(" ")).toContain("NO_NONCE_ISSUED")
    expect(io.err.join(" ")).toMatch(/nothing was destroyed/i)
  })

  test("the dry run reports a gate refusal instead of pretending the purge would work", async () => {
    const io = quiet()
    const code = await runMailboxPurgeCli(
      ["--user", USER, "--org", ORG],
      deps({
        inspect: async () => {
          throw new MailboxAckError("DIGEST_MISMATCH", "the ack does not cover these rows")
        },
        write: (line: string) => io.out.push(line),
        writeErr: (line: string) => io.err.push(line),
      }),
    )
    expect(code).toBe(1)
    expect(io.err.join(" ")).toContain("DIGEST_MISMATCH")
  })

  test("a drizzle-wrapped query failure surfaces the POSTGRES cause, not just `Failed query:`", async () => {
    // The operator reads this output at the most dangerous moment in the whole
    // feature. Drizzle wraps the driver error, so printing only `error.stack`
    // showed `Failed query: UPDATE ...` with no reason at all: not the message,
    // not the SQLSTATE, not the detail. Whether the purge stopped because a
    // column is missing or because a value is malformed decides what the
    // operator does next, and it must not require a log dive.
    const pg = Object.assign(new Error("cannot call jsonb_object_keys on a scalar"), {
      code: "22023",
      detail: "the value was a JSON string",
      routine: "jsonb_object_keys",
    })
    const wrapped = new Error("Failed query: UPDATE app_mail.messages SET raw_headers = ...", {
      cause: pg,
    })

    for (const argv of [
      ["--user", USER, "--org", ORG],
      ["--user", USER, "--org", ORG, "--execute", "--confirm", USER],
    ]) {
      const io = quiet()
      const code = await runMailboxPurgeCli(
        argv,
        deps({
          inspect: async () => {
            throw wrapped
          },
          purge: async () => {
            throw wrapped
          },
          write: (line: string) => io.out.push(line),
          writeErr: (line: string) => io.err.push(line),
        }),
      )
      expect(code).toBe(1)
      const err = io.err.join(" ")
      // Non-vacuity: the wrapper's own message is still there.
      expect(err).toContain("Failed query")
      expect(err).toContain("cannot call jsonb_object_keys on a scalar")
      expect(err).toContain("22023")
      expect(err).toContain("the value was a JSON string")
    }
  })

  test("the CLI dispatch offers it under `liaison mailbox`", () => {
    // index.ts is the entry; the subcommand dispatch lives in main.ts.
    const source = readFileSync(path.resolve(import.meta.dir, "main.ts"), "utf8")
    expect(source).toContain("runMailboxPurgeCli")
    expect(source).toContain("mailbox purge")
  })
})

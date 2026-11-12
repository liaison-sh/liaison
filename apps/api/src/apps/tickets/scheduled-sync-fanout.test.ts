// SPDX-License-Identifier: FSL-1.1-ALv2
// The tickets scheduled sync/renewal crons fire payload-less. Before the fan-out
// they no-op'd, so the Gmail push watch was NEVER renewed (it expires ~7 days after
// each connect -> push silently dies) and nothing polled to backfill a missed push.
// These tests pin that a payload-less tick now enumerates the org's connected
// mailboxes and enqueues one per-account job (with a stable jobId), while a tick that
// already carries a connectedAccountId runs the per-account sync directly.
import { describe, expect, it } from "bun:test"
import * as handlers from "~/apps/tickets/handlers"

type Handler = (payload: any, ctx: any) => Promise<any>

const ticketsGmailIncrementalSync = handlers.ticketsGmailIncrementalSync as Handler
const ticketsGmailWatchRenewal = handlers.ticketsGmailWatchRenewal as Handler
const ticketsImapIncrementalSync = handlers.ticketsImapIncrementalSync as Handler

function makeCtx(accounts: Array<{ connectedAccountId: string; provider: string }>) {
  const enqueued: Array<{ jobName: string; payload: any; opts: any }> = []
  const runSyncCalls: Array<{ jobName: string; cid: string }> = []
  const ctx = {
    tickets_listSyncableAccounts: async () => JSON.stringify(accounts),
    tickets_runSync: async (jobName: string, cid: string) => {
      runSyncCalls.push({ jobName, cid })
      return JSON.stringify({ processed: 0 })
    },
    enqueueJob: async (jobName: string, payloadJson: string, optsJson?: string) => {
      enqueued.push({
        jobName,
        payload: JSON.parse(payloadJson),
        opts: optsJson ? JSON.parse(optsJson) : undefined,
      })
    },
    log_info: () => {},
  }
  return { ctx, enqueued, runSyncCalls }
}

describe("tickets scheduled sync fan-out", () => {
  it("gmail-incremental: payload-less tick fans out one job per gmail mailbox", async () => {
    const { ctx, enqueued, runSyncCalls } = makeCtx([
      { connectedAccountId: "ca_gmail_1", provider: "gmail" },
      { connectedAccountId: "ca_gmail_2", provider: "gmail" },
      { connectedAccountId: "ca_imap_1", provider: "imap" }, // wrong provider, skipped
    ])
    const res = await ticketsGmailIncrementalSync(undefined, ctx)
    expect(res).toMatchObject({ fannedOut: 2 })
    expect(runSyncCalls).toHaveLength(0) // fan-out enqueues, does not sync inline
    expect(enqueued.map((e) => e.payload.connectedAccountId).sort()).toEqual([
      "ca_gmail_1",
      "ca_gmail_2",
    ])
    for (const e of enqueued) {
      expect(e.jobName).toBe("gmail-incremental-sync")
      // No stable jobId on a recurring job (would make it run once and never again).
      expect(e.opts).toBeUndefined()
    }
  })

  it("gmail-watch-renewal: payload-less tick renews every active gmail mailbox (the 7-day-expiry fix)", async () => {
    const { ctx, enqueued } = makeCtx([{ connectedAccountId: "ca_gmail_1", provider: "gmail" }])
    const res = await ticketsGmailWatchRenewal(undefined, ctx)
    expect(res).toMatchObject({ fannedOut: 1 })
    expect(enqueued[0]).toMatchObject({
      jobName: "gmail-watch-renewal",
      payload: { connectedAccountId: "ca_gmail_1" },
    })
    expect(enqueued[0].opts).toBeUndefined()
  })

  it("imap-incremental: fans out only imap mailboxes", async () => {
    const { ctx, enqueued } = makeCtx([
      { connectedAccountId: "ca_gmail_1", provider: "gmail" },
      { connectedAccountId: "ca_imap_1", provider: "imap" },
    ])
    const res = await ticketsImapIncrementalSync(undefined, ctx)
    expect(res).toMatchObject({ fannedOut: 1 })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].payload.connectedAccountId).toBe("ca_imap_1")
    expect(enqueued[0].jobName).toBe("imap-incremental-sync")
  })

  it("a tick that carries a connectedAccountId runs the per-account sync directly (no fan-out)", async () => {
    const { ctx, enqueued, runSyncCalls } = makeCtx([])
    await ticketsGmailIncrementalSync({ connectedAccountId: "ca_gmail_9" }, ctx)
    expect(enqueued).toHaveLength(0)
    expect(runSyncCalls).toEqual([{ jobName: "gmail-incremental-sync", cid: "ca_gmail_9" }])
  })

  it("no connected mailboxes -> fans out nothing (clean no-op)", async () => {
    const { ctx, enqueued } = makeCtx([])
    const res = await ticketsGmailIncrementalSync(undefined, ctx)
    expect(res).toMatchObject({ fannedOut: 0 })
    expect(enqueued).toHaveLength(0)
  })

  it("an unrecognised provider is skipped, never treated as gmail", async () => {
    // Observed live 2026-07-28: a mailbox inbox backed by an 'smtp-sink'
    // account was handed to the GMAIL fan-out, because the bridge mapped
    // anything that was not 'imap' to 'gmail'. Every cycle then logged
    // "No connected account for connection gmail" and a permanent
    // `no_cursor`, for an account that simply is not a Gmail mailbox.
    //
    // The bridge now filters these out in SQL; this pins the second line of
    // defence, so a new connection type can never be silently swept into the
    // wrong sync.
    const { ctx, enqueued } = makeCtx([
      { connectedAccountId: "ca_gmail_1", provider: "gmail" },
      { connectedAccountId: "ca_sink", provider: "smtp-sink" },
      { connectedAccountId: "ca_unknown", provider: "" },
    ])
    const res = await ticketsGmailIncrementalSync(undefined, ctx)
    expect(res).toMatchObject({ fannedOut: 1 })
    expect(enqueued.map((e) => e.payload.connectedAccountId)).toEqual(["ca_gmail_1"])
  })

  it("an account-enumeration failure does not throw on the cron tick (no BullMQ retry storm)", async () => {
    const ctx = {
      tickets_listSyncableAccounts: async () => {
        throw new Error("db down")
      },
      enqueueJob: async () => {},
      log_info: () => {},
    }
    const res = await ticketsGmailWatchRenewal(undefined, ctx)
    expect(res).toMatchObject({ fannedOut: 0, error: "enumerate_failed" })
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #12: mail inbox-hygiene handlers (agentMailArchive / agentMailSetLabels).
// Runs the real sandboxed handlers via executeInSandbox with a stub bridge, asserting
// they issue the right db_update mutations (status=archived; merged/replaced labels) and
// validate their params — the agent capability behind label-hygiene-archive-newsletters.

import { beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"

describe("mail inbox-hygiene handlers (BL-169 #12)", () => {
  let bundleSource: string
  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  it("agentMailArchive sets status=archived for each conversation id", async () => {
    const updates: Array<{ entity: string; id: string; data: any }> = []
    const result = (await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailArchive",
      params: { conversationIds: ["c1", "c2", "c3"] },
      bridge: {
        db_update: async (entity: string, id: string, json: string) => {
          updates.push({ entity, id, data: JSON.parse(json) })
        },
        emit: async () => {},
      },
    })) as any
    expect(result.archived).toBe(3)
    expect(result.total).toBe(3)
    expect(updates.length).toBe(3)
    expect(updates.every((u) => u.entity === "conversations" && u.data.status === "archived")).toBe(
      true,
    )
  })

  it("agentMailArchive hands each mailbox's archived conversations to one Gmail write-back job", async () => {
    const jobs: Array<{ name: string; payload: any; opts: any }> = []
    const accountOf: Record<string, string> = { c1: "acc-a", c2: "acc-b", c3: "acc-a" }
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailArchive",
      params: { conversationIds: ["c1", "c2", "c3"] },
      bridge: {
        getOrgId: () => "org-1",
        db_update: async () => {},
        db_findOne: async (_entity: string, id: string) =>
          JSON.stringify({ id, account_id: accountOf[id] }),
        emit: async () => {},
        enqueueJob: async (name: string, payload: string, opts?: string) => {
          jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : {} })
        },
      },
    })
    expect(jobs.map((j) => [j.name, j.payload.accountId, j.payload.conversationIds])).toEqual([
      ["gmail-write-back", "acc-a", ["c1", "c3"]],
      ["gmail-write-back", "acc-b", ["c2"]],
    ])
    expect(jobs[0]?.payload.fields).toEqual({ status: "archived" })
    // The job looks once more if the tool's write had not committed yet.
    expect(jobs[0]?.payload.awaitCommit).toBe(true)
    // Delayed past the tool's own commit.
    expect(jobs[0]?.opts.delay).toBeGreaterThan(0)
  })

  it("agentMailArchive rejects an empty/missing conversationIds", async () => {
    const result = (await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailArchive",
      params: {},
      bridge: { db_update: async () => {}, emit: async () => {} },
    })) as any
    expect(result.error?.code).toBe("invalid_params")
  })

  it("agentMailSetLabels merges with existing labels in add mode", async () => {
    const updates: any[] = []
    const result = (await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailSetLabels",
      params: { conversationIds: ["c1"], labels: ["Spam/Noise"] },
      bridge: {
        db_findOne: async () => JSON.stringify({ labels: ["Inbox"] }),
        db_update: async (_e: string, _id: string, json: string) => {
          updates.push(JSON.parse(json))
        },
        emit: async () => {},
      },
    })) as any
    expect(result.updated).toBe(1)
    expect(updates[0].labels).toEqual(["Inbox", "Spam/Noise"])
  })

  it("agentMailSetLabels replaces labels in replace mode", async () => {
    const updates: any[] = []
    const result = (await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailSetLabels",
      params: { conversationIds: ["c1"], labels: ["Spam/Noise"], mode: "replace" },
      bridge: {
        db_findOne: async () => JSON.stringify({ labels: ["Inbox", "Customer"] }),
        db_update: async (_e: string, _id: string, json: string) => {
          updates.push(JSON.parse(json))
        },
        emit: async () => {},
      },
    })) as any
    expect(result.updated).toBe(1)
    expect(updates[0].labels).toEqual(["Spam/Noise"])
  })

  it("agentMailSetLabels replace keeps Gmail's own label ids, so the Gmail label state is not lost", async () => {
    const updates: any[] = []
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailSetLabels",
      params: { conversationIds: ["c1"], labels: ["Spam/Noise"], mode: "replace" },
      bridge: {
        db_findOne: async () =>
          JSON.stringify({ labels: ["UNREAD", "Label_12", "Customer", "CATEGORY_UPDATES"] }),
        db_update: async (_e: string, _id: string, json: string) => {
          updates.push(JSON.parse(json))
        },
        emit: async () => {},
      },
    })
    expect(updates[0].labels).toEqual(["UNREAD", "Label_12", "CATEGORY_UPDATES", "Spam/Noise"])
  })

  it("agentMailSetLabels requires a non-empty labels array", async () => {
    const result = (await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailSetLabels",
      params: { conversationIds: ["c1"] },
      bridge: { db_update: async () => {}, emit: async () => {} },
    })) as any
    expect(result.error?.code).toBe("invalid_params")
  })
})

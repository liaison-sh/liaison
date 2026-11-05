// SPDX-License-Identifier: FSL-1.1-ALv2
//
// X11 (2): the auto-title is fire-and-forget from the chat route AFTER the
// turn has finished, outside every run frame, so nothing it can reach knows
// which agent the turn ran as. The caller still does, so it hands the agent
// over explicitly and the thread:update row stops being anonymous.
//
// No model is seeded, so `selectAutoModel` finds none and the heuristic title
// is used: this exercises the persist + emit path without a network call.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { withPrivilegedDb } from "~/db/privileged"
import { threads as kernelThreads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { type AppEvent, initEventBus, onEvent } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { autoTitleAgentChat } from "~/modules/agent/runtime/auto-title"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("auto-title names the agent whose turn it followed", () => {
  let orgId: string
  let userId: string
  let agentId: string
  const captured: AppEvent[] = []

  beforeAll(async () => {
    await acquireTestLock()
    initEventBus()
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    agentId = await withPrivilegedDb(orgId, "autotitle-seed-agent", async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `@autotitle-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Liaison",
          ownerUserId: userId,
        })
        .returning({ id: agents.id })
      return a.id
    })
    onEvent(
      async (event: AppEvent) => {
        if (event.app === "kernel" && event.entity === "thread" && event.orgId === orgId) {
          captured.push(event)
        }
      },
      { delivery: "per-replica" },
    )
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  async function untitledAgentChat(): Promise<string> {
    return withPrivilegedDb(orgId, "autotitle-thread", async (tx) => {
      const [t] = await tx
        .insert(kernelThreads)
        .values({
          orgId,
          handle: `at-${crypto.randomUUID().slice(0, 8)}`,
          type: "agent_chat",
          createdBy: userId,
        })
        .returning({ id: kernelThreads.id })
      return t.id
    })
  }

  it("stamps the acting agent on the thread:update event", async () => {
    const threadId = await untitledAgentChat()
    await autoTitleAgentChat({
      threadId,
      userMessage: "how many open tickets are there",
      agentReply: "seven",
      orgId,
      agentId,
    })
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 50))

    const event = captured.find((e) => (e.data as { id: string }).id === threadId)
    expect(event).toBeDefined()
    expect(event?.agentId).toBe(agentId)
  }, 30_000)

  it("records a positive null when no agent acted", async () => {
    const threadId = await untitledAgentChat()
    await autoTitleAgentChat({
      threadId,
      userMessage: "a turn no agent ran",
      agentReply: "done",
      orgId,
      agentId: null,
    })
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 50))

    const event = captured.find((e) => (e.data as { id: string }).id === threadId)
    expect(event).toBeDefined()
    expect(event?.agentId ?? null).toBeNull()
  }, 30_000)
})

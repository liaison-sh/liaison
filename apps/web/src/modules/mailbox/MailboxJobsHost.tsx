// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the client job drainer lives in a running tab (blueprint task 11.3).
//
// It owns three wirings and nothing else:
//   * the 60 s poll, started on mount and stopped on cleanup,
//   * the immediate wake on the ephemeral `kernel/mailbox_jobs:pending` event
//     the server broadcasts when a trigger enqueues,
//   * the pending-jobs badge, so "runs when you are next online" is something
//     the user can see rather than a promise made in a spec.
//
// The turn runner is resolved PER DRAIN from `mailboxAgentRuntime()`, not
// captured at mount: the runtime is installed by a sibling host, and a drainer
// that snapshotted `undefined` would list the queue for the badge and claim
// nothing forever. Listing without claiming is still the correct fallback when
// no runtime is installed, because a build that cannot finish a job it took
// must not take one.

import { type Component, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { registerWsEntityHandler } from "~/framework/app-registry"
import {
  type AgentTurnRunner,
  type ClientJobDrainer,
  type ClientJobView,
  createClientJobDrainer,
  type JobPlaintext,
  MAILBOX_JOBS_WAKE,
} from "~/modules/mailbox/client-job-drainer"
import type { SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import { MailboxPendingJobs } from "~/modules/mailbox/MailboxPendingJobs"
import { mailboxAgentRuntime, runMailboxJobTurn } from "~/modules/mailbox/mailbox-agent-runtime"
import {
  isMailboxUnlocked,
  mailboxCryptoClient,
  openSealedMessage,
} from "~/modules/mailbox/mailbox-store"
import { useApi } from "~/modules/shell/ApiContext"

export interface MailboxJobsHostProps {
  /** Explicit override, for tests and for a surface that runs jobs its own way.
   *  Absent falls back to `mailboxAgentRuntime()`, then to "list only". */
  runAgentTurn?: AgentTurnRunner
}

/** One id per tab. It names a lease holder, never an identity, so a random
 *  value is exactly right and a stable one would be wrong. */
function newSessionId(): string {
  return `tab-${crypto.randomUUID()}`
}

interface SealedRow extends SealedMessagePayload {
  encVersion: number
}

export const MailboxJobsHost: Component<MailboxJobsHostProps> = (props) => {
  const api = useApi()
  const [jobs, setJobs] = createSignal<ClientJobView[]>([])
  const sessionId = newSessionId()

  /**
   * Fetch the conversation the job names and open the messages it lists, in the
   * crypto worker. Nothing here reads a plaintext field of the fetched rows: a
   * sealed row carries none, and a half-migrated one is opened the same way the
   * reader opens it.
   */
  async function openMessages(job: ClientJobView): Promise<JobPlaintext[]> {
    const conversationId = job.payload.conversationId
    const wanted = new Set((job.payload.messageIds ?? []) as string[])
    if (typeof conversationId !== "string" || wanted.size === 0) return []
    const data = await api.get<{ messages?: SealedRow[] }>(`/mail/conversations/${conversationId}`)
    const opened: JobPlaintext[] = []
    for (const message of data.messages ?? []) {
      if (!wanted.has(message.id)) continue
      const plaintext = await openSealedMessage(message)
      // A locked mailbox answers null. Refusing the whole job is right: a
      // partial read would produce a summary of half a thread.
      if (!plaintext) throw new Error("MAILBOX_LOCKED")
      opened.push(plaintext)
    }
    return opened
  }

  const drainer = createClientJobDrainer({
    api,
    sessionId,
    isUnlocked: () => isMailboxUnlocked(),
    openMessages,
    // Resolved per drain, not captured at mount: the runtime is installed by a
    // sibling host, and a drainer that snapshotted `undefined` here is the
    // "list only, claim nothing" build every server-enqueued job used to die
    // in. An explicit prop still wins, for tests and for a surface that wants
    // to run jobs its own way.
    get runAgentTurn(): AgentTurnRunner | undefined {
      if (props.runAgentTurn) return props.runAgentTurn
      return mailboxAgentRuntime() ? runMailboxJobTurn : undefined
    },
    // D7, keyed by the job. The server never sees the key, only the blob.
    sealResult: async (jobId, plaintext) => {
      const client = mailboxCryptoClient()
      if (!client) throw new Error("MAILBOX_LOCKED")
      return client.sealIndexShard(`client-job:${jobId}`, plaintext)
    },
    onJobsChanged: setJobs,
  })

  /** The drainer keeps its listing in a plain field; the badge needs a signal. */
  const reactive: ClientJobDrainer = {
    ...drainer,
    jobs,
    pendingCount: () => jobs().filter((job) => job.status === "pending").length,
    needsAttention: () =>
      jobs().filter((job) => job.status === "failed" || job.status === "expired"),
  }

  onMount(() => {
    drainer.start()
    void drainer.wake()
    registerWsEntityHandler(
      // QUALIFIED, not bare. `dispatchWsEventMessage` looks handlers up under
      // `<app>:<entity>`, so a bare "mailbox_jobs" registration is never
      // dispatched to and the immediate wake is silently dead: the queue then
      // only moves on the 60 s poll. The triple comes from MAILBOX_JOBS_WAKE so
      // this registration and the server's broadcast cannot drift apart.
      `${MAILBOX_JOBS_WAKE.app}:${MAILBOX_JOBS_WAKE.entity}`,
      MAILBOX_JOBS_WAKE.app,
      (action: string) => {
        if (action === MAILBOX_JOBS_WAKE.action) void drainer.wake()
      },
      { owner: "mailbox-jobs" },
    )
  })
  onCleanup(() => drainer.stop())

  const unlocked = createMemo(() => isMailboxUnlocked())
  return <MailboxPendingJobs drainer={reactive} unlocked={unlocked()} />
}

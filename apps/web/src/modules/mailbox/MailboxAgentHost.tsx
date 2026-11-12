// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the two-phase agent read protocol actually runs in a tab.
//
// It renders nothing. Its whole job is the wiring the protocol needs to exist
// at all: the unlock assertion on the socket, the subscription that answers the
// server's decrypt and search requests, and the runtime handle the chat submit
// path and the client job drainer reach through.
//
// It lives at the SHELL, next to the unlock host, not on the mail surface: a
// chat turn from any tab, and a routine's Run now on Home, need it as much as
// the mail view does. Mounted only inside Mail, a window with no Mail tab had
// no runtime at all, so every turn carried no nonce and Run now refused with
// "not ready". Exactly one runs per window (`claimHost` below). Mounting it
// asks for nothing: while the mailbox is locked it asserts LOCKED and answers
// nothing, and it starts answering once the user unlocks. When it unmounts it
// asserts LOCKED, rather than leaving the server believing a browser is still
// there to answer: a request nobody answers costs the turn its whole wait
// budget.

import { type Component, createEffect, onCleanup, Show } from "solid-js"
import { registerWsEntityHandler } from "~/framework/app-registry"
import { accessToken, hasScope } from "~/modules/auth/auth-store"
import {
  getMessages,
  loadedMailMessageIds,
  loadMessages,
  sealedMessageById,
} from "~/modules/mail/mail-message-store"
import {
  agentMailAccessEnabled,
  syncAgentMailAccessFromServer,
} from "~/modules/mailbox/agent-mail-access"
import { createAttachmentOpener } from "~/modules/mailbox/attachment-opener"
import type { OpenedMessage, SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import { createJobTurnTransport } from "~/modules/mailbox/job-turn-transport"
import {
  createMailboxAgentRuntime,
  handleMailboxAgentStreamEvent,
  installMailboxAgentRuntime,
  MAILBOX_STATUS_REFRESH_MS,
} from "~/modules/mailbox/mailbox-agent-runtime"
import {
  agentMailAccessSyncDeps,
  isMailboxUnlocked,
  MAIL_READ_SCOPE,
  mailboxCryptoClient,
  mailboxStore,
  openSealedMessage,
} from "~/modules/mailbox/mailbox-store"
import { createMcpPlaintextResponder } from "~/modules/mailbox/mcp-plaintext-responder"
import { answerClientSearch } from "~/modules/mailbox/search-index/client-search-responder"
import { clientShardSealer } from "~/modules/mailbox/search-index/index-persistence"
import {
  liveSearchIndexAdapter,
  MAILBOX_SEALED_LISTING_PATH,
  startMailboxSearchIndex,
  stopMailboxSearchIndex,
} from "~/modules/mailbox/search-index/search-index-host"
import { searchIndexStore } from "~/modules/mailbox/search-index/search-index-store"
import { useApi } from "~/modules/shell/ApiContext"
import { useOptionalWs } from "~/modules/shell/WsContext"
import { ensurePersonalAgentDm } from "~/modules/threads/personal-dm-store"

/**
 * Registered once per module load, not per mount. The handler delegates to the
 * installed runtime, so unmounting is a matter of uninstalling the runtime and
 * never of unregistering a shared kernel handler (there is no per-handler
 * unregister, and dropping every kernel `agent_stream` handler would take the
 * chat stream with it).
 */
let subscribed = false
function subscribeToAgentStream(): void {
  if (subscribed) return
  subscribed = true
  registerWsEntityHandler(
    "kernel:agent_stream",
    "kernel",
    (action: string, data: unknown) => {
      handleMailboxAgentStreamEvent(action, data)
    },
    { owner: "mailbox-agent", priority: 40 },
  )
}

/**
 * One host per window. A second mount (a stray Mail-surface copy, a remount
 * racing an unmount) would install a second runtime over the first, and its
 * cleanup would then uninstall the live one and assert LOCKED for a mailbox
 * that is still open. The second one renders nothing instead.
 */
let hostClaimed = false
function claimHost(): (() => void) | null {
  if (hostClaimed) return null
  hostClaimed = true
  return () => {
    hostClaimed = false
  }
}

/**
 * Mounted once, at the shell. It runs for a user who can reach a mailbox at all
 * and has not been found to have none enrolled ("unknown" counts: a mailbox
 * this device unlocked earlier may still be re-opening at startup).
 */
export const MailboxAgentHost: Component = () => (
  <Show when={hasScope(MAIL_READ_SCOPE) && mailboxStore.status !== "not-enrolled"}>
    <ClaimedMailboxAgentHost />
  </Show>
)

const ClaimedMailboxAgentHost: Component = () => {
  const release = claimHost()
  if (!release) return null
  onCleanup(release)
  return <MailboxAgentHostRuntime />
}

/** Sealed rows this window has not loaded, read by id from the sealed listing. */
async function fetchSealedByIds(
  api: ReturnType<typeof useApi>,
  ids: string[],
): Promise<Map<string, SealedMessagePayload>> {
  const found = new Map<string, SealedMessagePayload>()
  if (ids.length === 0) return found
  const params = new URLSearchParams({ ids: ids.join(",") })
  const page = await api.get<{ items?: Array<{ sealed?: SealedMessagePayload }> }>(
    `${MAILBOX_SEALED_LISTING_PATH}?${params.toString()}`,
  )
  for (const item of page?.items ?? []) {
    if (item.sealed?.id) found.set(item.sealed.id, item.sealed)
  }
  return found
}

const MailboxAgentHostRuntime: Component = () => {
  const api = useApi()
  // Optional on purpose: with no socket there is nothing to assert to, and the
  // mail surface must still render. Every read path then behaves as locked,
  // which is the correct failure direction.
  const ws = useOptionalWs()

  async function openMessages(messageIds: string[]): Promise<OpenedMessage[]> {
    const client = mailboxCryptoClient()
    if (!client) return []
    const rows: SealedMessagePayload[] = []
    // Loaded rows first. The rest (this window may never have opened Mail) are
    // read BY ID from the owner-scoped sealed listing: the server returns this
    // user's own sealed rows only (an id of anyone else's mail comes back
    // undecryptable), and the responder has already applied its caps (and, for
    // a conversion, the turn scope). Ciphertext only; the worker opens it.
    const missing = messageIds.filter((id) => !sealedMessageById(id))
    const fetched = await fetchSealedByIds(api, missing).catch(
      () => new Map<string, SealedMessagePayload>(),
    )
    for (const id of messageIds) {
      const sealed = sealedMessageById(id) ?? fetched.get(id)
      if (sealed) rows.push(sealed)
    }
    // All at once, not one after another: each open is its own worker request,
    // and a serial loop made a 10-message read pay every round trip in turn
    // while the agent's wait ran out. Order is kept; one failure fails all, as before.
    return await Promise.all(rows.map((sealed) => client.openMessage(sealed)))
  }

  // Reads asked by an app connected over MCP for this same user, answered while
  // the mailbox is unlocked (mcp-plaintext-responder.ts).
  const mcpResponder = createMcpPlaintextResponder({
    isUnlocked: () => isMailboxUnlocked(),
    agentMailAccessEnabled,
    loadConversation: (conversationId) => loadMessages(api, conversationId),
    conversationMessageIds: (conversationId) => getMessages(conversationId).map((m) => m.id),
    openMessages,
    postPlaintext: async (requestId, body) => {
      await api.post(`/agent/mailbox-plaintext/${requestId}`, body)
    },
    postSearch: async (requestId, body) => {
      await api.post(`/agent/mailbox-search/${requestId}`, body)
    },
    search: async (request) => {
      const adapter = liveSearchIndexAdapter()
      if (!adapter) return { messageIds: [], indexComplete: false }
      const outcome = await answerClientSearch(
        {
          adapter,
          isUnlocked: () => isMailboxUnlocked(),
          turnNonce: () => request.turnNonce,
          indexComplete: () => searchIndexStore.complete,
          // The MCP responder posts the answer itself, once.
          post: async () => {},
        },
        {
          requestId: request.requestId,
          turnNonce: request.turnNonce,
          query: request.query ?? "",
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
        },
      )
      return { messageIds: outcome.messageIds, indexComplete: outcome.indexComplete }
    },
  })

  const runtime = createMailboxAgentRuntime({
    mcpResponder,
    post: (path, body) => api.post(path, body),
    send: (frame) => ws?.send(frame),
    isUnlocked: () => isMailboxUnlocked(),
    keyIds: () =>
      (mailboxStore.keyring?.identities ?? [])
        .filter((identity) => identity.status === "active")
        .map((identity) => identity.keyId),
    openMessages,
    openAttachments: async (fileIds) => {
      const client = mailboxCryptoClient()
      if (!client) throw new Error("MAILBOX_LOCKED")
      const opener = createAttachmentOpener({
        client,
        fetchMetadata: (fileId) => api.get(`/files/${fileId}/metadata`),
        fetchCiphertext: async (fileId) => {
          const response = await api.rawGet(`/files/${fileId}/inline?download=1`)
          return await response.arrayBuffer()
        },
      })
      return await opener(fileIds)
    },
    agentMailAccessEnabled,
    turnScopeIds: () => loadedMailMessageIds(),
    searchAdapter: () => liveSearchIndexAdapter(),
    indexComplete: () => searchIndexStore.complete,
    submitTurn: createJobTurnTransport({
      getToken: () => accessToken(),
      // The job turn runs in the user's DM with their personal agent, resolved
      // through `POST /threads/dm`. The old `POST /threads { type:
      // "agent_chat" }` is retired and now answers 400 `agent_chat_retired`,
      // so a job turn taking that route could never create its thread at all.
      createThread: () => ensurePersonalAgentDm(api),
    }),
  })

  // Installed as the host is created, not in a later mount pass: Run now and
  // the chat submit path read it synchronously right after the lock state
  // resolves, and that is exactly when this host may have just mounted.
  subscribeToAgentStream()
  const uninstall = installMailboxAgentRuntime(runtime)
  const timer = setInterval(() => {
    // A window with a turn open re-asserts even while locked: it still owns
    // that turn, and its own answer to it is the one that counts.
    if (isMailboxUnlocked() || runtime.session.openTurnCount() > 0) runtime.sendStatusFrame()
  }, MAILBOX_STATUS_REFRESH_MS)
  onCleanup(() => {
    clearInterval(timer)
    uninstall()
    runtime.reset()
    // Say so, rather than letting the assertion expire 90 s later.
    ws?.send({ type: "status", scope: "mailbox", unlocked: false, keyIds: [], turns: [] })
  })

  // The client search index (spec section 5.5). It is the ONLY index over
  // sealed mail, because the server index for those rows is deliberately empty,
  // so an unbuilt one means search answers "no matches" to everything.
  // An "on" relayed while this device was locked could not be verified then:
  // re-read the relayed switch each time the mailbox opens (agent-mail-access.ts).
  createEffect(() => {
    if (!isMailboxUnlocked()) return
    void syncAgentMailAccessFromServer(api, agentMailAccessSyncDeps())
  })

  createEffect(() => {
    if (!isMailboxUnlocked()) {
      stopMailboxSearchIndex()
      return
    }
    const client = mailboxCryptoClient()
    if (!client) return
    void startMailboxSearchIndex({
      api,
      sealer: clientShardSealer(client),
      open: (sealed) => openSealedMessage(sealed),
      isUnlocked: () => isMailboxUnlocked(),
    })
  })

  onCleanup(() => stopMailboxSearchIndex())

  // Every lock, unlock and reconnect re-asserts: a socket that dropped carries
  // no assertion, and the server holds each one for 90 s only.
  createEffect(() => {
    mailboxStore.status
    ws?.status()
    runtime.sendStatusFrame()
  })

  return null
}

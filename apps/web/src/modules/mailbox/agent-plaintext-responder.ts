// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser's half of the two-phase agent read protocol (blueprint Task 9.5,
// spec sections 5.3b and 9.8).
//
// THE CONSENT BOUND LIVES HERE, not on the server, and the reason is worth
// stating plainly: a server-chosen list of message ids rendered next to a
// server-supplied purpose string is not consent. Both halves of that prompt come
// from the party asking for the plaintext. So the checks that matter run where
// the key is, in the browser, and they are checks this client can make on its own
// evidence:
//
//   * The TURN NONCE. The client mints it when the user submits a turn. A decrypt
//     request whose nonce does not match a turn THIS client started and still has
//     open is refused. That is what stops a server from naming arbitrary ids at an
//     arbitrary moment and having the browser decrypt them on demand.
//   * The CAPS. Per request, per turn, and per session, so a compromised or
//     malicious turn cannot walk the mailbox one small honest-looking batch at a
//     time.
//   * The SWITCH. The settings page can turn the agent's mail access off
//     entirely, which is the stronger property some users actually want.
//   * The LOCK. A locked mailbox decrypts nothing, and says so by code.
//
// WHAT THE ENCRYPTION IS FOR, AND SO WHAT IS NOT CHECKED. A private mailbox is
// sealed so that other members, admins and whoever runs the server can never
// read it, at rest or in transit. It is not sealed against its owner: a read the
// user's own agent asks for, in a turn the user started, is the user reading
// their own mail. So a READ (`mail.read`, `mail.quote`, `mail.attachment`) is
// served for any message of this mailbox the turn names, whether or not this
// window ever loaded it: the agent often finds mail through a contact, a ticket
// or a search on the server, not through the Mail view. The ids are only names;
// the key here opens nothing but this user's own mail, so naming someone else's
// message gets it reported undecryptable, never opened.
//
// The ID SCOPE binds a DISCLOSURE only. `mail.convert` copies mail into a
// team-visible ticket, so it is the one kind that reaches other people. Its ids
// must resolve to entities this turn actually surfaced (the conversation the
// user has open, ids the turn's own results named, or ids the user selected),
// and it needs the user's yes in this window, every time.
//
// A refusal is POSTED, never silence: the waiting turn must learn it was refused
// and take the locked path, rather than sitting on its budget until it expires.
// Every answer from the turn's own window carries `turnOwner: true` and the
// turn's nonce, which is what lets the server settle on a deliberate refusal at
// once.
//
// ANY OF THE USER'S UNLOCKED APPS ANSWERS, and the turn's own window is never
// stricter than the others for a read. A request for a turn another app of this
// user started (the phone, a second window) is also answered here, by a second
// responder built with `answerWithToken`: it answers with the request's answer
// token, which the server sent to this user's own connections only. The caps,
// the lock and the agent-access switch still apply, and a conversion is never
// answered that way: it needs the owner's yes in the window they use.
//
// PARTIAL SERVICE IS NOT AN OPTION for a conversion. A conversion naming one
// out-of-scope id is refused whole: serving the in-scope subset would turn every
// refusal into a membership oracle over the id space, one probe per request.

import type { OpenedMessage } from "~/modules/mailbox/crypto-protocol"

export type AgentDecryptRequestKind =
  | "mail.read"
  | "mail.quote"
  | "mail.attachment"
  /**
   * Ticket conversion (blueprint Task 9.7, spec section 5.6). Unlike every other
   * kind this does NOT hand plaintext to a model for one turn: it copies the
   * content into a team-visible ticket, permanently. It is the one request kind
   * that needs a yes from the user, every time, and a missing answer is a no.
   */
  | "mail.convert"

/** The ids-only request as it arrives on the ephemeral agent_stream event. */
export interface AgentDecryptRequest {
  requestId: string
  turnNonce: string
  requestKind: AgentDecryptRequestKind
  messageIds: string[]
  /** The agent's stated reason. Displayed as ITS words, never as our assurance. */
  purpose: string
  expiresAt: string
  /** `mail.convert` only: what becomes readable by other people, in plain words. */
  disclosure?: string
  /** Minted by the server per request, sent to this user's connections only. */
  answerToken?: string
}

/** Hard caps, enforced here. Nothing on the server can raise them. */
export const AGENT_PLAINTEXT_CAPS = {
  perRequest: 25,
  perTurn: 200,
  requestsPerTurn: 8,
  perSession: 2000,
} as const

export interface DisclosureEntry {
  requestId: string
  turnNonce: string
  requestKind: AgentDecryptRequestKind
  messageIds: string[]
  at: number
}

export interface AgentPlaintextResponderDeps {
  /** True only for a turn THIS client started and still has open. */
  isOpenTurn(turnNonce: string): boolean
  isUnlocked(): boolean
  /**
   * True when the id was surfaced in that turn or explicitly selected. Checked
   * for a conversion (`mail.convert`) only: a read of the user's own mail in the
   * user's own turn is served whatever this window has loaded.
   */
  isIdInTurnScope(messageId: string, turnNonce: string): boolean
  /** The settings switch. False means the agent gets nothing, ever. */
  agentMailAccessEnabled(): boolean
  /**
   * Opens the named messages IN THE CRYPTO WORKER. Production wires this through
   * `openMessagesForTurn`, so plaintext this client already holds for the turn
   * (a drained client job) is served without decrypting it a second time.
   */
  openMessages(messageIds: string[], turnNonce: string): Promise<OpenedMessage[]>
  /** POST /api/agent/mailbox-plaintext/:requestId. */
  post(requestId: string, body: Record<string, unknown>): Promise<void>
  /** The client's own ledger, which is what the disclosure UI renders from. */
  recordDisclosure(entry: DisclosureEntry): void
  /**
   * `mail.convert` only (Task 9.7). Shows the user, in the mail surface, exactly
   * what is about to become readable by everyone with access to the target
   * inbox, and resolves to their answer.
   *
   * ABSENT MEANS REFUSE. A client with no way to ask cannot have asked, and a
   * conversion nobody confirmed must not happen: this is the one request kind
   * whose effect is permanent and visible to other people.
   */
  confirmDisclosure?(disclosure: string, messageIds: string[]): Promise<boolean>
  /**
   * `mail.attachment` only (Task 9.9). Decrypts stored attachments that are
   * sealed at rest and returns their plaintext bytes, base64.
   *
   * ABSENT MEANS REFUSE, for the same reason: the alternative is the server
   * sending ciphertext to an external recipient, or dropping the file silently.
   */
  openAttachments?(fileIds: string[]): Promise<Array<{ fileId: string; bytesBase64: string }>>
  now?(): number
  /**
   * This responder answers for turns ANOTHER app of the user started: with the
   * request's answer token instead of the turn's nonce, never as the turn's
   * owner, and never for a conversion.
   */
  answerWithToken?: boolean
}

export interface AgentPlaintextOutcome {
  accepted: boolean
  /** Present on a refusal. Shown to the user and sent to the waiting turn. */
  reason?: string
  released?: number
}

export interface AgentPlaintextResponder {
  handle(request: AgentDecryptRequest): Promise<AgentPlaintextOutcome>
  /** Messages released to the agent in this session. Rendered in the mail UI. */
  releasedThisSession(): number
  /** Called on lock and on session end. */
  reset(): void
  /** Test seam for the session budget, which is 2000 requests long by design. */
  __setReleasedForTest(count: number): void
}

export function createAgentPlaintextResponder(
  deps: AgentPlaintextResponderDeps,
): AgentPlaintextResponder {
  const now = deps.now ?? (() => Date.now())
  let releasedThisSession = 0
  let turnNonce: string | null = null
  let turnRequests = 0
  let turnReleased = 0

  /** What proves an answer belongs to its request, and who is answering. */
  function proofOf(request: AgentDecryptRequest): Record<string, unknown> {
    if (deps.answerWithToken) return { answerToken: request.answerToken }
    return { turnNonce: request.turnNonce, turnOwner: true }
  }

  function startTurnIfNew(nonce: string): void {
    if (turnNonce === nonce) return
    turnNonce = nonce
    turnRequests = 0
    turnReleased = 0
  }

  async function refuse(
    request: AgentDecryptRequest,
    reason: string,
    opts: { code?: "locked"; turnOwner?: boolean } = {},
  ): Promise<AgentPlaintextOutcome> {
    // Tell the turn. A silent refusal costs it its whole wait budget and tells
    // the user nothing.
    try {
      await deps.post(request.requestId, {
        // Not ours to settle when this client did not start the turn.
        ...(opts.turnOwner === false ? { turnNonce: request.turnNonce } : proofOf(request)),
        denied: { reason, ...(opts.code ? { code: opts.code } : {}) },
      })
    } catch {
      // A refusal that cannot be delivered still stands locally.
    }
    return { accepted: false, reason }
  }

  return {
    async handle(request: AgentDecryptRequest): Promise<AgentPlaintextOutcome> {
      // Order matters. The nonce is checked before the lock state so a stale or
      // forged turn cannot learn whether the mailbox is open by watching which
      // refusal it gets back.
      if (
        deps.answerWithToken &&
        (!request.answerToken || request.requestKind === "mail.convert")
      ) {
        // Nothing to answer with, or a disclosure only the owner's window may confirm.
        return { accepted: false, reason: "this request is for the window that started the turn" }
      }
      if (!deps.isOpenTurn(request.turnNonce)) {
        return await refuse(
          request,
          "this request names a turn this browser did not start, or one that is no longer open",
          { turnOwner: false },
        )
      }
      if (!deps.agentMailAccessEnabled()) {
        return await refuse(
          request,
          "the agent's access to this mailbox is turned off in the mailbox security settings",
        )
      }
      if (!deps.isUnlocked()) {
        return await refuse(request, "this mailbox is locked, so nothing can be decrypted", {
          code: "locked",
        })
      }

      startTurnIfNew(request.turnNonce)

      const ids = request.messageIds
      if (ids.length === 0) {
        return await refuse(request, "this request named no messages")
      }
      if (ids.length > AGENT_PLAINTEXT_CAPS.perRequest) {
        return await refuse(
          request,
          `one request may ask for at most ${AGENT_PLAINTEXT_CAPS.perRequest} messages, and this one asked for ${ids.length}`,
        )
      }
      if (turnRequests >= AGENT_PLAINTEXT_CAPS.requestsPerTurn) {
        return await refuse(
          request,
          `this turn has already asked ${AGENT_PLAINTEXT_CAPS.requestsPerTurn} times, which is as often as one turn may ask`,
        )
      }
      if (turnReleased + ids.length > AGENT_PLAINTEXT_CAPS.perTurn) {
        return await refuse(
          request,
          `this turn has reached the ${AGENT_PLAINTEXT_CAPS.perTurn} message limit for a single turn`,
        )
      }
      if (releasedThisSession + ids.length > AGENT_PLAINTEXT_CAPS.perSession) {
        return await refuse(
          request,
          `this session has reached its ${AGENT_PLAINTEXT_CAPS.perSession} message budget, so unlock again to continue`,
        )
      }
      // Only a disclosure is bound to the turn's scope (see the header): a read
      // is the user's own agent reading the user's own mail.
      if (request.requestKind === "mail.convert") {
        const outOfScope = ids.filter((id) => !deps.isIdInTurnScope(id, request.turnNonce))
        if (outOfScope.length > 0) {
          return await refuse(
            request,
            `${outOfScope.length} of the messages asked for are out of scope for this turn, so nothing was released`,
          )
        }
      }

      // Task 9.9. Attachment bytes are a different decryption from a message
      // field, so the request is served, or refused, on its own terms.
      if (request.requestKind === "mail.attachment") {
        if (!deps.openAttachments) {
          return await refuse(
            request,
            "this browser cannot open the encrypted attachments this send needs, so nothing was released",
          )
        }
        let files: Array<{ fileId: string; bytesBase64: string }>
        try {
          files = await deps.openAttachments(ids)
        } catch (error) {
          // Said, never swallowed: the turn waits for this answer and the agent has to tell the
          // person why (locked, too large, did not decrypt).
          const code = (error as { code?: unknown } | null)?.code
          if (code === "mailbox_locked") {
            return await refuse(request, "this mailbox is locked, so nothing can be decrypted", {
              code: "locked",
            })
          }
          const reason =
            code === "too_large"
              ? "this attachment is larger than the 25 MB the agent may receive, so nothing was opened"
              : error instanceof Error && error.message
                ? error.message
                : "the attachment could not be opened, so nothing was released"
          return await refuse(request, reason)
        }
        const byFileId = new Map(files.map((f) => [f.fileId, f.bytesBase64]))
        const missing = ids.filter((id) => !byFileId.get(id))
        if (missing.length > 0) {
          // Partial attachment service loses a file inside a mail that reports
          // success, so it is refused whole, like every other partial here.
          return await refuse(
            request,
            `${missing.length} of the attachments asked for did not decrypt, so nothing was released`,
          )
        }
        const attachmentItems = ids.map((id) => ({
          messageId: id,
          bytesBase64: byFileId.get(id) as string,
        }))
        await deps.post(request.requestId, {
          ...proofOf(request),
          items: attachmentItems,
          undecryptable: [],
        })
        turnRequests += 1
        turnReleased += attachmentItems.length
        releasedThisSession += attachmentItems.length
        deps.recordDisclosure({
          requestId: request.requestId,
          turnNonce: request.turnNonce,
          requestKind: request.requestKind,
          messageIds: ids,
          at: now(),
        })
        return { accepted: true, released: attachmentItems.length }
      }

      // Task 9.7. A conversion makes this content readable by other people,
      // permanently. Ask FIRST, before decrypting anything, so a declined
      // conversion never opened the messages at all.
      let consented: boolean | undefined
      if (request.requestKind === "mail.convert") {
        if (!deps.confirmDisclosure) {
          return await refuse(
            request,
            "this browser cannot ask you to confirm making this conversation readable by the team, so nothing was released",
          )
        }
        const disclosure =
          request.disclosure ??
          "This will make the message body and subject readable by everyone with access to this inbox."
        consented = await deps.confirmDisclosure(disclosure, ids)
        if (!consented) {
          return await refuse(
            request,
            "you chose not to make this conversation readable by the team, so nothing was released",
          )
        }
      }

      const opened = await deps.openMessages(ids, request.turnNonce)
      const byId = new Map(opened.map((m) => [m.id, m]))
      const undecryptable = ids.filter((id) => !byId.has(id))
      const items = opened.map((message) => ({
        messageId: message.id,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        // A quote request wants the same plaintext under the names the server
        // assembles the quote from. One decryption, two shapes.
        ...(request.requestKind === "mail.quote"
          ? { quotedBody: message.textBody, resolvedSubject: message.subject }
          : {}),
      }))

      await deps.post(request.requestId, {
        ...proofOf(request),
        items,
        undecryptable,
        // Only a conversion carries it, and only as an explicit true. The server
        // refuses to create the ticket without it.
        ...(consented === true ? { consented: true } : {}),
      })

      turnRequests += 1
      turnReleased += items.length
      releasedThisSession += items.length
      deps.recordDisclosure({
        requestId: request.requestId,
        turnNonce: request.turnNonce,
        requestKind: request.requestKind,
        messageIds: items.map((i) => i.messageId),
        at: now(),
      })
      return { accepted: true, released: items.length }
    },
    releasedThisSession() {
      return releasedThisSession
    },
    reset() {
      releasedThisSession = 0
      turnNonce = null
      turnRequests = 0
      turnReleased = 0
    },
    __setReleasedForTest(count: number) {
      releasedThisSession = count
    },
  }
}

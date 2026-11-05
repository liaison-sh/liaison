// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CLAIM: this machine is running that agent's turns in this conversation.
//
// A32. A local session's input is the conversation it was started from, which
// means the SERVER must stop running that agent's turn there while the desktop
// is running it here: otherwise one human message produces two turns, two
// replies and two bills, one of them from a machine that cannot see the user's
// folder at all.
//
// So the desktop registers a claim on (thread, agent) and keeps it alive with a
// heartbeat. The claim has a short TTL and nothing renews it but this window:
// a laptop that sleeps, a window that is closed, a process that is killed all
// stop renewing, the claim dies on its own, and the server goes back to
// answering in that thread. That is the whole reason it is a lease rather than
// a flag: a flag set by a machine that is now gone is a conversation the agent
// has stopped answering, with nobody to notice.
//
// The release is sent on every exit this window can see (session end, window
// close, app exit); the TTL is what covers the ones it cannot.

import { invoke } from "../tauri"

/**
 * How long any ONE server round trip on the claim path may take (P6d-FX7,
 * SK-4). Every call here used to be a bare `fetch` with no signal, and a
 * release is awaited by `stop()`, which a start awaits in turn: a server that
 * accepts the connection and never answers (a blackholed edge) hung the Start
 * button for the life of the window, with the control looking untouched. A
 * request that has not answered in ten seconds has not answered.
 */
export const CLAIM_REQUEST_TIMEOUT_MS = 10_000

/** How long the server honours one claim without a heartbeat. */
export const CLAIM_TTL_SECONDS = 60

/**
 * How often it is renewed. A third of the TTL, so two heartbeats can be lost
 * (a sleeping radio, one slow request) before the claim lapses and the server
 * answers a message the desktop was about to answer.
 */
export const CLAIM_HEARTBEAT_MS = 20_000

/**
 * WHICH MACHINE this is, as far as the server is concerned.
 *
 * A claim belongs to its holder, and the holder is the user AND the window:
 * the account alone cannot tell two windows of one person apart, and two
 * windows both renewing one lease is two machines answering one conversation.
 * Minted per session, never stored: a window that goes away takes its key with
 * it and the lease runs out on its own.
 */
export function mintHolderKey(install: string | null = null): string {
  const perWindow = crypto.randomUUID()
  return install ? `d.${install}.${perWindow}` : perWindow
}

/**
 * WHICH INSTALL this window belongs to, as the server may know it (2026-09-23).
 *
 * An app that is quit has its sidecar killed by the shell, and the release it
 * sends on the way out often never leaves: the relaunched app then found its
 * own previous lease live and was told another machine held the conversation.
 * A holder key that names the install (`d.<install>.<window>`) lets the server
 * see that the new instance and the dead one are the same user on the same
 * install, and supersede at once (`installOf` in `local-session-routes.ts`).
 *
 * A DIGEST OF THE INSTALL SALT, never the salt: the salt is what makes the
 * folder digests meaningless off this machine (`folder-hash.ts`) and it never
 * leaves it. Domain separated, so this value and a folder digest can never be
 * the same bytes. Null when the shell has no salt to give (no shell at all):
 * the key is then a bare window key and supersedes nothing.
 */
export async function installClaimId(salt: string): Promise<string | null> {
  if (!salt) return null
  const bytes = new TextEncoder().encode(`liaison-claim-install\n${salt}`)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)
}

/**
 * Lost heartbeats before this window says the conversation is no longer its
 * own. Two, because the renewal runs at a third of the TTL: after two lost in
 * a row the lease has at most one renewal left in it, and by the time a third
 * is due the server is answering that conversation again. Saying so late is
 * worse than saying so early: the user is looking at a window that believes it
 * is running a conversation somebody else is answering.
 */
export const CLAIM_LOST_AFTER_FAILURES = 2

/**
 * Consecutive 401 heartbeats before the window gives up on its token. Four,
 * because four renewals span the whole TTL (the page rotates a token within
 * a minute of its expiry, so a genuine rotation never reaches this), and by
 * then the server has been answering the conversation itself.
 */
export const CLAIM_LOST_AFTER_UNAUTHORIZED = 4

/**
 * WHERE THE BEARER TOKEN COMES FROM, read at every request.
 *
 * A string is the token as it was at claim time. That is what every caller
 * passed, and an access token lives fifteen minutes: from the sixteenth
 * minute every heartbeat was a 401, two of those declared the conversation
 * lost, and the window said "this machine stopped holding the conversation"
 * over a sidecar that was alive and idle (first Windows walk, sixth minute of
 * a session started on a six minute old token). A function is asked each
 * time, so the token presented is the one the page has kept fresh.
 */
export type AccessTokenSource = string | (() => string | null)

/** The token to present now. Empty when the source has none. */
export function currentAccessToken(source: AccessTokenSource): string {
  return (typeof source === "function" ? source() : source) ?? ""
}

/**
 * THE LEASE, AS THE SHELL KEEPS IT FOR THE QUIT (2026-09-23).
 *
 * Quitting the app runs no page script (Cmd+Q ends the event loop, then the
 * shell kills the sidecar), so the release this module sends on every exit it
 * can see never left, and the relaunched app found its own lease live. The
 * shell sends it instead (`claim_release.rs`): it is told the release URL and
 * the token of the moment on every registration and heartbeat, and told to
 * forget it when this window released the lease itself.
 */
export interface HeldLease {
  releaseUrl: string
  token: string
}

/** The release URL the shell holds for this window, so a stale forget cannot
 *  clear a newer lease's record. */
let notedReleaseUrl: string | null = null

export function noteLeaseToShell(lease: HeldLease | null, releaseUrl: string): void {
  if (lease === null) {
    if (notedReleaseUrl !== releaseUrl) return
    notedReleaseUrl = null
  } else {
    notedReleaseUrl = lease.releaseUrl
  }
  try {
    // A shell older than the command, or no shell at all (a test, a browser):
    // the TTL and the server's same-install supersede are what is left.
    void Promise.resolve(
      invoke("note_local_claim", lease ? { releaseUrl: lease.releaseUrl, token: lease.token } : {}),
    ).catch(() => undefined)
  } catch {
    // Same: best effort.
  }
}

export interface LocalClaimOptions {
  serverAddress: string
  accessToken: AccessTokenSource
  agentId: string
  threadId: string
  /** This window's holder key. Minted when the caller does not bring one. */
  holderKey?: string
  /**
   * Take the conversation from a machine that still holds it. Never the
   * default: the refusal is the point, and the user decides.
   */
  takeOver?: boolean
  /**
   * Told when the lease can no longer be considered held: the heartbeats stop
   * getting through, or the server hands the conversation to another machine.
   * The window puts up its reconnect banner rather than going quiet.
   */
  onLost?: () => void
  /** Test seam. Real callers leave these alone. */
  heartbeatMs?: number
  fetchImpl?: typeof fetch
  /** Where the lease is recorded for the quit. Defaults to the shell. */
  noteLease?: (lease: HeldLease | null, releaseUrl: string) => void
}

export interface LocalClaimHandle {
  readonly threadId: string
  readonly agentId: string
  /** What this window presents on every heartbeat, reply and release. */
  readonly holderKey: string
  /** Stops the heartbeat and tells the server, at most once. */
  release: () => Promise<void>
}

function claimsUrl(serverAddress: string, agentId: string): string {
  const base = serverAddress.replace(/\/+$/, "")
  return `${base}/api/agents/${encodeURIComponent(agentId)}/local-claims`
}

/**
 * The registration was refused, carrying the STATUS the server refused with.
 *
 * The status is the difference between two different things to tell a user
 * (P6d-FX5, W8): 409 means another machine is already running this
 * conversation, which no retry fixes and which the user resolves by stopping
 * it there, and anything else is this window's own credentials or the server.
 * It used to be readable only by parsing it back out of the message, which is
 * how a caller ends up branching on English.
 */
export class LocalClaimError extends Error {
  readonly status: number
  /**
   * WHOSE LEASE REFUSED THIS ONE (P6d-FX7, SK-5). A 409 whose holder is this
   * window's own key is not "another machine": there is no other machine and
   * there is nothing for the user to go and stop. The server says which it is,
   * because only the server can see the live row.
   */
  readonly heldByThisWindow: boolean
  /** WHO holds it, as the server said on the 409, or null when it did not. */
  readonly holder: ClaimHolder | null
  constructor(status: number, heldByThisWindow = false, holder: ClaimHolder | null = null) {
    super(`the conversation could not be claimed for this machine (${status})`)
    this.name = "LocalClaimError"
    this.status = status
    this.heldByThisWindow = heldByThisWindow
    this.holder = holder
  }
}

/** Whose lease refused a registration (the 409's `details`). */
export interface ClaimHolder {
  sameUser: boolean
  holderName: string | null
  canTakeOver: boolean
}

/** The server's own answer to "whose lease refused you?". */
async function readRefusal(
  response: Response,
): Promise<{ heldByYou: boolean; holder: ClaimHolder | null }> {
  try {
    const body = (await response.json()) as {
      error?: {
        details?: {
          heldByYou?: unknown
          sameUser?: unknown
          holderName?: unknown
          canTakeOver?: unknown
        }
      }
    }
    const details = body?.error?.details
    const heldByYou = details?.heldByYou === true
    // A server older than the holder fields says nothing about who: null, and
    // the page words the refusal without a name.
    const holder =
      details && typeof details.sameUser === "boolean"
        ? {
            sameUser: details.sameUser,
            holderName: typeof details.holderName === "string" ? details.holderName : null,
            canTakeOver: details.canTakeOver === true,
          }
        : null
    return { heldByYou, holder }
  } catch {
    // A refusal we cannot read says nothing about whose lease it is, and the
    // safe direction is the one that does not tell a user there is no problem.
    return { heldByYou: false, holder: null }
  }
}

/**
 * Registers the claim and starts renewing it. A refusal REJECTS: a local
 * session that runs without a claim is the double turn this exists to prevent,
 * so the caller has to decide, and `startLocalSession` refuses to start.
 */
export async function claimThreadForLocalTurns(
  options: LocalClaimOptions,
): Promise<LocalClaimHandle> {
  const call = options.fetchImpl ?? fetch
  const url = claimsUrl(options.serverAddress, options.agentId)
  // Built per request, never once: the token behind it turns over.
  const headers = () => ({
    Authorization: `Bearer ${currentAccessToken(options.accessToken)}`,
    "Content-Type": "application/json",
  })
  const holderKey = options.holderKey ?? mintHolderKey()
  // `registration` marks the FIRST call, which is the only one the server lets
  // supersede this install's previous instance; a heartbeat never does.
  const register = async (takeOver: boolean, registration = false): Promise<Response> =>
    call(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        threadId: options.threadId,
        holderKey,
        ...(takeOver ? { takeOver: true } : {}),
        ...(registration ? { register: true } : {}),
      }),
      signal: AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS),
    })

  const first = await register(options.takeOver === true, true)
  if (!first.ok) {
    if (first.status !== 409) throw new LocalClaimError(first.status)
    const refusal = await readRefusal(first)
    throw new LocalClaimError(first.status, refusal.heldByYou, refusal.holder)
  }

  const releaseUrl = `${url}/${encodeURIComponent(options.threadId)}?holderKey=${encodeURIComponent(holderKey)}`
  const noteLease = options.noteLease ?? noteLeaseToShell
  const noteHeld = (): void =>
    noteLease({ releaseUrl, token: currentAccessToken(options.accessToken) }, releaseUrl)
  noteHeld()

  let released = false
  let lost = false
  let failures = 0
  let unauthorized = 0
  const declareLost = (): void => {
    if (lost) return
    lost = true
    noteLease(null, releaseUrl)
    options.onLost?.()
  }
  const timer = setInterval(() => {
    // A heartbeat that fails is not fatal on its own: the next one may well
    // succeed inside the TTL, and tearing the session down on one dropped
    // request would make a flaky network look like a broken feature. A RUN of
    // them is a different thing, and so is a refusal: 409 means another machine
    // now holds the conversation, which no retry undoes.
    void register(false)
      .then((response) => {
        if (response.ok) {
          failures = 0
          unauthorized = 0
          // The token turns over; the shell's copy follows it.
          if (!released && !lost) noteHeld()
          return
        }
        if (response.status === 409 || response.status === 403) {
          declareLost()
          return
        }
        // A 401 is USUALLY the token turning over: the page refreshes it
        // within a minute of its expiry and the next heartbeat carries the
        // new one, so two inside that minute are not a lost lease. A run of
        // them past the server's TTL is a token that is not coming back (a
        // sign out, a revoked session): the server has been answering the
        // conversation since the TTL ran out, and the window has to say so.
        if (response.status === 401) {
          unauthorized += 1
          if (unauthorized >= CLAIM_LOST_AFTER_UNAUTHORIZED) declareLost()
          return
        }
        unauthorized = 0
        failures += 1
        if (failures >= CLAIM_LOST_AFTER_FAILURES) declareLost()
      })
      .catch(() => {
        failures += 1
        if (failures >= CLAIM_LOST_AFTER_FAILURES) declareLost()
      })
  }, options.heartbeatMs ?? CLAIM_HEARTBEAT_MS)

  return {
    threadId: options.threadId,
    agentId: options.agentId,
    holderKey,
    release: async () => {
      if (released) return
      released = true
      clearInterval(timer)
      noteLease(null, releaseUrl)
      try {
        await call(releaseUrl, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${currentAccessToken(options.accessToken)}` },
          // BOUNDED (P6d-FX7, SK-4). `stop()` awaits this and `start()`
          // awaits `stop()`, so a request that never settles is a Start
          // button that never works again.
          signal: AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS),
          // The window is often ALREADY going away when this runs (a close,
          // an app exit): without keepalive the request is cancelled with the
          // document and the claim sits out its whole TTL.
          keepalive: true,
        })
      } catch {
        // The TTL is the backstop: a release that never arrived costs the
        // conversation one minute of silence from the server, not its agent.
      }
    },
  }
}

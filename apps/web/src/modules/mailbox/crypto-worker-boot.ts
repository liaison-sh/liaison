// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the crypto worker actually starts.
//
// Everything downstream of this file was written first and wired last: the store
// holds a client handle, the mail surface opens sealed rows through it, the agent
// protocol reaches it for a turn. None of that runs without a worker, and a
// mailbox with no worker is not "degraded", it is a mailbox nobody can read.
//
// Three rules this file exists to keep:
//
//   1. THE INTEGRITY CHECK IS ON THE BOOT PATH. The only way a Worker is created
//      here is `bootVerifiedWorker`, which fetches the worker source, hashes it,
//      compares against the hash baked into this page at build time and boots
//      from a blob URL on match. A refusal installs NO client, so the mailbox
//      stays locked rather than running unverified code over the Account Key.
//      Read `worker-integrity.ts` for what this is and is not worth: it closes
//      tampering with the worker file, not an operator serving a different page.
//   2. IT BOOTS ONCE PER SESSION. Two workers would mean two key sessions, one of
//      which nothing locks.
//   3. IT DIES WITH THE SESSION. Logout locks the worker (which wipes the key
//      handles and the IndexedDB records) and then terminates it.
//
// This file holds no key material. It holds a postMessage channel.

import { onSessionTeardown } from "~/lib/session-lifecycle"
import { onAuthCleared } from "~/modules/auth/auth-store"
import {
  createMailboxCryptoClient,
  type MailboxCryptoClient,
  workerTransport,
} from "~/modules/mailbox/crypto-client"
import cryptoWorkerUrl from "~/modules/mailbox/crypto-worker?worker&url"
import {
  lockMailbox,
  mailboxStore,
  noteMailboxLockedHere,
  setMailboxCryptoClient,
} from "~/modules/mailbox/mailbox-store"
import {
  bootVerifiedWorker,
  sha256Base64,
  type WorkerBootOptions,
} from "~/modules/mailbox/worker-integrity"

/**
 * Replaced at build time by the `mailbox-worker-integrity` plugin in
 * `vite.config.ts`, which hashes the emitted worker bundle. It fails the build
 * rather than leaving this unsubstituted, so a production bundle that still
 * carries the token is not a thing that can ship: if one ever did, the boot
 * below refuses instead of pretending the check ran.
 */
const BAKED_WORKER_HASH = "__MAILBOX_WORKER_SHA256__"

/**
 * Written as a PREFIX test rather than an equality test against the token, on
 * purpose: an equality test would need a second copy of the token in this file,
 * the build plugin would substitute that copy too, and the check would compare
 * the hash against itself and always pass.
 */
function hashWasBakedIn(value: string): boolean {
  return !value.startsWith("__MAILBOX_")
}

/**
 * How often the page asks the worker whether it is still unlocked. The worker
 * wipes its own keys on the idle timeout without being asked to, and the page
 * has no other way to learn it: without this poll a timed-out mailbox keeps
 * rendering as unlocked until the next read fails.
 */
export const MAILBOX_STATUS_POLL_MS = 30_000

let bootPromise: Promise<MailboxCryptoClient | null> | null = null
let liveWorker: Worker | null = null
let statusTimer: ReturnType<typeof setInterval> | null = null

async function resolveBootOptions(): Promise<WorkerBootOptions | null> {
  if (hashWasBakedIn(BAKED_WORKER_HASH)) {
    return { url: cryptoWorkerUrl, expectedHash: BAKED_WORKER_HASH }
  }
  if (import.meta.env.PROD) {
    // A production bundle with no baked hash cannot verify anything, and a check
    // that cannot run must refuse, never wave the worker through.
    return null
  }
  // Dev and test. The dev server transforms modules on request, so there is no
  // build output to hash ahead of time and no pinning is possible here. The boot
  // still goes through the SAME verified path, over the bytes this origin just
  // served. It boots from the URL, not a blob: the dev worker is a module that
  // imports others by absolute path, which a blob URL cannot resolve, so a blob
  // boot died on load and no mailbox could be unlocked under `vite dev`.
  const response = await fetch(cryptoWorkerUrl, { credentials: "same-origin" })
  if (!response.ok) return null
  return {
    url: cryptoWorkerUrl,
    expectedHash: await sha256Base64(await response.text()),
    bootFrom: "url",
  }
}

function startStatusPoll(client: MailboxCryptoClient): void {
  if (statusTimer) return
  statusTimer = setInterval(() => {
    // Only while the page believes the mailbox is open: a locked mailbox has
    // nothing to learn and a poll on it would be noise on the channel.
    if (mailboxStore.status !== "unlocked") return
    // The page's view only. A worker that says it is locked has already
    // wiped whatever it had to (its idle timeout does); a worker that did not
    // answer in time (a throttled or suspended window, a sleeping machine)
    // cannot decrypt right now, but asking it to LOCK would delete this
    // device's handles and cost the user an unlock the login still covers.
    void client
      .refreshStatus()
      .then((unlocked) => {
        if (!unlocked) noteMailboxLockedHere()
      })
      .catch(() => noteMailboxLockedHere())
  }, MAILBOX_STATUS_POLL_MS)
}

/**
 * A worker that crashed or closed answers every request "locked" for good (the
 * transport's rule), and the unlock screen only boots a worker when there is no
 * client: without this, one crash left every later unlock failing with "reload
 * the page". Dropping the dead client lets the next unlock boot a fresh worker.
 * Nothing from the error is logged: a crash mid-operation can carry fragments of
 * what was being decrypted.
 */
function forgetWhenDead(worker: Worker): void {
  const forget = () => {
    if (liveWorker !== worker) return
    console.error("[mailbox] the crypto worker stopped; the next unlock starts a new one")
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
    liveWorker = null
    bootPromise = null
    setMailboxCryptoClient(null)
    noteMailboxLockedHere()
    worker.terminate()
  }
  worker.addEventListener("error", forget)
  worker.addEventListener("close", forget)
}

/**
 * Boot the worker and install the client on the store. Idempotent for the life
 * of a session, and never throws: a browser that cannot start the worker renders
 * a locked mailbox, which is the correct failure direction.
 */
export function startMailboxCryptoWorker(): Promise<MailboxCryptoClient | null> {
  if (bootPromise) return bootPromise
  const attempt = (async () => {
    try {
      const options = await resolveBootOptions()
      if (!options) return null
      const worker = await bootVerifiedWorker(options)
      if (!worker) return null
      liveWorker = worker
      forgetWhenDead(worker)
      const client = createMailboxCryptoClient({ post: workerTransport(worker) })
      setMailboxCryptoClient(client)
      startStatusPoll(client)
      return client
    } catch (error) {
      console.error("[mailbox] the crypto worker did not start", error)
      return null
    }
  })()
  bootPromise = attempt
  // A boot that failed is not cached: the next caller (the unlock screen's
  // retry, say) gets a fresh attempt instead of the same null forever.
  void attempt.then((client) => {
    if (!client && bootPromise === attempt) bootPromise = null
  })
  return attempt
}

/**
 * Lock, then terminate. The order matters: `lockMailbox` is what wipes the key
 * handles and the persisted records inside the worker, and a terminated worker
 * cannot be asked to wipe anything.
 */
export function stopMailboxCryptoWorker(): void {
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
  const worker = liveWorker
  liveWorker = null
  bootPromise = null
  void lockMailbox()
    .catch(() => {})
    .finally(() => {
      setMailboxCryptoClient(null)
      worker?.terminate()
    })
}

onSessionTeardown(stopMailboxCryptoWorker)
// An ended session that is not a sign-out (the server refused the refresh
// token: revoked, expired, or the password changed elsewhere) ends the unlock
// with it. The next session boots a fresh worker (startup.ts).
onAuthCleared(stopMailboxCryptoWorker)

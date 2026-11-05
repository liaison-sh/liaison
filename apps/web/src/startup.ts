// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveLocale } from "@liaison/shared"
import { bootstrapKernelApps, loadManifestApps } from "~/framework/bootstrap"
import { onSessionStart, onSessionTeardown } from "~/lib/session-lifecycle"
import {
  hasScope,
  hasSession,
  inWrappedShell,
  probeCookieSession,
  restoreSession,
} from "~/modules/auth/auth-store"
import { createSessionApiClient } from "~/modules/auth/session-api-client"
import { applyStoredLocale } from "~/modules/i18n/i18n-context"
import { startMailboxCryptoWorker } from "~/modules/mailbox/crypto-worker-boot"
import { registerMailboxKeyWipe } from "~/modules/mailbox/key-wipe"
import {
  extendMailboxDeviceLease,
  loadMailboxKeyring,
  MAIL_READ_SCOPE,
  mailboxStore,
} from "~/modules/mailbox/mailbox-store"
import { startAppBadgeSync } from "~/modules/notifications/app-badge-store"
import {
  reportBrowserTimezone,
  resetBrowserTimezoneReport,
} from "~/modules/notifications/browser-timezone"
import { ensureBillingModeLoaded } from "~/modules/settings/BillingState"
import { setAttentionApi } from "~/modules/shell/attention-store"
import { ensureBrandingLoaded, ensureSignedInOrgNameLoaded } from "~/modules/shell/branding-store"
import { rehydrateTabs } from "~/modules/shell/tab-store"
import { loadAgentDirectory } from "~/modules/threads/agent-directory"
import { loadThreads, setDefaultThreadReloadHandler } from "~/modules/threads/thread-store"
import { startThreadTabNames } from "~/modules/threads/thread-tab-names"
import { startUnreadCountSync } from "~/modules/threads/unread-count-store"

// This client's `onUnauthorized` is a deliberate no-op: it is only ever used
// for the pre-Shell window (this module's own hydration calls) plus as the
// session-level default thread-reload handler registered below. Shell's own
// AttentionLifecycle (Shell.tsx) mounts moments later with a client wired to
// the real logout-on-401 handling and takes over as the live attention/thread
// api for the rest of the session — a 401 during this narrow pre-Shell window
// simply fails the call silently rather than forcing a logout, which is an
// acceptable gap for calls this early in boot.
const startupClient = createSessionApiClient({ onUnauthorized: () => {} })

// Aggregate unread (Task 3, liaison-messaging-visibility): the thread store
// otherwise hydrates only when HomeSidebar mounts, so a session restored
// straight into Mail/Tickets never populates it and the activity-bar badge
// stays at 0. Hydrate once per session at startup instead — guarded so a
// re-entrant completeRuntimeInit (defensive; not expected in practice) can't
// double-fetch, reset on teardown so the next login re-hydrates cleanly.
// Also registers the live api client on attentionStore so the bootstrap WS
// handlers' `getAttentionApi()` calls (approval_request / scope_request /
// mail conversation / message invalidation) have a client to reload with.
// NOTE: Shell's own AttentionLifecycle (Shell.tsx) already calls
// `setAttentionApi`/`attentionStore.start` on mount — this startup call only
// matters for the pre-Shell window and to unblock this module's own thread
// hydration, which runs before Shell exists.
//
// Also registers a session-level DEFAULT thread-reload handler
// (`setDefaultThreadReloadHandler`) so the bootstrap self-heal
// (thread-unread-self-heal: an unknown threadId on a WS message) works even
// when HomeSidebar isn't mounted (user on Mail/Tickets/Settings, or Home
// closed) — before this, `requestThreadReload()` was a silent no-op unless
// HomeSidebar happened to be mounted. HomeSidebar still registers its own
// override while mounted (component-scoped API client); `requestThreadReload`
// prefers the override and falls back to this default.
let threadStoreHydrated = false

async function hydrateThreadStoreOnce(): Promise<void> {
  if (threadStoreHydrated) return
  threadStoreHydrated = true
  setAttentionApi(startupClient)
  // THE WORKSPACE'S OWN NAME, loaded here and nowhere else. `/settings/branding`
  // is a public, pre-login read: it resolves the deployment by Host slug and
  // otherwise answers with the OLDEST org on the box, which on a multi-org
  // deployment is somebody else's workspace ("Default Organization"). Surfaces
  // that tried to correct it read an api client off attentionStore inside their
  // own onMount, and at mount it is not registered yet, so the signed-in read
  // fired on none of them. It is session state, not screen state: loaded once
  // per session, from the client this module already owns, so every surface
  // that prints `orgName()` gets the same answer with no mount-order race.
  void ensureSignedInOrgNameLoaded(() => startupClient.get("/org"))
  setDefaultThreadReloadHandler(() => {
    // A self heal reload is asking about a row it has just been told exists,
    // so it needs a list composed after the telling, not one already on the
    // wire.
    void loadThreads(startupClient, { fresh: true })
  })
  // The agent directory resolves agent participants and agent message authors
  // by id; load it alongside the threads it decorates.
  void loadAgentDirectory(startupClient)
  try {
    await loadThreads(startupClient)
  } catch {
    // Best-effort — a failed initial hydration leaves the store empty; the
    // WS self-heal (unknown-threadId -> requestThreadReload) and the normal
    // resync subscription recover it on the next event.
  }
  // Tabs on conversations the list does not hold are named by a read by id,
  // from now on (before the list, every tab would miss it).
  startThreadTabNames(startupClient)
  // The Messages badge (S8, A14): the server's unread total, read once the
  // list has loaded so the local sum it tracks between reads starts settled.
  startUnreadCountSync(startupClient)
  // THE badge (rule 6): phone, dock, tab title and Home, one number.
  startAppBadgeSync(startupClient)
  // Quiet hours read the person's clock (rule 8): the browser's zone fills in
  // an unknown one.
  void reportBrowserTimezone(startupClient)
}
onSessionTeardown(() => {
  threadStoreHydrated = false
  resetBrowserTimezoneReport()
  setDefaultThreadReloadHandler(null)
})
// A session that STARTS after boot (a login on a page that was loaded logged
// out) never reaches `completeRuntimeInit`'s `hasSession()` gate, so this is
// the only thing that hydrates it. Guarded by `threadStoreHydrated`, so the
// boot path and this one cannot both fetch.
onSessionStart(() => {
  void hydrateThreadStoreOnce()
})

// The billing mode, once per session. A session that starts after boot (an
// in-app registration or sign-in, no reload) never reaches
// `completeRuntimeInit`'s `hasSession()` gate, so it is read here too: without
// it the composer's model menu stayed locked ("Upgrade to change model") until
// a reload. A token renewal is a session start as well, hence the guard.
let billingModeRequested = false
function loadBillingModeOnce(): Promise<void> {
  if (billingModeRequested) return Promise.resolve()
  billingModeRequested = true
  return ensureBillingModeLoaded(startupClient)
}
onSessionStart(() => {
  void loadBillingModeOnce()
})
onSessionTeardown(() => {
  billingModeRequested = false
})

// Mailbox key handles are wiped on logout from HERE, not from the mailbox
// store: that store is only loaded through the lazily loaded mail surface, so a
// session where the user never opened Mail wiped nothing and handles persisted
// by an earlier session outlived the logout.
registerMailboxKeyWipe()

/**
 * The mailbox crypto worker, booted from HERE for the same reason the key wipe
 * is registered here: `mailbox-store` and every surface that reads sealed mail
 * live behind the lazily loaded mail app, so nothing on the eager path was
 * starting the worker at all. Without it the store's crypto client stays null
 * for the whole session, `unlockMailbox` throws, `openSealedMessage` answers
 * null for every row and every agent decrypt request is refused as locked.
 *
 * Best effort by contract: `startMailboxCryptoWorker` never throws, and a
 * browser that cannot start the worker renders a locked mailbox rather than
 * failing startup. The `.catch` is belt and braces so a future change there
 * cannot sink `completeRuntimeInit`.
 */
let mailboxResume: Promise<void> | null = null

/** One boot-and-restore at a time: the boot path and a session start can race. */
function resumeMailbox(): Promise<void> {
  mailboxResume ??= bootMailboxCryptoWorker().finally(() => {
    mailboxResume = null
  })
  return mailboxResume
}

/**
 * Every token set is a session start (auth-store `setTokens`): a login, the
 * boot restore, and each renewal. A renewal moves the device lease of an open
 * mailbox forward; a session that began AFTER boot (a sign-in without a reload,
 * a shell whose first refresh landed late, a re-login after an ended session)
 * gets its worker and its restore here, since `completeRuntimeInit` only boots
 * the worker for a session that already existed at page load.
 */
onSessionStart(() => {
  if (mailboxStore.status === "unlocked") {
    void extendMailboxDeviceLease()
    return
  }
  // No mailbox to open: nothing to ask the server on every renewal.
  if (mailboxStore.status === "not-enrolled") return
  void resumeMailbox()
})

async function bootMailboxCryptoWorker(): Promise<void> {
  try {
    // Then re-open the mailbox from this device's persisted handles, so an
    // unlock lasts until logout on every surface (approval cards included),
    // not only once the reader visits Mail.
    // No mail access, no mailbox: the keyring read would only be refused.
    if (!hasScope(MAIL_READ_SCOPE)) return
    if (await startMailboxCryptoWorker()) await loadMailboxKeyring(startupClient)
  } catch {
    // A locked mailbox is the correct failure direction, and the mail surface
    // already renders it.
  }
}

/**
 * Apply the UI language on (re)login (I4). Precedence: the user's explicit
 * choice (null when they never picked one) > the org default locale > the
 * browser language > "en". Passing no browser fallback here used to let a
 * never-chosen language beat both. Best-effort: a prefs fetch failure must not
 * block startup (the pre-auth navigator-resolved locale from App.tsx stays).
 */
async function applyPersistedLocale(): Promise<void> {
  try {
    const prefs = await startupClient.get<{
      language?: string | null
      orgDefaultLocale?: string | null
    }>("/user/preferences")
    applyStoredLocale(
      resolveLocale(
        prefs.language,
        prefs.orgDefaultLocale,
        typeof navigator !== "undefined" ? navigator.language : null,
      ),
    )
  } catch {
    // Keep the pre-auth resolved locale (I5).
  }
}

/**
 * Phase 1 (render-early, B1): the minimum work needed before the shell can
 * paint — kernel app registration +, if a session exists, restoring it (auth
 * token validity gates almost everything downstream, so this is the one
 * roundtrip `index.tsx` awaits before calling `render()`). Logged-out visitors
 * do zero network roundtrips here — `hasSession()` false short-circuits.
 */
/** Paths a signed-out visitor lands on by themselves: no session probe there. */
const NO_PROBE_PREFIXES = ["/login", "/register", "/reset-password", "/auth/", "/demo"]

/** True when the page was opened on a link into the app, not on its front door. */
export function isDeepLinkBoot(): boolean {
  if (typeof window === "undefined") return false
  const path = window.location.pathname
  if (path === "/" || path === "") return false
  return !NO_PROBE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
}

export async function initializeAuth(): Promise<void> {
  bootstrapKernelApps()
  // A WRAPPED SHELL RESTORES WITHOUT THE FLAG (P6d-FX9). The shell holds the
  // refresh token natively, so a cold start with no `liaison:session` flag may
  // still have a session, and it is awaited here for the same reason the flag
  // case is: what renders first depends on the answer. A browser is unchanged.
  if (hasSession() || inWrappedShell()) {
    // A shell (phone, desktop) may land on its sign-in screen with no flag ever
    // read, and that screen needs `flags.demo` (a demo box sends no mail, so it
    // must not offer an emailed code). A signed-in browser needs it as much:
    // the demo strip and the key banner read `flags.demo`, and a reload lost
    // both until Chats, Work or You loaded the branding (final walk F7).
    // Started, not awaited; the read is once per page.
    void ensureBrandingLoaded()
    await restoreSession()
    return
  }
  // A deep link opened by a browser that kept the session cookie but lost the
  // flag (auth-store `probeCookieSession`): one ask, before the sign-in page.
  if (isDeepLinkBoot() && (await probeCookieSession())) return
  // NOT AWAITED, so the "logged-out visitors do zero blocking roundtrips here"
  // property above is intact. The public branding read is what tells a logged
  // out window whether this deployment is the public demo (its `flags.demo`),
  // and the login screen is the first thing that needs the answer, so the read
  // is STARTED at the earliest possible moment rather than from inside that
  // screen. A failure leaves the flag false and an ordinary login on screen.
  void ensureBrandingLoaded()
}

/**
 * Phase 2 (background, B1): everything the shell needs but that can run
 * after first paint. MUST preserve the existing `hasSession()` gate exactly —
 * a logged-out visitor (e.g. on the login page) must fire zero
 * `/user/preferences` or `/billing/state` calls, only the manifest-apps
 * fetch (itself a no-op without a token — see `fetchManifestEntries`).
 * Locale/billing/manifests run concurrently (independent reads); each
 * loader already error-isolates internally, so one rejecting must not sink
 * the others (`Promise.all` short-circuits on the FIRST rejection only for
 * the caller's await — the other two promises still run to completion
 * since they were already started; only `rehydrateTabs()` truly depends on
 * `loadManifestApps()` resolving, which is why it stays outside the
 * `Promise.all` and after it).
 */
export async function completeRuntimeInit(): Promise<void> {
  if (hasSession()) {
    await Promise.all([
      applyPersistedLocale(),
      // Load /billing/state once so settings sidebar visibility predicates
      // (Plan tab, BYOK gating) reflect the instance edition from the first
      // settings render. Best-effort — a failure leaves billingMode null,
      // matching the existing self-hosted-defaults posture.
      loadBillingModeOnce(),
      loadManifestApps(),
      hydrateThreadStoreOnce(),
      resumeMailbox(),
    ])
  } else {
    await loadManifestApps()
  }
  // Manifest apps must be registered before tab rehydration so persisted manifest
  // tabs aren't evicted as "unknown type" before their registry entries exist.
  rehydrateTabs()
}

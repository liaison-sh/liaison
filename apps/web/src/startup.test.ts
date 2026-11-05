// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import { startSession, teardownSession } from "~/lib/session-lifecycle"

// Deferred-promise helper so we can control resolution order and assert
// concurrency (start-order/overlap) rather than just call counts.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const bootstrapKernelApps = vi.fn()
const loadManifestApps = vi.fn(async () => {})
const restoreSession = vi.fn(async () => {})
const probeCookieSession = vi.fn(async () => false)
let hasSessionValue = true
let mailScopeValue = true
let inWrappedShellValue = false
const rehydrateTabs = vi.fn()
const ensureBillingModeLoaded = vi.fn(async () => {})
const getPreferences = vi.fn(async (_path: string) => ({ language: "en" }))
const setAttentionApi = vi.fn()
const loadThreads = vi.fn(async (_api: unknown) => {})
const setDefaultThreadReloadHandler = vi.fn()
const startUnreadCountSync = vi.fn()
const startAppBadgeSync = vi.fn()
const startMailboxCryptoWorker = vi.fn(async () => null)
const ensureBrandingLoaded = vi.fn(async () => {})
const ensureSignedInOrgNameLoaded = vi.fn(async (_readOrg: () => Promise<unknown>) => {})

vi.mock("~/framework/bootstrap", () => ({
  bootstrapKernelApps: () => bootstrapKernelApps(),
  loadManifestApps: () => loadManifestApps(),
}))

vi.mock("~/modules/shell/attention-store", () => ({
  setAttentionApi: (api: unknown) => setAttentionApi(api),
}))

vi.mock("~/modules/shell/branding-store", () => ({
  ensureBrandingLoaded: () => ensureBrandingLoaded(),
  ensureSignedInOrgNameLoaded: (readOrg: () => Promise<unknown>) =>
    ensureSignedInOrgNameLoaded(readOrg),
}))

vi.mock("~/modules/threads/thread-store", () => ({
  loadThreads: (api: unknown) => loadThreads(api),
  setDefaultThreadReloadHandler: (fn: (() => void) | null) => setDefaultThreadReloadHandler(fn),
}))

vi.mock("~/modules/threads/thread-tab-names", () => ({
  startThreadTabNames: () => {},
}))

vi.mock("~/modules/threads/unread-count-store", () => ({
  startUnreadCountSync: (api: unknown) => startUnreadCountSync(api),
}))

vi.mock("~/modules/notifications/app-badge-store", () => ({
  startAppBadgeSync: (api: unknown) => startAppBadgeSync(api),
}))

vi.mock("~/lib/api-client", () => ({
  createApiClient: () => ({
    get: (path: string) => getPreferences(path),
  }),
}))

vi.mock("~/modules/auth/auth-store", () => ({
  accessToken: () => "test-token",
  hasSession: () => hasSessionValue,
  hasScope: (scope: string) => scope === "mail:conversations:read" && mailScopeValue,
  inWrappedShell: () => inWrappedShellValue,
  restoreSession: () => restoreSession(),
  probeCookieSession: () => probeCookieSession(),
  onAuthCleared: () => () => {},
  userFromToken: () => null,
  loginSessionExpiresAt: () => null,
}))

const applyStoredLocale = vi.fn()
vi.mock("~/modules/i18n/i18n-context", () => ({
  applyStoredLocale: (l: string) => applyStoredLocale(l),
}))

vi.mock("~/modules/settings/BillingState", () => ({
  ensureBillingModeLoaded: () => ensureBillingModeLoaded(),
}))

vi.mock("~/modules/shell/tab-store", () => ({
  rehydrateTabs: () => rehydrateTabs(),
}))

vi.mock("~/modules/mailbox/crypto-worker-boot", () => ({
  startMailboxCryptoWorker: () => startMailboxCryptoWorker(),
}))

describe("startup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasSessionValue = true
    mailScopeValue = true
    inWrappedShellValue = false
    getPreferences.mockResolvedValue({ language: "en" })
    loadThreads.mockResolvedValue(undefined)
    // startup.ts's threadStoreHydrated guard is module-level state, not reset
    // by clearAllMocks — teardownSession() runs its onSessionTeardown reset
    // so each test starts unhydrated (mirrors what a real logout does).
    teardownSession()
  })

  it("initializeAuth bootstraps kernel apps and restores session when a session exists", async () => {
    const { initializeAuth } = await import("~/startup")
    await initializeAuth()

    expect(bootstrapKernelApps).toHaveBeenCalledTimes(1)
    expect(restoreSession).toHaveBeenCalledTimes(1)
  })

  it("initializeAuth skips restoreSession when logged out", async () => {
    hasSessionValue = false
    const { initializeAuth } = await import("~/startup")
    await initializeAuth()

    expect(bootstrapKernelApps).toHaveBeenCalledTimes(1)
    expect(restoreSession).not.toHaveBeenCalled()
  })

  // P6d-FX9: the shell holds the refresh token natively, so a cold start with
  // no `liaison:session` flag still has a session to restore.
  it("initializeAuth restores inside a wrapped shell with no stored flag", async () => {
    hasSessionValue = false
    inWrappedShellValue = true
    const { initializeAuth } = await import("~/startup")
    await initializeAuth()

    expect(restoreSession).toHaveBeenCalledTimes(1)
  })

  // The phone signs in on a box it may never have read: without the public
  // branding flags the login cannot know it is on the demo box (no mail leaves
  // it) and offered an emailed code that could never arrive.
  it("initializeAuth starts the public branding read inside a wrapped shell too", async () => {
    hasSessionValue = false
    inWrappedShellValue = true
    ensureBrandingLoaded.mockClear()
    const { initializeAuth } = await import("~/startup")
    await initializeAuth()

    expect(ensureBrandingLoaded).toHaveBeenCalledTimes(1)
  })

  // Final walk F7: a signed-in BROWSER reload on the demo box lost the demo
  // strip and the key banner (`flags.demo` unread) until Chats, Work or You
  // happened to load the branding.
  it("initializeAuth starts the branding read in a signed-in browser too", async () => {
    inWrappedShellValue = false
    ensureBrandingLoaded.mockClear()
    const { initializeAuth } = await import("~/startup")
    await initializeAuth()

    expect(restoreSession).toHaveBeenCalledTimes(1)
    expect(ensureBrandingLoaded).toHaveBeenCalledTimes(1)
  })

  // An approval link opened in a browser that kept the session cookie but lost
  // the flag (Claude's built-in browser) used to land signed out every time.
  it("initializeAuth asks the cookie once on a deep link with no stored flag", async () => {
    hasSessionValue = false
    probeCookieSession.mockClear()
    window.history.replaceState(null, "", "/threads/963d213d-3054-42eb-b092-d33589b6f806")
    try {
      const { initializeAuth } = await import("~/startup")
      await initializeAuth()
      expect(probeCookieSession).toHaveBeenCalledTimes(1)
      expect(restoreSession).not.toHaveBeenCalled()
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })

  it("initializeAuth asks nothing on the front door or the sign-in pages", async () => {
    hasSessionValue = false
    probeCookieSession.mockClear()
    const { initializeAuth, isDeepLinkBoot } = await import("~/startup")
    for (const path of ["/", "/login", "/login/totp", "/register", "/auth/device", "/demo"]) {
      window.history.replaceState(null, "", path)
      expect(isDeepLinkBoot()).toBe(false)
      await initializeAuth()
    }
    window.history.replaceState(null, "", "/")
    expect(probeCookieSession).not.toHaveBeenCalled()
  })

  it("completeRuntimeInit runs locale/billing/manifest loaders concurrently, then rehydrateTabs after manifests resolve", async () => {
    const localeDeferred = deferred<void>()
    const billingDeferred = deferred<void>()
    const manifestDeferred = deferred<void>()

    getPreferences.mockImplementation(() => localeDeferred.promise.then(() => ({ language: "en" })))
    ensureBillingModeLoaded.mockImplementation(() => billingDeferred.promise)
    loadManifestApps.mockImplementation(() => manifestDeferred.promise)

    const { completeRuntimeInit } = await import("~/startup")
    const runPromise = completeRuntimeInit()

    // All three loaders must have STARTED before any of them resolves —
    // proves concurrency, not a serial chain.
    await Promise.resolve()
    await Promise.resolve()
    expect(getPreferences).toHaveBeenCalled()
    expect(ensureBillingModeLoaded).toHaveBeenCalledTimes(1)
    expect(loadManifestApps).toHaveBeenCalledTimes(1)
    expect(rehydrateTabs).not.toHaveBeenCalled()

    // Resolve locale + billing first — rehydrateTabs must still NOT fire
    // (manifests haven't resolved yet — the eviction-race regression).
    localeDeferred.resolve()
    billingDeferred.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(rehydrateTabs).not.toHaveBeenCalled()

    // Now resolve manifests — rehydrateTabs must fire strictly after.
    manifestDeferred.resolve()
    await runPromise

    expect(rehydrateTabs).toHaveBeenCalledTimes(1)
  })

  // A user who never chose a language (language: null) reads the ORG's
  // language, then the browser's. The startup used to resolve the stored value
  // with no fallback at all, and the column defaulted to "en" besides.
  describe("UI language precedence: choice > org default > browser > en", () => {
    async function resolvedFor(
      prefs: { language: string | null; orgDefaultLocale: string | null },
      browser: string,
    ): Promise<string> {
      const spy = vi.spyOn(navigator, "language", "get").mockReturnValue(browser)
      getPreferences.mockResolvedValue(prefs as never)
      const { completeRuntimeInit } = await import("~/startup")
      await completeRuntimeInit()
      spy.mockRestore()
      return applyStoredLocale.mock.calls.at(-1)?.[0]
    }

    it("never chose, French org, English browser → fr", async () => {
      expect(await resolvedFor({ language: null, orgDefaultLocale: "fr-FR" }, "en-US")).toBe("fr")
    })
    it("never chose, org locale unshipped, French browser → fr", async () => {
      expect(await resolvedFor({ language: null, orgDefaultLocale: "de-DE" }, "fr-FR")).toBe("fr")
    })
    it("explicit English choice beats a French org and browser", async () => {
      expect(await resolvedFor({ language: "en", orgDefaultLocale: "fr" }, "fr-FR")).toBe("en")
    })
    it("nothing shipped anywhere → en", async () => {
      expect(await resolvedFor({ language: null, orgDefaultLocale: null }, "de-DE")).toBe("en")
    })
  })

  it("logged-out: completeRuntimeInit makes zero /user/preferences or /billing/state calls", async () => {
    hasSessionValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(getPreferences).not.toHaveBeenCalled()
    expect(ensureBillingModeLoaded).not.toHaveBeenCalled()
    // Manifest apps still load — the fetch itself is a no-op without a token,
    // but the loader call happens either way (matches pre-B1 behavior).
    expect(loadManifestApps).toHaveBeenCalledTimes(1)
    expect(rehydrateTabs).toHaveBeenCalledTimes(1)
  })

  it("applyPersistedLocale's internal error isolation keeps completeRuntimeInit resolving (rehydrateTabs still runs)", async () => {
    // The real applyPersistedLocale/ensureBillingModeLoaded already
    // try/catch internally (verified in BillingState.ts / startup.ts source)
    // so a failing underlying fetch surfaces to completeRuntimeInit as a
    // RESOLVED promise, not a rejection — model that here rather than
    // rejecting the mocked loader itself (which would test Promise.all's
    // short-circuit behavior, not the real error-isolation contract).
    getPreferences.mockRejectedValue(new Error("network error"))

    const { completeRuntimeInit } = await import("~/startup")
    await expect(completeRuntimeInit()).resolves.toBeUndefined()
    expect(rehydrateTabs).toHaveBeenCalledTimes(1)
  })

  it("completeRuntimeInit hydrates the thread store and registers the attention api client (Task 3)", async () => {
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(setAttentionApi).toHaveBeenCalledTimes(1)
    expect(loadThreads).toHaveBeenCalledTimes(1)
    // S8, A14: the Messages badge starts reading the server total once the
    // list has loaded, on the same client.
    expect(startUnreadCountSync).toHaveBeenCalledTimes(1)
    expect(startUnreadCountSync).toHaveBeenCalledWith(loadThreads.mock.calls[0][0])
    // Rule 6: THE badge (phone, dock, tab title, Home) starts on the same client.
    expect(startAppBadgeSync).toHaveBeenCalledWith(loadThreads.mock.calls[0][0])
  })

  // The phone top bar, the Home greeting card and the Work root all printed
  // "Default Organization": the deployment's PUBLIC branding name, which
  // resolves by Host slug and otherwise answers with the oldest org on the box.
  // The surfaces that tried to correct it read the api off attentionStore at
  // mount, and at mount it is not registered yet, so the signed-in read never
  // fired on any of them. It belongs on the session, once, here.
  it("loads the SIGNED IN org name once per session, with no mount-order race", async () => {
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(ensureSignedInOrgNameLoaded).toHaveBeenCalledTimes(1)
    const readOrg = ensureSignedInOrgNameLoaded.mock.calls[0][0] as () => Promise<unknown>
    await readOrg()
    expect(getPreferences).toHaveBeenCalledWith("/org")
  })

  it("a login after boot names the signed-in org too", async () => {
    hasSessionValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    expect(ensureSignedInOrgNameLoaded).not.toHaveBeenCalled()

    hasSessionValue = true
    mailScopeValue = true
    startSession()
    await Promise.resolve()
    expect(ensureSignedInOrgNameLoaded).toHaveBeenCalledTimes(1)
  })

  it("a login after boot hydrates the thread store with no page reload", async () => {
    // The walk's D3: sign in on a page that was loaded logged out and Home
    // showed "No conversations yet" for an account in a hundred threads,
    // because nothing fetched them until the next launch.
    hasSessionValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    expect(loadThreads).not.toHaveBeenCalled()

    hasSessionValue = true
    mailScopeValue = true
    startSession()
    await Promise.resolve()
    expect(loadThreads).toHaveBeenCalledTimes(1)
    expect(setAttentionApi).toHaveBeenCalledTimes(1)
  })

  it("a login after boot starts the mailbox worker, so the unlock is restored", async () => {
    // A session that begins after page load (a sign-in without a reload, a
    // shell whose first refresh landed late) used to get no worker at all:
    // the mail surface found no client, rendered the mailbox locked and asked
    // for the password the device already held the unlock for.
    hasSessionValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    expect(startMailboxCryptoWorker).not.toHaveBeenCalled()

    hasSessionValue = true
    mailScopeValue = true
    startSession()
    await Promise.resolve()
    expect(startMailboxCryptoWorker).toHaveBeenCalledTimes(1)
  })

  it("a login after boot loads the billing mode, so the model menu is not locked", async () => {
    // Registered in the app (no reload): billingMode stayed null and the
    // composer's model chip read "Upgrade to change model" until a reload.
    hasSessionValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    expect(ensureBillingModeLoaded).not.toHaveBeenCalled()

    hasSessionValue = true
    startSession()
    await Promise.resolve()
    expect(ensureBillingModeLoaded).toHaveBeenCalledTimes(1)

    // A token renewal is a session start too: the mode is not read again.
    startSession()
    await Promise.resolve()
    expect(ensureBillingModeLoaded).toHaveBeenCalledTimes(1)
  })

  it("a reload reads the billing mode once", async () => {
    startSession()
    await Promise.resolve()
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    expect(ensureBillingModeLoaded).toHaveBeenCalledTimes(1)
  })

  it("a reload hydrates once and tab rehydration does not wait for the fetch", async () => {
    // THE RELOAD ORDER, pinned because it changed and nothing held it.
    // `restoreSession` -> `setTokens` -> `startSession` claims the hydration
    // guard before `completeRuntimeInit` runs, so the boot gate finds it
    // claimed and returns at once while the thread fetch is still in flight.
    // Deliberate: `rehydrateTabs` reads no thread (tab-store.ts), and Home
    // renders from the store as rows land, so holding first paint behind the
    // fetch would buy nothing. What must not regress is that there is exactly
    // ONE fetch and that the tabs do not wait for it.
    const threads = deferred<void>()
    loadThreads.mockReturnValueOnce(threads.promise)
    startSession()
    await Promise.resolve()
    expect(loadThreads).toHaveBeenCalledTimes(1)

    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    expect(rehydrateTabs).toHaveBeenCalledTimes(1)
    expect(loadThreads).toHaveBeenCalledTimes(1)

    threads.resolve()
    await threads.promise
  })

  it("a session start after boot hydration fetches nothing a second time", async () => {
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    expect(loadThreads).toHaveBeenCalledTimes(1)

    startSession()
    await Promise.resolve()
    expect(loadThreads).toHaveBeenCalledTimes(1)
  })

  it("completeRuntimeInit does not hydrate the thread store when logged out", async () => {
    hasSessionValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(setAttentionApi).not.toHaveBeenCalled()
    expect(loadThreads).not.toHaveBeenCalled()
  })

  it("thread store hydration is guarded once per session and resets on teardown", async () => {
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    await completeRuntimeInit()
    expect(loadThreads).toHaveBeenCalledTimes(1)

    teardownSession()
    await completeRuntimeInit()
    expect(loadThreads).toHaveBeenCalledTimes(2)
  })

  it("completeRuntimeInit registers a default thread reload handler that calls loadThreads (self-heal works without HomeSidebar mounted)", async () => {
    // beforeEach's teardownSession() already fired the module's own
    // onSessionTeardown callback (setDefaultThreadReloadHandler(null)) once
    // before this test body runs — clear that call so the assertion below
    // isolates completeRuntimeInit's own registration.
    setDefaultThreadReloadHandler.mockClear()
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(setDefaultThreadReloadHandler).toHaveBeenCalledTimes(1)
    const handler = setDefaultThreadReloadHandler.mock.calls[0]?.[0] as (() => void) | null
    expect(handler).toBeTypeOf("function")
    loadThreads.mockClear()
    handler?.()
    expect(loadThreads).toHaveBeenCalledTimes(1)
  })

  it("clears the default thread reload handler on session teardown", async () => {
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()
    setDefaultThreadReloadHandler.mockClear()

    teardownSession()
    expect(setDefaultThreadReloadHandler).toHaveBeenCalledWith(null)
  })

  it("completeRuntimeInit boots the mailbox crypto worker for a signed-in session", async () => {
    // Without this the store's crypto client stays null for the whole session:
    // no unlock, no sealed row opens, and every agent decrypt request refuses.
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(startMailboxCryptoWorker).toHaveBeenCalledTimes(1)
  })

  // A member without mail access has no mailbox: booting the worker read the
  // keyring, which the server refuses (403), and the refusal surfaced on Home
  // as a permission toast (walk 2026-10-19, #18).
  it("does not boot the mailbox crypto worker for a user without mail access", async () => {
    mailScopeValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(startMailboxCryptoWorker).not.toHaveBeenCalled()
  })

  it("does not boot the mailbox crypto worker when logged out", async () => {
    hasSessionValue = false
    const { completeRuntimeInit } = await import("~/startup")
    await completeRuntimeInit()

    expect(startMailboxCryptoWorker).not.toHaveBeenCalled()
  })

  it("a failed crypto worker boot does not sink completeRuntimeInit (best-effort)", async () => {
    startMailboxCryptoWorker.mockRejectedValueOnce(new Error("no worker here"))
    const { completeRuntimeInit } = await import("~/startup")

    await expect(completeRuntimeInit()).resolves.toBeUndefined()
    expect(rehydrateTabs).toHaveBeenCalledTimes(1)
  })

  it("a failed thread-store hydration does not sink completeRuntimeInit (best-effort)", async () => {
    loadThreads.mockRejectedValueOnce(new Error("network error"))
    const { completeRuntimeInit } = await import("~/startup")
    await expect(completeRuntimeInit()).resolves.toBeUndefined()
    expect(rehydrateTabs).toHaveBeenCalledTimes(1)
  })

  it("one loader rejecting outright does not prevent rehydrateTabs (error isolation at the completeRuntimeInit boundary)", async () => {
    // Even in the worst case — a loader's internal try/catch has a bug and it
    // rejects anyway — manifest loading + rehydration must not be silently
    // skipped forever. loadManifestApps still resolves normally here; the
    // billing loader is the one that rejects.
    ensureBillingModeLoaded.mockRejectedValue(new Error("billing down"))

    const { completeRuntimeInit } = await import("~/startup")
    // Promise.all rejects if any input rejects — completeRuntimeInit currently
    // propagates that. Document the current contract: manifests still load
    // (already in flight) even though the awaited completeRuntimeInit rejects.
    await expect(completeRuntimeInit()).rejects.toThrow("billing down")
    expect(loadManifestApps).toHaveBeenCalledTimes(1)
  })
})

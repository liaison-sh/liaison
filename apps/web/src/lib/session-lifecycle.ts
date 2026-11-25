// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Session lifecycle registry.
 *
 * Stores self-register their cleanup via `onSessionTeardown(resetFn)` at module
 * scope. On logout, a single `teardownSession()` call resets everything — no
 * manual import list to maintain. See `session-lifecycle-enforcement.test.ts`
 * for the convention guard that catches stores that forget to register.
 *
 * The registry has a second half, and it exists for the same reason: work that
 * has to happen when a session BEGINS. Boot-time hydration ran once per page
 * load behind a `hasSession()` gate, so a fresh login (which starts a session
 * without reloading the page) hydrated nothing at all, and the surfaces that
 * read those stores rendered their empty state against a full account.
 */

type TeardownFn = () => void
type StartFn = () => void

const registry = new Set<TeardownFn>()
const startRegistry = new Set<StartFn>()

/** Register a function to run when the session ends (logout).
 *  Returns a disposer. Same function reference is deduplicated. */
export function onSessionTeardown(fn: TeardownFn): () => void {
  registry.add(fn)
  return () => {
    registry.delete(fn)
  }
}

/** Run all registered teardowns (LIFO). Failures are isolated. */
export function teardownSession(): void {
  const fns = [...registry].reverse()
  for (const fn of fns) {
    try {
      fn()
    } catch (e) {
      console.warn("[session-lifecycle] teardown error:", e)
    }
  }
}

/** Register work to run when a session BEGINS (login, or a restored token).
 *  Returns a disposer. Same function reference is deduplicated. */
export function onSessionStart(fn: StartFn): () => void {
  startRegistry.add(fn)
  return () => {
    startRegistry.delete(fn)
  }
}

/** Run all registered session-start handlers. Failures are isolated, and a
 *  handler is expected to be idempotent: a token refresh starts no new
 *  session but is indistinguishable from here. */
export function startSession(): void {
  for (const fn of [...startRegistry]) {
    try {
      fn()
    } catch (e) {
      console.warn("[session-lifecycle] start error:", e)
    }
  }
}

type BeforeSignOutFn = () => Promise<void> | void

const beforeSignOutRegistry = new Set<BeforeSignOutFn>()

/** How long a sign-out waits for its before-sign-out work. */
const BEFORE_SIGN_OUT_BOUND_MS = 5_000

/** Register work that must happen BEFORE a sign-out, while the session still
 *  authenticates it (a decision still inside its Undo window is sent).
 *  Returns a disposer. Same function reference is deduplicated. */
export function onBeforeSignOut(fn: BeforeSignOutFn): () => void {
  beforeSignOutRegistry.add(fn)
  return () => {
    beforeSignOutRegistry.delete(fn)
  }
}

/** Run every before-sign-out handler and wait for them, within a bound: a
 *  server that never answers does not keep the person signed in. Failures are
 *  isolated. Every sign-out path (the browser's and the phone shell's) runs
 *  this first. */
export async function runBeforeSignOut(): Promise<void> {
  const all = Promise.allSettled([...beforeSignOutRegistry].map((fn) => Promise.resolve().then(fn)))
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BEFORE_SIGN_OUT_BOUND_MS)
  })
  await Promise.race([all, bound])
  clearTimeout(timer)
}

export interface SignOutContext {
  /** Nothing can be saved or asked (the account is deleted, the demo workspace ended). */
  forced: boolean
}
type SignOutGuardFn = (ctx: SignOutContext) => Promise<boolean>

const signOutGuards = new Set<SignOutGuardFn>()

/**
 * Register a check that runs BEFORE an explicit sign-out, while the session still
 * authenticates its requests: it saves what it can, and answers false when the
 * person chose to stay signed in (text that could not be saved). Returns a
 * disposer. Same function reference is deduplicated.
 */
export function onSignOutGuard(fn: SignOutGuardFn): () => void {
  signOutGuards.add(fn)
  return () => {
    signOutGuards.delete(fn)
  }
}

/**
 * May this explicit sign-out go on? Every guard must answer yes. There is no time
 * bound: the person decides. A guard that throws counts as a no (it could not
 * say that nothing would be lost). Session expiry, revocation and another tab's
 * sign-out never come here: they lose nothing, so there is nothing to ask.
 */
export async function confirmSignOut(ctx: SignOutContext = { forced: false }): Promise<boolean> {
  for (const fn of [...signOutGuards]) {
    try {
      if (!(await fn(ctx))) return false
    } catch (e) {
      console.warn("[session-lifecycle] sign-out guard error:", e)
      if (!ctx.forced) return false
    }
  }
  return true
}

/** @internal — test isolation only */
export function _resetRegistry(): void {
  registry.clear()
  startRegistry.clear()
  beforeSignOutRegistry.clear()
  signOutGuards.clear()
}

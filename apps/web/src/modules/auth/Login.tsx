// SPDX-License-Identifier: FSL-1.1-ALv2

import { A, useNavigate, useSearchParams } from "@solidjs/router"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { ApiError, anonApiClient } from "~/lib/api-client"
import { authApiPath, authApiUrl, serverAddressOverride } from "~/lib/env"
import { formatRetryDelay } from "~/lib/format-retry"
import { log } from "~/lib/logger"
import { isNativeShell, nativeAuthenticate } from "~/lib/native-bridge"
import { safeReturnTo } from "~/lib/safe-return-to"
import { takeAccountDeletedNotice } from "~/modules/auth/account-deleted-notice"
import {
  bouncedByUnreachable,
  consumeUnreachableBounce,
  inWrappedShell,
  isAuthenticated,
  retryRestore,
  serverUnreachable,
  setChallengeToken,
  setTokens,
} from "~/modules/auth/auth-store"
import {
  beginDesktopOAuth,
  cancelDesktopOAuth,
  completeDesktopOAuth,
  desktopOAuthPending,
  reopenDesktopOAuth,
  signInInSession,
} from "~/modules/auth/desktop-oauth"
import LoginServerChoice from "~/modules/auth/LoginServerChoice"
import { DemoEntry } from "~/modules/demo/DemoEntry"
import DesktopConnect from "~/modules/desktop/DesktopConnect"
import DesktopDeviceApproval from "~/modules/desktop/DesktopDeviceApproval"
import {
  canSignInWithSystemBrowser,
  desktopState,
  dismissConnect,
  isDesktop,
  onOAuthCompleteLink,
  serverAddress,
} from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { demoMode } from "~/modules/shell/branding-store"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

const authLog = log.child({ component: "Login" })

interface AuthResponse {
  accessToken?: string
  refreshToken?: string
  totpRequired?: boolean
  challengeToken?: string
}

interface MagicRequestResponse {
  challengeId: string
  message: string
}

interface OAuthProvider {
  id: string
  name: string
}

type Step = "email" | "code" | "password"

const GoogleIcon: Component = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
)

const providerButtonClass =
  "flex h-9 w-full items-center justify-center gap-2 rounded-sm border border-border bg-transparent text-[13px] font-medium text-text-secondary transition-all duration-150 hover:border-border-strong hover:bg-surface-hover hover:text-text"

const Login: Component = () => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [step, setStep] = createSignal<Step>("email")
  const [email, setEmail] = createSignal("")
  const [code, setCode] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [challengeId, setChallengeId] = createSignal("")
  const [error, setError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  // Read once, as the screen opens: an account deletion just signed out.
  const accountDeleted = takeAccountDeletedNotice()
  // Read once, as the screen opens: a password reset just finished (ResetPasswordConfirm).
  const passwordWasReset = searchParams.reset === "success"
  const [loading, setLoading] = createSignal(false)
  const [providersUnreachable, setProvidersUnreachable] = createSignal(false)

  /**
   * P6d-T15: THE DESKTOP'S TWO STEPS, IN THIS CARD.
   *
   * A desktop that does not know which Liaison it is talking to cannot ask for
   * an email yet, so the same card asks for the server address first, and then
   * for this device to be approved. One step at a time: the grant REPLACES the
   * address step rather than stacking over it, which is what the walk caught.
   *
   * A desktop already bound to a server, and a browser, get the ordinary
   * login below, unchanged.
   */
  const [rebinding, setRebinding] = createSignal(false)
  /**
   * The address step is also where "Add a server..." (the servers UI)
   * and a `liaison://connect` link land on a window nobody is signed in to:
   * the step asks, the user confirms, and nothing is applied before that.
   */
  const connectRequested = () =>
    isDesktop() && (desktopState().addingServer === true || Boolean(desktopState().deepLinkAddress))
  const needsServerAddress = () =>
    isDesktop() && (rebinding() || serverAddress() === null || connectRequested())
  const awaitingDeviceApproval = () => isDesktop() && desktopState().deviceApproval !== null
  const desktopStep = () => awaitingDeviceApproval() || needsServerAddress()

  /**
   * THE ADDRESS FIELD IS OFFERED, NOT SUBSTITUTED, when a server that was
   * already bound stops answering: the account this install signs into has
   * not changed, so taking the email form away would be answering a question
   * nobody asked. An install with no address at all is a different case and
   * still gets the field alone, as its only first step.
   */
  const showConnectField = () =>
    isDesktop() &&
    !awaitingDeviceApproval() &&
    (needsServerAddress() || serverUnreachable() || retrying())

  /**
   * THE SERVER THIS INSTALL IS BOUND TO DID NOT ANSWER (P6d-FX11).
   *
   * A shell mirrors the last address it bound into the page, so a stale one
   * (a dev server that is gone, a box behind a VPN that is off, a server that
   * moved) is what every request goes to, boot refresh included. That used to
   * end at an endless "Restoring session" splash with no way through. The
   * store now says so in words and this card is where it is said, above the
   * connect field that is the way out of it.
   */
  const [retrying, setRetrying] = createSignal(false)
  /** A shell that cannot offer the address field must not say to check it. */
  const unreachableMessageKey = () =>
    isDesktop() ? "kernel.serverNotAnsweringYet" : "kernel.serverNotAnsweringYetNoAddress"
  const unreachableHost = () => {
    const raw = serverAddress() ?? serverAddressOverride()
    if (!raw) return ""
    try {
      return new URL(raw).host
    } catch {
      return raw
    }
  }

  async function retryConnection() {
    if (retrying()) return
    setRetrying(true)
    try {
      await retryRestore()
    } finally {
      setRetrying(false)
    }
  }

  /**
   * THE DEMO DOORS, IN PLACE OF THIS CARD.
   *
   * A stranger landing on the demo box is bounced here by ProtectedRoute, and
   * an email field is the wrong thing to show somebody who has no account and
   * is not about to make one. So on a deployment the SERVER says is a demo
   * (branding-store.demoMode, read from the public branding flags), this route
   * renders the entry screen instead, and the ordinary form is one click away
   * behind `?signin=1`. On every other deployment `demoMode()` is false, this
   * is inert, and the card below is byte for byte what it was.
   *
   * A desktop shell is excluded: it has its own two-step server-address and
   * device-grant flow in this card, and a demo box is not what it is binding
   * to.
   *
   * The flag is FETCHED IN startup.ts, not here: this screen renders before
   * any session exists, and starting the read at boot means it has usually
   * landed by first paint. A read started here would instead be the login
   * page's first network call, which is a roundtrip every deployment pays for
   * a question only the demo box answers differently.
   */
  const wantsOrdinarySignIn = () => searchParams.signin === "1"
  const showDemoEntry = () =>
    demoMode() && !isDesktop() && !inNativeMobileShell() && !wantsOrdinarySignIn()

  /**
   * THE NATIVE MOBILE SHELL CREATES NO ACCOUNT (App Store guideline 4.8's
   * business app exemption rests on it): no "Create an account" link and no
   * demo visitor door. Accounts come from an admin's invite; Google sign in of
   * an address nobody invited is refused by the server with the same words.
   * Signing in, by code, password or provider, is unchanged.
   */
  const inNativeMobileShell = () => isNativeShell()

  /**
   * NO EMAIL CODE WHERE NO MAIL LEAVES THE BOX.
   *
   * A demo instance refuses every outbound mail, for the whole instance, so a
   * sign-in code requested there can never arrive (the owner's phone once sat
   * on "enter the 6-digit code" for one). On such a box the card leads with the
   * password and offers no email code. The flag is the public, instance-wide
   * one the demo doors already read, so it says nothing about any account. If
   * it has not landed when somebody asks for a code anyway, the server's own
   * instance-wide refusal (EMAIL_SIGN_IN_UNAVAILABLE) lands them here too.
   */
  const emailCodeOffered = () => !demoMode()
  createEffect(() => {
    if (!emailCodeOffered() && step() !== "password") {
      setCode("")
      setStep("password")
    }
  })

  // OAuth state scoped to component lifecycle
  let oauthState: string | null = null
  function getOAuthState(): string {
    if (!oauthState) {
      oauthState = crypto.randomUUID()
      sessionStorage.setItem("oauth_state", oauthState)
      const returnTo = safeReturnTo(searchParams.returnTo as string | undefined)
      if (returnTo !== "/") {
        sessionStorage.setItem("oauth_return_to", returnTo)
      } else {
        sessionStorage.removeItem("oauth_return_to")
      }
    }
    return oauthState
  }
  onCleanup(() => {
    oauthState = null
  })

  function oauthAuthorizeUrl(base: string): string {
    return `${base}?state=${encodeURIComponent(getOAuthState())}`
  }

  const api = anonApiClient

  /**
   * The server names an OAuth failure in English; the reader gets it in their
   * language, and anything unknown reads as the generic failure.
   */
  function oauthErrorMessage(oauthError: string): string {
    const knownErrors: Record<string, string> = {
      "Account deactivated": "kernel.auth.oauthDeactivated",
      "No matching account": "kernel.auth.oauthNoAccount",
      "An account with this email exists. Sign in with your existing method":
        "kernel.auth.oauthAccountExists",
      "OAuth authentication failed": "kernel.auth.oauthFailed",
    }
    return i18n.t(knownErrors[oauthError] ?? "kernel.auth.authFailed")
  }

  onMount(() => {
    oauthState = null
    const oauthError = searchParams.error as string | undefined
    if (oauthError) setError(oauthErrorMessage(oauthError))
  })

  /**
   * THE DESKTOP SIGNS IN THROUGH THE SYSTEM BROWSER (desktop-oauth.ts).
   *
   * A provider button in the desktop app opens the user's own browser and this
   * card waits; the sign-in comes back as a `liaison://oauth-complete` link the
   * shell forwards here. The window itself never navigates to the provider:
   * an embedded webview is refused by Google and cannot reach the platform
   * passkey store. A browser keeps the plain navigation below, unchanged.
   */
  const useSystemBrowser = () => isDesktop() && canSignInWithSystemBrowser()
  const waitingForBrowser = () => useSystemBrowser() && desktopOAuthPending() !== null

  async function startDesktopSignIn(provider: OAuthProvider) {
    setError("")
    const opened = await beginDesktopOAuth({
      authorizeBase: authApiUrl(`/oauth/${encodeURIComponent(provider.id)}/authorize`),
      provider: provider.name,
      returnTo: returnTo(),
    })
    if (!opened) setError(i18n.t("kernel.auth.desktopBrowserDidNotOpen"))
  }

  /**
   * THE iOS SHELL SIGNS IN THROUGH ITS AUTHENTICATION SESSION (desktop-oauth.ts,
   * signInInSession): the sheet opens over the app, the callback comes back to
   * this call, and the code is redeemed with this page's verifier. A shell
   * that cannot run one answers null, and the page keeps its web navigation.
   */
  async function startSessionSignIn(provider: OAuthProvider, webUrl: string) {
    const authenticate = nativeAuthenticate()
    if (!authenticate) {
      window.location.assign(webUrl)
      return
    }
    setError("")
    const result = await signInInSession(
      {
        authorizeBase: authApiUrl(`/oauth/${encodeURIComponent(provider.id)}/authorize`),
        provider: provider.name,
        returnTo: returnTo(),
      },
      authenticate,
    )
    if (result.kind === "signedIn") {
      setTokens(result.accessToken)
      navigate(result.returnTo, { replace: true })
    } else if (result.kind === "totp") {
      toTotpStep(result.challengeToken, result.returnTo)
    } else if (result.kind === "error") {
      setError(oauthErrorMessage(result.error))
    } else if (result.kind === "unavailable") {
      window.location.assign(webUrl)
    }
  }

  async function reopenBrowser() {
    setError("")
    if (!(await reopenDesktopOAuth())) setError(i18n.t("kernel.auth.desktopBrowserDidNotOpen"))
  }

  onMount(() => {
    const stop = onOAuthCompleteLink((link) => {
      void completeDesktopOAuth(link).then((result) => {
        if (result.kind === "signedIn") {
          setTokens(result.accessToken)
          navigate(result.returnTo, { replace: true })
        } else if (result.kind === "totp") {
          toTotpStep(result.challengeToken, result.returnTo)
        } else if (result.kind === "error") {
          setError(oauthErrorMessage(result.error))
        }
      })
    })
    onCleanup(stop)
  })

  // A provider is only renderable once it has both an id to authorize against
  // and a name to put on the button. An entry missing either one used to render
  // a nameless "Continue with" button.
  function isRenderableProvider(entry: unknown): entry is OAuthProvider {
    if (typeof entry !== "object" || entry === null) return false
    const { id, name } = entry as Partial<OAuthProvider>
    return typeof id === "string" && id.length > 0 && typeof name === "string" && name.trim() !== ""
  }

  const [providers] = createResource(async () => {
    try {
      const list = await api.get<OAuthProvider[]>(authApiPath("/oauth/providers"))
      // A reachable host that is not the API answers this with something else
      // entirely: the Capacitor webview serves its own index.html for every
      // unknown path, and the client hands that back as a plain string. A
      // string has a length and numeric indices, so <For> happily iterated it
      // one CHARACTER per provider button. Anything that is not an array means
      // we did not reach the API.
      if (!Array.isArray(list)) {
        setProvidersUnreachable(true)
        return []
      }
      setProvidersUnreachable(false)
      return list.filter(isRenderableProvider)
    } catch {
      setProvidersUnreachable(true)
      return []
    }
  })

  const returnTo = () => safeReturnTo(searchParams.returnTo as string | undefined)

  /**
   * A LATE ANSWER TAKES THE USER IN. The retry loop runs behind this card,
   * so the session can arrive while it is on screen, and nothing else would
   * move off the login route when it does.
   */
  createEffect(() => {
    if (!isAuthenticated()) return
    // ONLY WHERE WE TOOK THE USER FROM. A browser tab on /login is where its
    // user put it: a session that already exists, or one another tab just
    // started, is no reason to take the page away from them.
    if (!inWrappedShell() || !bouncedByUnreachable()) return
    consumeUnreachableBounce()
    navigate(returnTo(), { replace: true })
  })

  /** The second factor: the challenge is held for the TOTP page, then on to `target`. */
  function toTotpStep(challengeToken: string, target: string) {
    setChallengeToken(challengeToken)
    navigate(`/login/totp?returnTo=${encodeURIComponent(target)}`)
  }

  /** Route a successful auth response — either straight in, or via the TOTP step. */
  function completeAuth(result: AuthResponse) {
    if (result.totpRequired && result.challengeToken) {
      toTotpStep(result.challengeToken, returnTo())
    } else if (result.accessToken) {
      setTokens(result.accessToken, result.refreshToken)
      navigate(returnTo())
    }
  }

  function reportError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 429) {
        setError(
          i18n.t("kernel.auth.tooManyAttempts", {
            retry: formatRetryDelay(err.retryAfter, i18n.t),
          }),
        )
      } else if (err.status === 401) {
        setError(i18n.t("kernel.auth.didNotWork"))
      } else {
        setError(err.message)
      }
    } else {
      setError(i18n.t("kernel.auth.somethingWentWrong"))
    }
    authLog.warn({ status: err instanceof ApiError ? err.status : undefined }, "Login failed")
  }

  // ── Magic-link: request a code ──
  async function requestCode(e: Event) {
    e.preventDefault()
    if (loading()) return
    setError("")
    setNotice("")
    setLoading(true)
    try {
      const res = await api.post<MagicRequestResponse>(authApiPath("/magic-link/request"), {
        email: email(),
      })
      setChallengeId(res.challengeId)
      setCode("")
      setStep("code")
      setNotice(i18n.t("kernel.auth.codeSent", { email: email() }))
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_SIGN_IN_UNAVAILABLE") {
        // Instance-wide (same answer for every address): open the password
        // form with the email kept, and say why.
        setStep("password")
        setError(i18n.t("kernel.auth.emailSignInUnavailable"))
        return
      }
      reportError(err)
    } finally {
      setLoading(false)
    }
  }

  // ── Magic-link: verify the code ──
  async function verifyCode(codeValue?: string) {
    if (loading()) return
    setError("")
    setLoading(true)
    try {
      const result = await api.post<AuthResponse>(authApiPath("/magic-link/verify"), {
        challengeId: challengeId(),
        code: codeValue ?? code(),
      })
      completeAuth(result)
    } catch (err) {
      reportError(err)
    } finally {
      setLoading(false)
    }
  }

  function handleCodeInput(e: InputEvent) {
    const value = (e.currentTarget as HTMLInputElement).value.replace(/\D/g, "").slice(0, 6)
    setCode(value)
    if (value.length === 6) verifyCode(value)
  }

  // ── Retained password login (alternate) ──
  async function passwordLogin(e: Event) {
    e.preventDefault()
    if (loading()) return
    setError("")
    setLoading(true)
    try {
      const result = await api.post<AuthResponse>(authApiPath("/login"), {
        email: email(),
        password: password(),
      })
      completeAuth(result)
    } catch (err) {
      reportError(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Show
      when={!showDemoEntry()}
      fallback={<DemoEntry onSignInInstead={() => setSearchParams({ signin: "1" })} />}
    >
      {/* The Capacitor webview draws under the Dynamic Island and the home
          indicator, so the page has to inset itself. env() only resolves to a
          non-zero value because index.html asks for viewport-fit=cover; on
          desktop every inset is 0 and the layout is unchanged. */}
      <div
        data-testid="auth-page"
        class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        <div
          data-testid="auth-card"
          class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 pt-9 pb-7"
        >
          <div class="mb-7 text-center">
            <h1 class="font-display text-[24px] font-semibold tracking-[-0.02em] text-text">
              Liaison
            </h1>
            <p class="mt-1 text-[13px] text-text-secondary">
              {i18n.t("kernel.signInToYourWorkspace")}
            </p>
          </div>

          <Show when={accountDeleted}>
            <p
              data-testid="account-deleted-notice"
              role="status"
              class="mb-5 text-center text-[13px] text-text-secondary"
            >
              {i18n.t("kernel.deleteAccount.signedOutNotice")}
            </p>
          </Show>

          <Show when={passwordWasReset}>
            <p
              data-testid="password-reset-notice"
              role="status"
              class="mb-5 text-center text-[13px] text-text-secondary"
            >
              {i18n.t("kernel.passwordResetDone")}
            </p>
          </Show>

          <Show when={(serverUnreachable() || retrying()) && !awaitingDeviceApproval()}>
            <div data-testid="server-unreachable" class="mb-5 flex flex-col items-center gap-3">
              {/* The line goes while the ask is in flight, and comes back
                  with the answer: it is about an attempt, not a server. */}
              <Show when={serverUnreachable()}>
                <p role="alert" class="text-center text-xs text-error">
                  {i18n.t(unreachableMessageKey(), { host: unreachableHost() })}
                </p>
              </Show>
              <Button
                fullWidth
                type="button"
                variant="outline"
                loading={retrying()}
                onClick={() => void retryConnection()}
              >
                {i18n.t("kernel.common.retry")}
              </Button>
            </div>
          </Show>

          <Show when={awaitingDeviceApproval()}>
            <DesktopDeviceApproval onUseDifferentServer={() => setRebinding(true)} />
          </Show>
          <Show when={showConnectField()}>
            <DesktopConnect
              onCancel={
                connectRequested() && serverAddress() !== null && !rebinding()
                  ? dismissConnect
                  : undefined
              }
            />
          </Show>

          {/* The desktop's system-browser sign-in, waiting for the browser. */}
          <Show when={!desktopStep() && waitingForBrowser() ? desktopOAuthPending() : null}>
            {(pending) => (
              <div data-testid="desktop-oauth-waiting" class="flex flex-col gap-4">
                <p class="text-center text-[15px] font-semibold text-text">
                  {i18n.t("kernel.auth.desktopContinueInBrowser")}
                </p>
                <p class="text-center text-[13px] text-text-secondary">
                  {i18n.t("kernel.auth.desktopContinueInBrowserHint", {
                    provider: pending().provider,
                  })}
                </p>
                <Show when={error()}>
                  <p role="alert" class="text-center text-xs text-error">
                    {error()}
                  </p>
                </Show>
                <Button
                  fullWidth
                  type="button"
                  variant="outline"
                  onClick={() => void reopenBrowser()}
                >
                  {i18n.t("kernel.auth.desktopOpenBrowserAgain")}
                </Button>
                <button
                  type="button"
                  data-testid="desktop-oauth-cancel"
                  class="text-[12.5px] text-accent-muted hover:text-accent transition-colors duration-150"
                  onClick={() => {
                    setError("")
                    cancelDesktopOAuth()
                  }}
                >
                  {i18n.t("kernel.common.cancel")}
                </button>
              </div>
            )}
          </Show>

          {/* Step 1 — email → send code (primary, passwordless) */}
          <Show when={!desktopStep() && !waitingForBrowser() && step() === "email"}>
            <form onSubmit={requestCode} class="flex flex-col gap-4">
              <Input
                type="email"
                label={i18n.t("kernel.auth.email")}
                placeholder={i18n.t("kernel.auth.emailPlaceholder")}
                value={email()}
                onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
                autocomplete="email"
              />
              <Show when={error()}>
                <p class="text-xs text-error">{error()}</p>
              </Show>
              <Button fullWidth type="submit" loading={loading()}>
                {i18n.t("kernel.auth.continueWithEmail")}
              </Button>
            </form>

            <div class="my-5 flex items-center gap-3">
              <div class="h-px flex-1 bg-border" />
              <span class="text-[12px] text-text-tertiary">{i18n.t("kernel.or")}</span>
              <div class="h-px flex-1 bg-border" />
            </div>

            <Show when={providersUnreachable()}>
              <p data-testid="providers-unreachable" class="text-xs text-error">
                {i18n.t("kernel.cannotReachTheServer")}
              </p>
            </Show>

            <div class="flex flex-col gap-2">
              <For each={providers()}>
                {(provider) => {
                  const url = oauthAuthorizeUrl(
                    authApiUrl(`/oauth/${encodeURIComponent(provider.id)}/authorize`),
                  )
                  return (
                    <a
                      href={url}
                      // Force a real navigation. @solidjs/router intercepts same-origin
                      // <a> clicks and would client-side route this API path (which
                      // ProtectedRoute then bounces back to /login). preventDefault stops
                      // the router; window.location makes the browser actually hit the
                      // authorize endpoint so it can 302 to the provider.
                      onClick={(e) => {
                        e.preventDefault()
                        if (useSystemBrowser()) {
                          void startDesktopSignIn(provider)
                          return
                        }
                        if (nativeAuthenticate()) {
                          void startSessionSignIn(provider, url)
                          return
                        }
                        window.location.assign(url)
                      }}
                      class={providerButtonClass}
                    >
                      <Show when={provider.name === "Google"}>
                        <GoogleIcon />
                      </Show>
                      {i18n.t("kernel.auth.continueWith", { provider: provider.name })}
                    </a>
                  )
                }}
              </For>
            </div>

            <div class="mt-4 flex flex-col items-center gap-2">
              <button
                type="button"
                data-testid="password-login-toggle"
                class="text-[12.5px] text-accent-muted hover:text-accent transition-colors duration-150"
                onClick={() => {
                  setError("")
                  setNotice("")
                  setStep("password")
                }}
              >
                {i18n.t("kernel.auth.signInWithPassword")}
              </button>
              <Show when={!inNativeMobileShell()}>
                <A
                  href="/register"
                  class="text-[12.5px] text-accent-muted hover:text-accent transition-colors duration-150"
                >
                  {i18n.t("kernel.auth.createAnAccount")}
                </A>
              </Show>
            </div>
          </Show>

          {/* Step 2 — enter the 6-digit code (primary) */}
          <Show when={!desktopStep() && step() === "code"}>
            <div class="flex flex-col gap-4">
              <p class="text-[13px] text-text-secondary">{notice()}</p>
              <Input
                label={i18n.t("kernel.auth.signInCode")}
                placeholder="000000"
                value={code()}
                onInput={handleCodeInput}
                maxLength={6}
                autofocus
                autocomplete="one-time-code"
              />
              <Show when={error()}>
                <p class="text-xs text-error">{error()}</p>
              </Show>
              <Button fullWidth type="button" loading={loading()} onClick={() => verifyCode()}>
                {i18n.t("kernel.auth.verifyCode")}
              </Button>
              <button
                type="button"
                class="text-xs text-accent-muted hover:text-accent"
                onClick={() => {
                  setError("")
                  setNotice("")
                  setCode("")
                  setStep("email")
                }}
              >
                {i18n.t("kernel.auth.useDifferentEmail")}
              </button>
              <button
                type="button"
                data-testid="code-step-password-toggle"
                class="text-xs text-accent-muted hover:text-accent"
                onClick={() => {
                  setError("")
                  setNotice("")
                  setCode("")
                  setStep("password")
                }}
              >
                {i18n.t("kernel.auth.signInWithPassword")}
              </button>
            </div>
          </Show>

          {/* Alternate — retained password login */}
          <Show when={!desktopStep() && step() === "password"}>
            <form onSubmit={passwordLogin} class="flex flex-col gap-4">
              <Input
                type="email"
                label={i18n.t("kernel.auth.email")}
                placeholder={i18n.t("kernel.auth.emailPlaceholder")}
                value={email()}
                onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
                autocomplete="email"
                data-testid="login-password-email"
              />
              <Input
                type="password"
                label={i18n.t("kernel.auth.password")}
                placeholder="••••••••"
                value={password()}
                onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
                autocomplete="current-password"
                data-testid="login-password-input"
              />
              <Show when={error()}>
                <p class="text-xs text-error">{error()}</p>
              </Show>
              <Button
                fullWidth
                type="submit"
                loading={loading()}
                data-testid="password-login-submit"
              >
                {i18n.t("kernel.auth.signIn")}
              </Button>
            </form>
            <div class="mt-4 flex flex-col items-center gap-2">
              <Show when={emailCodeOffered()}>
                <button
                  type="button"
                  class="text-[12.5px] text-accent-muted hover:text-accent transition-colors duration-150"
                  onClick={() => {
                    setError("")
                    setStep("email")
                  }}
                >
                  {i18n.t("kernel.auth.signInWithEmailCode")}
                </button>
              </Show>
              <A
                href="/reset-password"
                class="text-[12.5px] text-accent-muted hover:text-accent transition-colors duration-150"
              >
                {i18n.t("kernel.auth.forgotPassword")}
              </A>
            </div>
          </Show>

          {/* The phone's and the desktop's other saved servers: the way back
              from a wrong server. Nothing in a browser. */}
          <Show when={!desktopStep() && (inNativeMobileShell() || isDesktop())}>
            <LoginServerChoice />
          </Show>
        </div>
      </div>
    </Show>
  )
}

export default Login

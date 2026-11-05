// SPDX-License-Identifier: FSL-1.1-ALv2

import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Component, createSignal, onMount, Show } from "solid-js"
import { ApiError, anonApiClient } from "~/lib/api-client"
import { authApiPath } from "~/lib/env"
import { setTokens } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

interface RegisterResponse {
  accessToken: string
  refreshToken?: string
}

const Register: Component = () => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // `invite` is the param name used by invite links emailed before the invites.ts URL fix
  const inviteToken = () => (searchParams.token ?? searchParams.invite) as string | undefined

  const [name, setName] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [setupToken, setSetupToken] = createSignal("")
  // Shown when the instance says it needs one (bootstrap-state) or answers 403:
  // a fresh production instance wants the one-time setup token from its log.
  const [needsSetupToken, setNeedsSetupToken] = createSignal(false)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [tokenValid, setTokenValid] = createSignal(true)
  const [validating, setValidating] = createSignal(false)

  const isBootstrap = () => !inviteToken()

  const api = anonApiClient

  onMount(async () => {
    const token = inviteToken()
    if (!token) {
      try {
        const state = await api.get<{ setupTokenRequired?: boolean }>(
          authApiPath("/bootstrap-state"),
        )
        if (state?.setupTokenRequired) setNeedsSetupToken(true)
      } catch {
        // The 403 on submit reveals the field anyway.
      }
    }
    if (token) {
      setValidating(true)
      try {
        await api.get(authApiPath(`/invites/${token}/validate`))
      } catch {
        setTokenValid(false)
        setError("This invitation link is invalid or has expired.")
      } finally {
        setValidating(false)
      }
    }
  })

  // Passwordless registration: bootstrap/invite-accept create the account and
  // issue a session directly (the invite token already proved email ownership).
  // Sign-in afterwards is via magic link — no password is set.
  async function handleSubmit(e: Event) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const body: Record<string, string> = { name: name() }
      if (inviteToken()) body.inviteToken = inviteToken()!
      if (isBootstrap()) body.email = email()
      if (isBootstrap() && setupToken().trim()) body.setupToken = setupToken().trim()

      const result = await api.post<RegisterResponse>(authApiPath("/register"), body)
      setTokens(result.accessToken, result.refreshToken)
      navigate("/")
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403 && isBootstrap()) setNeedsSetupToken(true)
        const msg =
          err.status === 403 && isBootstrap()
            ? i18n.t("kernel.auth.setupTokenHint")
            : err.status === 409
              ? "An account with this email already exists"
              : err.status === 400 || err.status === 422
                ? "Invalid registration details. Please check and try again"
                : err.status === 429
                  ? "Too many attempts. Please try again later"
                  : "Registration failed. Please try again"
        setError(msg)
      } else {
        setError("Something went wrong")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]">
      <div
        data-testid="auth-card"
        class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 pt-9 pb-7"
      >
        <div class="mb-7 text-center">
          <h1 class="font-display text-[24px] font-semibold tracking-[-0.02em] text-text">
            Liaison
          </h1>
          <p class="mt-1 text-[13px] text-text-secondary">{i18n.t("kernel.createYourAccount")}</p>
        </div>

        <Show when={!tokenValid()}>
          <div class="mb-4 rounded-md border border-error-border bg-error-glow p-3">
            <p class="text-xs text-error">{i18n.t("kernel.thisInvitationLinkIsInvalidOr")}</p>
          </div>
        </Show>

        <Show when={tokenValid()}>
          <form onSubmit={handleSubmit} class="flex flex-col gap-4">
            <Input
              label={i18n.t("kernel.auth.fullName")}
              placeholder={i18n.t("kernel.yourName")}
              value={name()}
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              autocomplete="name"
            />
            <Show when={isBootstrap()}>
              <Input
                type="email"
                label={i18n.t("kernel.auth.email")}
                placeholder="you@company.com"
                value={email()}
                onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
                autocomplete="email"
              />
            </Show>

            <Show when={isBootstrap() && needsSetupToken()}>
              <Input
                label={i18n.t("kernel.auth.setupToken")}
                value={setupToken()}
                onInput={(e) => setSetupToken((e.currentTarget as HTMLInputElement).value)}
                autocomplete="off"
                data-testid="setup-token-input"
              />
            </Show>

            <Show when={error()}>
              <p class="text-xs text-error">{error()}</p>
            </Show>

            <Button fullWidth type="submit" loading={loading()} disabled={validating()}>
              {i18n.t("kernel.auth.createAccount")}
            </Button>
            <p class="text-center text-[12px] text-text-tertiary">
              {i18n.t("kernel.auth.registerHint")}
            </p>
          </form>
        </Show>
      </div>
    </div>
  )
}

export default Register

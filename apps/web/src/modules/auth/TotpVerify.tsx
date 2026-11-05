// SPDX-License-Identifier: FSL-1.1-ALv2

import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Component, createSignal, onMount, Show } from "solid-js"
import { ApiError, anonApiClient } from "~/lib/api-client"
import { authApiPath } from "~/lib/env"
import { formatRetryDelay } from "~/lib/format-retry"
import { log } from "~/lib/logger"
import { safeReturnTo } from "~/lib/safe-return-to"
import { challengeToken, consumeChallengeToken, setTokens } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

const authLog = log.child({ component: "TotpVerify" })

interface TotpResponse {
  accessToken: string
  refreshToken?: string
}

const TotpVerify: Component = () => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [code, setCode] = createSignal("")
  const [recoveryCode, setRecoveryCode] = createSignal("")
  const [useRecovery, setUseRecovery] = createSignal(false)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  const api = anonApiClient

  const returnTo = () => safeReturnTo(searchParams.returnTo as string | undefined)

  onMount(() => {
    if (!challengeToken()) {
      navigate(`/login?returnTo=${encodeURIComponent(returnTo())}`, { replace: true })
    }
  })

  async function handleSubmit(codeValue?: string) {
    if (loading()) return
    const ct = challengeToken()
    if (!ct) return
    setError("")
    setLoading(true)

    const body: Record<string, string> = { challengeToken: ct }
    if (useRecovery()) {
      body.recoveryCode = recoveryCode()
    } else {
      body.code = codeValue ?? code()
    }

    try {
      const result = await api.post<TotpResponse>(authApiPath("/totp/verify"), body)
      consumeChallengeToken()
      setTokens(result.accessToken, result.refreshToken)
      navigate(returnTo())
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError(`Too many attempts. ${formatRetryDelay(err.retryAfter)}`)
        } else {
          setError("Invalid code, try again")
        }
      } else {
        setError("Something went wrong")
      }
      authLog.warn("TOTP verification failed")
    } finally {
      setLoading(false)
    }
  }

  function handleCodeInput(e: InputEvent) {
    const value = (e.currentTarget as HTMLInputElement).value.replace(/\D/g, "").slice(0, 6)
    setCode(value)
    if (value.length === 6) {
      handleSubmit(value)
    }
  }

  return (
    <div class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]">
      <div class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 pt-9 pb-7">
        <div class="mb-7 text-center">
          <h1 class="text-lg font-semibold text-text">
            {i18n.t("kernel.twoFactorAuthentication")}
          </h1>
          <p class="mt-1 text-sm text-text-secondary">
            {useRecovery()
              ? i18n.t("kernel.auth.enterRecoveryCode")
              : i18n.t("kernel.auth.enterAuthenticatorCode")}
          </p>
        </div>

        <Show
          when={!useRecovery()}
          fallback={
            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleSubmit()
              }}
              class="flex flex-col gap-4"
            >
              <Input
                placeholder={i18n.t("kernel.recoveryCode")}
                value={recoveryCode()}
                onInput={(e) => setRecoveryCode((e.currentTarget as HTMLInputElement).value)}
              />
              <Show when={error()}>
                <p class="text-xs text-error">{error()}</p>
              </Show>
              <Button fullWidth type="submit" loading={loading()}>
                {i18n.t("kernel.auth.verify")}
              </Button>
              <button
                type="button"
                class="text-xs text-accent-muted hover:text-accent"
                onClick={() => {
                  setUseRecovery(false)
                  setError("")
                }}
              >
                {i18n.t("kernel.auth.useAuthenticatorCode")}
              </button>
            </form>
          }
        >
          <div class="flex flex-col gap-4">
            <Input
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
            <button
              type="button"
              class="text-xs text-accent-muted hover:text-accent"
              onClick={() => {
                setUseRecovery(true)
                setError("")
              }}
            >
              {i18n.t("kernel.auth.useRecoveryCode")}
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default TotpVerify

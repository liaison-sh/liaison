// SPDX-License-Identifier: FSL-1.1-ALv2

import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Component, createSignal, Show } from "solid-js"
import { ApiError, anonApiClient } from "~/lib/api-client"
import { authApiPath } from "~/lib/env"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

const ResetPasswordConfirm: Component = () => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = () => searchParams.token as string | undefined

  const [password, setPassword] = createSignal("")
  const [confirmPassword, setConfirmPassword] = createSignal("")
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  const api = anonApiClient

  async function handleSubmit(e: Event) {
    e.preventDefault()
    setError("")

    if (password().length < 8) {
      setError("Password must be at least 8 characters")
      return
    }
    if (password() !== confirmPassword()) {
      setError("Passwords do not match")
      return
    }

    setLoading(true)
    try {
      await api.post(authApiPath("/password-reset/confirm"), {
        token: token(),
        newPassword: password(),
      })
      navigate("/login?reset=success")
    } catch (err) {
      if (err instanceof ApiError) {
        const knownErrors: Record<number, string> = {
          400: "This reset link is invalid or has expired",
          410: "This reset link has already been used",
          429: "Too many attempts. Please try again later",
        }
        setError(knownErrors[err.status] ?? "Something went wrong")
      } else {
        setError("Something went wrong")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]">
      <div class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 pt-9 pb-7">
        <div class="mb-7 text-center">
          <h1 class="text-2xl font-semibold tracking-[-0.02em] text-text">
            {i18n.t("kernel.setNewPassword")}
          </h1>
        </div>

        <Show
          when={token()}
          fallback={
            <p class="text-center text-sm text-error">{i18n.t("kernel.invalidResetLink")}</p>
          }
        >
          <form onSubmit={handleSubmit} class="flex flex-col gap-4">
            <Input
              type="password"
              label={i18n.t("kernel.auth.newPassword")}
              placeholder="••••••••"
              value={password()}
              onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
              autocomplete="new-password"
            />
            <Input
              type="password"
              label={i18n.t("kernel.auth.confirmPassword")}
              placeholder="••••••••"
              value={confirmPassword()}
              onInput={(e) => setConfirmPassword((e.currentTarget as HTMLInputElement).value)}
              autocomplete="new-password"
            />
            <Show when={error()}>
              <p class="text-xs text-error">{error()}</p>
            </Show>
            <Button fullWidth type="submit" loading={loading()}>
              {i18n.t("kernel.auth.resetPassword")}
            </Button>
          </form>
        </Show>
      </div>
    </div>
  )
}

export default ResetPasswordConfirm

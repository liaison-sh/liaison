// SPDX-License-Identifier: FSL-1.1-ALv2

import { A } from "@solidjs/router"
import { type Component, createSignal, Show } from "solid-js"
import { anonApiClient } from "~/lib/api-client"
import { authApiPath } from "~/lib/env"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

const ResetPassword: Component = () => {
  const i18n = useI18n()
  const [email, setEmail] = createSignal("")
  const [submitted, setSubmitted] = createSignal(false)
  const [loading, setLoading] = createSignal(false)

  const api = anonApiClient

  async function handleSubmit(e: Event) {
    e.preventDefault()
    setLoading(true)

    try {
      await api.post(authApiPath("/password-reset/request"), { email: email() })
    } catch {
      // Intentionally ignore — always show generic message to prevent email enumeration
    }
    setSubmitted(true)
    setLoading(false)
  }

  return (
    <div class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]">
      <div class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 pt-9 pb-7">
        <div class="mb-7 text-center">
          <h1 class="text-2xl font-semibold tracking-[-0.02em] text-text">
            {i18n.t("kernel.resetPassword")}
          </h1>
        </div>

        <Show
          when={!submitted()}
          fallback={
            <div class="text-center">
              <p class="text-sm text-text-secondary">{i18n.t("kernel.auth.resetSent")}</p>
              <A
                href="/login"
                class="mt-4 inline-block text-xs text-accent-muted hover:text-accent transition-colors duration-150"
              >
                {i18n.t("kernel.auth.backToLogin")}
              </A>
            </div>
          }
        >
          <form onSubmit={handleSubmit} class="flex flex-col gap-4">
            <Input
              type="email"
              label={i18n.t("kernel.auth.email")}
              placeholder="you@company.com"
              value={email()}
              onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
              autocomplete="email"
            />
            <Button fullWidth type="submit" loading={loading()}>
              {i18n.t("kernel.auth.sendResetLink")}
            </Button>
          </form>
        </Show>
      </div>
    </div>
  )
}

export default ResetPassword

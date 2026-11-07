// SPDX-License-Identifier: FSL-1.1-ALv2

import { useNavigate } from "@solidjs/router"
import { type Component, createSignal, Match, onMount, Switch } from "solid-js"
import { anonApiClient } from "~/lib/api-client"
import { authApiPath } from "~/lib/env"
import { setChallengeToken, setTokens } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

interface AuthResponse {
  accessToken?: string
  refreshToken?: string
  totpRequired?: boolean
  challengeToken?: string
  /** A handoff link: the server names the workspace and account, and waits for "Continue". */
  confirmRequired?: boolean
  workspace?: { name: string; slug: string }
  account?: { email: string; name: string }
}

interface Confirmation {
  workspace: { name: string; slug: string }
  account: { email: string; name: string }
}

/**
 * Landing page for a sign-in link (`/login/magic?challengeId=…&token=…`). An
 * emailed link signs in at once. A link handed over by the operator (a new
 * workspace's first sign-in) first shows the workspace and the account, and
 * signs in only when the person clicks "Continue".
 */
const MagicLinkVerify: Component = () => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [failed, setFailed] = createSignal(false)
  const [confirmation, setConfirmation] = createSignal<Confirmation | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  let link: { challengeId: string; token: string } | null = null

  const finish = (result: AuthResponse) => {
    if (result.totpRequired && result.challengeToken) {
      setChallengeToken(result.challengeToken)
      navigate("/login/totp", { replace: true })
    } else if (result.accessToken) {
      setTokens(result.accessToken, result.refreshToken)
      navigate("/", { replace: true })
    } else {
      setFailed(true)
    }
  }

  onMount(async () => {
    const params = new URLSearchParams(window.location.search)
    const challengeId = params.get("challengeId")
    const token = params.get("token")
    // Strip the token from the URL immediately so it can't leak via history/referrer.
    window.history.replaceState(null, "", window.location.pathname)

    if (!challengeId || !token) {
      setFailed(true)
      return
    }
    link = { challengeId, token }

    try {
      const result = await anonApiClient.post<AuthResponse>(authApiPath("/magic-link/verify"), link)
      if (result.confirmRequired && result.workspace && result.account) {
        setConfirmation({ workspace: result.workspace, account: result.account })
        return
      }
      finish(result)
    } catch {
      setFailed(true)
    }
  })

  const onContinue = async () => {
    if (!link || submitting()) return
    setSubmitting(true)
    try {
      finish(
        await anonApiClient.post<AuthResponse>(authApiPath("/magic-link/verify"), {
          ...link,
          confirm: true,
        }),
      )
    } catch {
      setFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]">
      <Switch
        fallback={<p class="text-sm text-text-secondary">{i18n.t("kernel.completingSignIn")}</p>}
      >
        <Match when={failed()}>
          <div
            data-testid="magic-link-invalid"
            class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 py-8 text-center"
          >
            <p class="text-sm text-text-secondary">{i18n.t("kernel.auth.magicLinkInvalid")}</p>
            <a
              href="/login"
              class="mt-3 inline-block text-[12.5px] text-accent-muted hover:text-accent"
            >
              {i18n.t("kernel.auth.backToSignIn")}
            </a>
          </div>
        </Match>
        <Match when={confirmation()}>
          {(c) => (
            <div
              data-testid="magic-link-confirm"
              class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 py-8"
            >
              <h1 class="text-base font-medium text-text">
                {i18n.t("kernel.auth.magicLinkConfirmTitle", { workspace: c().workspace.name })}
              </h1>
              <p class="mt-2 text-sm text-text-secondary">
                {i18n.t("kernel.auth.magicLinkConfirmAccount", { email: c().account.email })}
              </p>
              <p class="mt-1 text-[12.5px] text-text-tertiary">
                {i18n.t("kernel.auth.magicLinkConfirmHint")}
              </p>
              <Button
                data-testid="magic-link-continue"
                class="mt-5"
                fullWidth
                loading={submitting()}
                onClick={onContinue}
              >
                {i18n.t("kernel.auth.magicLinkContinue")}
              </Button>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}

export default MagicLinkVerify

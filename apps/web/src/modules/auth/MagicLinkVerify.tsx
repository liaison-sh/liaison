// SPDX-License-Identifier: FSL-1.1-ALv2

import { useNavigate } from "@solidjs/router"
import { type Component, createSignal, onMount, Show } from "solid-js"
import { anonApiClient } from "~/lib/api-client"
import { authApiPath } from "~/lib/env"
import { setChallengeToken, setTokens } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"

interface AuthResponse {
  accessToken?: string
  refreshToken?: string
  totpRequired?: boolean
  challengeToken?: string
}

/** Landing page for the emailed magic link (`/login/magic?challengeId=…&token=…`). */
const MagicLinkVerify: Component = () => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [failed, setFailed] = createSignal(false)

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

    try {
      const result = await anonApiClient.post<AuthResponse>(authApiPath("/magic-link/verify"), {
        challengeId,
        token,
      })
      if (result.totpRequired && result.challengeToken) {
        setChallengeToken(result.challengeToken)
        navigate("/login/totp", { replace: true })
      } else if (result.accessToken) {
        setTokens(result.accessToken, result.refreshToken)
        navigate("/", { replace: true })
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    }
  })

  return (
    <div class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]">
      <Show
        when={!failed()}
        fallback={
          <div class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 py-8 text-center">
            <p class="text-sm text-text-secondary">{i18n.t("kernel.auth.magicLinkInvalid")}</p>
            <a
              href="/login"
              class="mt-3 inline-block text-[12.5px] text-accent-muted hover:text-accent"
            >
              {i18n.t("kernel.auth.backToSignIn")}
            </a>
          </div>
        }
      >
        <p class="text-sm text-text-secondary">{i18n.t("kernel.completingSignIn")}</p>
      </Show>
    </div>
  )
}

export default MagicLinkVerify

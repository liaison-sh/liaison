// SPDX-License-Identifier: FSL-1.1-ALv2

import { useNavigate } from "@solidjs/router"
import { type Component, onMount } from "solid-js"
import { safeReturnTo } from "~/lib/safe-return-to"
import { setChallengeToken, setTokens } from "~/modules/auth/auth-store"
import { exchangeOAuthCode } from "~/modules/auth/oauth-exchange"
import { useI18n } from "~/modules/i18n/i18n-context"

const OAuthComplete: Component = () => {
  const i18n = useI18n()
  const navigate = useNavigate()

  onMount(async () => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const returnedState = params.get("state")
    window.history.replaceState(null, "", window.location.pathname)

    const savedState = sessionStorage.getItem("oauth_state")
    sessionStorage.removeItem("oauth_state")
    // Read and clear the pre-OAuth deep link so it survives the provider redirect.
    const storedReturnTo = sessionStorage.getItem("oauth_return_to")
    sessionStorage.removeItem("oauth_return_to")
    const returnTo = safeReturnTo(storedReturnTo ?? undefined)

    if (!code || !returnedState || returnedState !== savedState) {
      navigate("/login?error=OAuth+authentication+failed", { replace: true })
      return
    }

    try {
      const outcome = await exchangeOAuthCode({ code, state: returnedState })
      if (outcome?.kind === "totp") {
        // Two-factor sign-in is on: the provider was the first factor only.
        setChallengeToken(outcome.challengeToken)
        navigate(`/login/totp?returnTo=${encodeURIComponent(returnTo)}`, { replace: true })
      } else if (outcome?.kind === "token") {
        setTokens(outcome.accessToken)
        navigate(returnTo, { replace: true })
      } else {
        navigate("/login?error=OAuth+authentication+failed", { replace: true })
      }
    } catch {
      navigate("/login?error=OAuth+authentication+failed", { replace: true })
    }
  })

  return (
    <div class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]">
      <p class="text-sm text-text-secondary">{i18n.t("kernel.completingSignIn")}</p>
    </div>
  )
}

export default OAuthComplete

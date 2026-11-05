// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE-TIME CODE EXCHANGE, shared by the two ways an OAuth sign-in ends:
// the browser's `/login/oauth-complete` page and the desktop app's
// `liaison://oauth-complete` link. One call, one body shape, so the two cannot
// drift. The desktop adds its PKCE verifier; the browser sends exactly what it
// always sent.
//
// In the desktop shell the refresh token that comes back in the body is kept
// by the shell's refresh bridge (apps/desktop/src/overlay.tsx), which watches
// every `/api/auth/` answer on the bound origin: nothing here has to store it.

import { anonApiClient } from "~/lib/api-client"

export interface OAuthExchangeBody {
  code: string
  state: string
  /** The desktop app's PKCE verifier. Absent in a browser. */
  code_verifier?: string
}

/**
 * What a code stands for: a session (its access token), or, for an account with
 * two-factor sign-in on, the TOTP challenge to answer at /login/totp before any
 * session exists.
 */
export type OAuthExchangeOutcome =
  | { kind: "token"; accessToken: string }
  | { kind: "totp"; challengeToken: string }

/** What the code stands for, or null. Throws what the client throws. */
export async function exchangeOAuthCode(
  body: OAuthExchangeBody,
): Promise<OAuthExchangeOutcome | null> {
  const result = await anonApiClient.post<{
    accessToken?: string
    totpRequired?: boolean
    challengeToken?: string
  }>("/auth/oauth/exchange", body)
  if (result?.totpRequired && result.challengeToken) {
    return { kind: "totp", challengeToken: result.challengeToken }
  }
  return result?.accessToken ? { kind: "token", accessToken: result.accessToken } : null
}

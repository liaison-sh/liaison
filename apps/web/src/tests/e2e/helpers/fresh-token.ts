// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "@liaison/test-helpers"

/**
 * Re-login a user against `/api/auth/login` and return a fresh access token.
 *
 * Permission_version drift in long-lived `qa.*.token` values (issued at fixture
 * setup) is the most common cause of 401 cascades inside a worker: any earlier
 * test that bumps the user's permission_version invalidates the cached token.
 * Fetching a fresh token immediately before a server-side API call sidesteps
 * the drift entirely.
 */
export async function freshAccessToken(
  serverUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await api(serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email, password },
  })
  if (res.status !== 200) {
    throw new Error(
      `freshAccessToken: login failed for ${email} (status ${res.status}): ${JSON.stringify(res.body)}`,
    )
  }
  const token = res.body?.data?.accessToken ?? res.body?.accessToken
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `freshAccessToken: login response missing accessToken for ${email}: ${JSON.stringify(res.body)}`,
    )
  }
  return token
}

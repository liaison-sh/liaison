// SPDX-License-Identifier: FSL-1.1-ALv2
import { type ApiClient, type ApiClientConfig, createApiClient } from "~/lib/api-client"
import { accessToken } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"

type SessionManager = Pick<typeof authManager, "ensureFreshToken" | "pendingRefresh">

/**
 * An API client for the signed-in session: the session's access token, and
 * the auth manager's ONE refresh. A client built without these sends an
 * expired token, meets a 401 and fails, or rotates beside the page's own
 * refresh; every signed-in client the page builds at module scope comes from
 * here so none of them does.
 */
export function createSessionApiClient(
  config: Omit<ApiClientConfig, "getAccessToken" | "ensureFreshToken" | "pendingRefresh">,
  manager: SessionManager = authManager,
): ApiClient {
  return createApiClient({
    ...config,
    getAccessToken: accessToken,
    ensureFreshToken: manager.ensureFreshToken,
    pendingRefresh: manager.pendingRefresh,
  })
}

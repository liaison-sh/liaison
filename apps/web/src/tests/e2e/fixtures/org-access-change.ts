// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A token minted before an org-wide access change is refused (401) once the
// change lands: adding or deleting an organization MCP server, or changing who
// may use one, bumps every member's `permission_version` after the commit
// (afterOrgAccessChange, apps/api/src/modules/apps/org-app-service.ts), and the
// server's `mcp:<slug>` namespace is granted only from the next token. The web
// client refreshes on that 401 by itself; a spec holding a raw API token has to
// do the same. This waits until the pre-change token is refused (the bump runs
// asynchronously, after the commit), then signs in again for a fresh one.

import { api, type WorkerEnv } from "@liaison/test-helpers"
import { expect } from "@playwright/test"

export async function tokenAfterOrgAccessChange(
  env: WorkerEnv,
  staleToken: string,
  credentials: { email: string; password: string },
): Promise<string> {
  await expect
    .poll(
      async () =>
        (
          await api(env.serverUrl, "/api/apps/mcp-manager/connections", {
            method: "GET",
            token: staleToken,
          })
        ).status,
      { timeout: 15_000, message: "the pre-change token was never refused" },
    )
    .toBe(401)
  const res = await api(env.serverUrl, "/api/auth/login", {
    method: "POST",
    body: credentials,
  })
  expect(res.status).toBe(200)
  const token = (res.body as { data?: { accessToken?: string } }).data?.accessToken
  if (!token) throw new Error(`login returned no access token: ${JSON.stringify(res.body)}`)
  return token
}

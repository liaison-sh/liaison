// SPDX-License-Identifier: FSL-1.1-ALv2

import { googleOAuthClientIdSchema } from "@liaison/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import {
  accountsMintedByAnotherClient,
  GOOGLE_WORKSPACE_CLIENT_CONNECTIONS,
} from "~/modules/apps/connections/oauth-client"
import { hasScope } from "~/modules/permissions/permissions"
import {
  clearGoogleIntegrationConfig,
  getGoogleIntegrationSummary,
  saveGoogleIntegrationConfig,
} from "~/modules/settings/google-integration"

const log = rootLogger.child({ module: "settings-integrations" })

/**
 * The org's Google client changed: open Settings > Mail pages re-read whether
 * Gmail can connect (the `mail:provider` frame they already refetch on),
 * instead of saying "credentials are not set up yet" until the next connect.
 */
function announceGoogleClientChanged(orgId: string, configured: boolean): void {
  void broadcastEphemeral({
    app: "mail",
    entity: "provider",
    action: "update",
    orgId,
    data: { id: "gmail", integrationConfigured: configured },
  }).catch((err) =>
    log.warn({ err, orgId }, "google client broadcast failed; pages converge on reload"),
  )
}

export const integrationsRoutes = new Hono<AppEnv>()
  .get("/google", async (c) => {
    const orgId = c.get("orgId")
    const scopes = c.get("scopes") as string[]
    if (!hasScope("kernel:org:admin", scopes)) {
      throw new HTTPException(403, { message: "Forbidden" })
    }

    const summary = await getGoogleIntegrationSummary(orgId)
    return success(c, summary)
  })
  .patch(
    "/google",
    zValidator(
      "json",
      z.object({
        clientId: googleOAuthClientIdSchema,
        clientSecret: z.string().trim().min(1),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const scopes = c.get("scopes") as string[]
      if (!hasScope("kernel:org:admin", scopes)) {
        throw new HTTPException(403, { message: "Forbidden" })
      }

      const { clientId, clientSecret } = c.req.valid("json")
      await saveGoogleIntegrationConfig(orgId, { clientId, clientSecret })
      announceGoogleClientChanged(orgId, true)

      const summary = await getGoogleIntegrationSummary(orgId)
      // Gmail and Calendar accounts connected with another client keep working on
      // it; a reconnect moves each one to this client.
      const reconnectToMove = await accountsMintedByAnotherClient(
        orgId,
        [...GOOGLE_WORKSPACE_CLIENT_CONNECTIONS],
        clientId,
      )
      return success(c, { ...summary, reconnectToMove })
    },
  )
  .delete("/google", async (c) => {
    const orgId = c.get("orgId")
    const scopes = c.get("scopes") as string[]
    if (!hasScope("kernel:org:admin", scopes)) {
      throw new HTTPException(403, { message: "Forbidden" })
    }

    await clearGoogleIntegrationConfig(orgId)
    announceGoogleClientChanged(orgId, false)

    const summary = await getGoogleIntegrationSummary(orgId)
    return success(c, summary)
  })

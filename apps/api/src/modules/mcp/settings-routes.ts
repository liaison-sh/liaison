// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { success } from "~/lib/response"
import { listConnectionsForUser, revokeConnection } from "~/modules/mcp/connection-service"

// Owner-scoped Settings → MCP REST. All routes are mounted behind
// authMiddleware + orgLimiter in app.ts.
export const mcpSettings = new Hono<AppEnv>()

function toDto(row: { id: string; label: string; createdAt: Date; lastUsedAt: Date | null }) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

mcpSettings.get("/connections", async (c) => {
  const rows = await listConnectionsForUser(c.get("orgId"), c.get("userId"))
  return success(c, rows.map(toDto))
})

mcpSettings.delete("/connections/:id", async (c) => {
  // revokeConnection enforces owner-only (throws plain Error if not owned /
  // not found / already revoked). Map to 404 so a non-owner cannot revoke or
  // probe another user's connection.
  try {
    await revokeConnection(c.req.param("id"), c.get("userId"))
  } catch {
    throw new HTTPException(404, { message: "MCP connection not found" })
  }
  return success(c, { revoked: true })
})

// The single deterministic instance-URL source the frontend connect snippets
// read — first-class deliverable, not a response-meta alternative.
mcpSettings.get("/connect-info", async (c) => {
  return success(c, { baseUrl: env.BASE_URL })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent user-memory REST routes. Per-user RLS enforces isolation; scope
 * split (`kernel:agent:memory:read` vs `:write`) lets admins grant view-only
 * access without enabling mutation. Mounted in `apps/api/src/app.ts` under
 * `/api/agent/memories`.
 */
import {
  MemoryCreateSchema,
  MemoryNameSchema,
  MemoryTypeSchema,
  MemoryUpdateSchema,
} from "@liaison/shared"
import { and, desc, eq, ne } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import type { RlsClient } from "~/db"
import { agentMemory } from "~/db/schema/kernel"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import {
  handleMemoryDelete,
  handleMemoryPatch,
  handleMemorySet,
} from "~/modules/agent/memory/memory"
import { filterByVisibility } from "~/services/security/visibility"

const paramSchema = z.object({ type: MemoryTypeSchema, name: MemoryNameSchema })

/**
 * Build the `MemoryContext` shape the service-layer handlers expect from a
 * Hono request + an RLS-scoped tx. Used by every mutating route to keep the
 * actor/tx wiring out of the handler bodies.
 */
function memoryCtx(
  c: Context<AppEnv>,
  tx: RlsClient,
): { userId: string; orgId: string; db: RlsClient; scopes: string[] } {
  const actor = extractRlsContext(c)
  // The caller's scopes are NOT optional here. The service layer filters every
  // scoped row against them, and an absent set is the fail-closed answer: with
  // no scopes, a row an earlier agent turn tagged reads as absent, so DELETE
  // reported success without deleting anything and PATCH could not find it.
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    db: tx,
    scopes: (c.get("scopes") ?? []) as unknown as string[],
  }
}

export const memoriesRoutes = new Hono<AppEnv>()

memoriesRoutes.get("/", requireScope("kernel:agent:memory:read"), async (c) => {
  const actor = extractRlsContext(c)
  const rows = await withRequestRls(c, (tx) =>
    tx
      .select({
        type: agentMemory.type,
        name: agentMemory.name,
        description: agentMemory.description,
        content: agentMemory.content,
        updatedAt: agentMemory.updatedAt,
        requiredScopes: agentMemory.requiredScopes,
      })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, actor.orgId),
          eq(agentMemory.userId, actor.userId),
          ne(agentMemory.type, "_index"),
        ),
      )
      .orderBy(desc(agentMemory.updatedAt)),
  )
  // The same single filter every scoped read goes through: a row this caller's
  // scopes do not cover reads as absent, never as "access denied".
  const visible = filterByVisibility(rows, {
    userId: actor.userId,
    grants: (c.get("scopes") ?? []) as unknown as string[],
  })
  return c.json({
    data: visible.map((r) => ({
      type: r.type,
      name: r.name,
      description: r.description,
      content: r.content,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    })),
  })
})

memoriesRoutes.post(
  "/",
  requireScope("kernel:agent:memory:write"),
  zValidator("json", MemoryCreateSchema),
  async (c) => {
    const body = c.req.valid("json")
    try {
      // A human writing their own memory through the UI reads nothing scoped
      // into it: the empty array is the positive assertion, and the union in
      // the write keeps any tag an earlier agent turn put on the row.
      await withRequestRls(c, (tx) => handleMemorySet(body, memoryCtx(c, tx), []))
    } catch (err) {
      if (err instanceof Error && /reserved/i.test(err.message)) {
        throw new HTTPException(400, { message: err.message })
      }
      throw err
    }
    return c.json({ data: { ...body, updatedAt: new Date().toISOString() } }, 201)
  },
)

memoriesRoutes.patch(
  "/:type/:name",
  requireScope("kernel:agent:memory:write"),
  zValidator("param", paramSchema),
  zValidator("json", MemoryUpdateSchema),
  async (c) => {
    const { type, name } = c.req.valid("param")
    const patch = c.req.valid("json")
    const merged = await withRequestRls(c, (tx) =>
      handleMemoryPatch({ type, name, ...patch }, memoryCtx(c, tx), []),
    )
    if (!merged) {
      throw new HTTPException(404, { message: "Memory not found" })
    }
    return c.json({
      data: {
        type: merged.type,
        name: merged.name,
        description: merged.description,
        content: merged.content,
        updatedAt:
          merged.updatedAt instanceof Date
            ? merged.updatedAt.toISOString()
            : String(merged.updatedAt),
      },
    })
  },
)

memoriesRoutes.delete(
  "/:type/:name",
  requireScope("kernel:agent:memory:write"),
  zValidator("param", paramSchema),
  async (c) => {
    const { type, name } = c.req.valid("param")
    await withRequestRls(c, (tx) => handleMemoryDelete({ type, name }, memoryCtx(c, tx)))
    return c.body(null, 204)
  },
)

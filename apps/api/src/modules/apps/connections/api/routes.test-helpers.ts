// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only: the API connection settings and customer reads as HTTP routes over
// the platform's `api_*` bridge methods (bridge.ts), in the shape the kernel
// routes had before the connector became a catalog app. The app's own screens
// call the same methods through its tools; these tests drive them with a
// caller's org, user and scopes the way a tool call carries them.

import { Hono } from "hono"
import type { AppEnv } from "~/app"
import type { UserContext } from "~/db/rls"
import {
  TEST_API_APP as API_CONNECTOR_APP,
  TEST_API_CONNECTION as API_CONNECTOR_CONNECTION,
} from "./app.test-helpers"
import { createApiConnectionMethods } from "./bridge"

export const API_DECLARATION = {
  readScope: "api-connector:read",
  writeScope: "api-connector:write",
  adminScope: "api-connector:admin",
}

/** The bridge methods as a call of `scopes` by `userId` in `orgId` would see them. */
export function apiMethodsFor(input: {
  orgId: string
  userId: string
  scopes: string[]
  actorType?: "user" | "agent" | "system" | "mcp"
  signal?: AbortSignal
}): Record<string, (json?: unknown) => Promise<string>> {
  const actor: UserContext = {
    actorType: "user",
    userId: input.userId,
    orgId: input.orgId,
    scopes: input.scopes,
    dimensionGrants: {},
  }
  return createApiConnectionMethods({
    appName: API_CONNECTOR_APP,
    orgId: input.orgId,
    userId: input.userId,
    actorType: input.actorType ?? "user",
    manifest: {
      name: API_CONNECTOR_APP,
      connections: { [API_CONNECTOR_CONNECTION]: { type: "credentials", api: API_DECLARATION } },
    },
    callerScopes: input.scopes,
    bridgeOptions: input.signal ? { signal: input.signal } : undefined,
    inheritedActor: actor,
  } as Parameters<typeof createApiConnectionMethods>[0])
}

/** Call one method; a `{ error }` answer becomes its status, anything else 200 `{ data }`. */
async function answer(method: (json?: unknown) => Promise<string>, args: unknown) {
  const out = JSON.parse(await method(JSON.stringify(args))) as Record<string, unknown>
  const err = out.error as { status?: number } | undefined
  if (err) return { status: err.status ?? 400, body: { error: err } }
  return { status: 200, body: { data: out } }
}

export const apiConnectorRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.set(
      "apiMethods" as never,
      apiMethodsFor({
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        scopes: (c.get("scopes") ?? []).map(String),
      }) as never,
    )
    await next()
  })
  .get("/adapters", async (c) => {
    const m = c.get("apiMethods" as never) as Record<string, (j?: unknown) => Promise<string>>
    const r = await answer(m.api_connections!, {})
    return c.json(r.body, r.status as 200)
  })
  .put("/adapters/:identifier", async (c) => {
    const m = c.get("apiMethods" as never) as Record<string, (j?: unknown) => Promise<string>>
    const r = await answer(m.api_adapterPut!, {
      identifier: c.req.param("identifier"),
      document: await c.req.text(),
      confirmCredentialWipe: c.req.query("confirmCredentialWipe") === "true",
    })
    return c.json(r.body, r.status as 200)
  })
  .delete("/adapters/:identifier", async (c) => {
    const m = c.get("apiMethods" as never) as Record<string, (j?: unknown) => Promise<string>>
    const r = await answer(m.api_adapterDelete!, { identifier: c.req.param("identifier") })
    return c.json(r.body, r.status as 200)
  })
  .post("/adapters/:identifier/test", async (c) => {
    const m = c.get("apiMethods" as never) as Record<string, (j?: unknown) => Promise<string>>
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const r = await answer(m.api_adapterTest!, {
      identifier: c.req.param("identifier"),
      operation: body.operation,
      params: body.params ?? {},
      raw: true,
    })
    return c.json(r.body, r.status as 200)
  })
  .get("/adapters/:identifier/versions", async (c) => {
    const m = c.get("apiMethods" as never) as Record<string, (j?: unknown) => Promise<string>>
    const r = await answer(m.api_adapterVersions!, { identifier: c.req.param("identifier") })
    return c.json(r.body, r.status as 200)
  })
  .post("/adapters/:identifier/restore", async (c) => {
    const m = c.get("apiMethods" as never) as Record<string, (j?: unknown) => Promise<string>>
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const r = await answer(m.api_adapterRestore!, {
      identifier: c.req.param("identifier"),
      ...body,
    })
    return c.json(r.body, r.status as 200)
  })
  .get("/customer", async (c) => {
    const m = c.get("apiMethods" as never) as Record<string, (j?: unknown) => Promise<string>>
    const r = await answer(m.api_customer!, {
      email: c.req.query("email"),
      phone: c.req.query("phone"),
      domain: c.req.query("domain"),
    })
    return c.json(r.body, r.status as 200)
  })

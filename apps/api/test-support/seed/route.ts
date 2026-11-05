// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/_test/seed { factory, orgId?, args }: runs one seed engine factory
// (apps/api/src/seed/) in the server process, for a browser test that needs
// rows mid-test. The Playwright worker is another process, so a row the
// running server's services, caches and RLS must recognise is made here,
// through the same factories every tier is built from, never by raw SQL from
// the test.
//
// Test builds only: mounted by `mountQaSeedRoutes` when `qaSeedRoutesEnabled`
// (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES, which the env validator refuses in
// production), and this folder is not in the production image. The handler
// re-checks the flag.
//
// `now` is the request's wall clock (a test's rows sit next to the ones it
// makes through the UI) and each call's id key is random unless the test
// passes one, so two calls never collide. That is why this lives here and not
// under seed/, whose factories take both from their context.
//
// Answers: 200 `{ data }` (the factory's typed result), 400 unknown factory or
// invalid args, 422 a factory that refused (its message names the factory).
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { zValidator } from "~/lib/validate"
import { seedContext } from "~/seed/context"
import { SEED_FACTORIES } from "./factories"

export const seedTestRoutes = new Hono<AppEnv>()

const NIL_ORG = "00000000-0000-0000-0000-000000000000"

const bodySchema = z.object({
  factory: z.string().min(1),
  /** The org the factory writes in; omitted only for a factory that makes an org. */
  orgId: z.string().uuid().optional(),
  args: z.record(z.string(), z.unknown()).default({}),
})

seedTestRoutes.post("/", zValidator("json", bodySchema), async (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  const body = c.req.valid("json")
  const factory = SEED_FACTORIES[body.factory]
  if (!factory) {
    return c.json(
      {
        error: {
          code: "unknown_factory",
          message: `unknown seed factory '${body.factory}'; known: ${Object.keys(SEED_FACTORIES).sort().join(", ")}`,
        },
      },
      400,
    )
  }
  const parsed = factory.args.safeParse(body.args)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "invalid_args",
          message: `seed factory '${body.factory}': ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "args"}: ${i.message}`)
            .join("; ")}`,
        },
      },
      400,
    )
  }
  if (factory.org !== "none" && !body.orgId) {
    return c.json(
      {
        error: { code: "invalid_args", message: `seed factory '${body.factory}': orgId required` },
      },
      400,
    )
  }
  // A factory that makes an org gets a context on the nil org; it writes nothing there.
  const ctx = seedContext({ orgId: body.orgId ?? NIL_ORG, now: new Date() })
  try {
    const data = await factory.run(ctx, parsed.data, { key: randomUUID() })
    return c.json({ data })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    rootLogger.error({ err, factory: body.factory, orgId: body.orgId }, "test seed factory refused")
    return c.json(
      { error: { code: "seed_refused", message: `seed factory '${body.factory}': ${message}` } },
      422,
    )
  }
})

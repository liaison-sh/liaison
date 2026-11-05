// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scripted-turn control route — how a browser scenario tells the SERVER what
// the agent will say on its next turn(s) in a given thread. The panel's
// client-side SSE stub died with P4c-T17; this is its server-side replacement,
// paired with `modules/agent/providers/scripted-model-provider.ts`.
//
// Mounted only when `qaSeedRoutesEnabled` (NODE_ENV=test or ENABLE_QA_SEED_ROUTES),
// exactly like `seed/route.ts`; the env validator refuses the flag in
// production. The provider itself is additionally gated on
// `LIAISON_MODEL_PROVIDER=scripted`, so registering a script on a server that
// did not opt in is a no-op rather than a surprise.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import {
  clearScriptedTurns,
  remainingScriptedSteps,
  type ScriptedStep,
  scriptedModelEnabled,
  setScriptedRoutine,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"

export const agentScriptTestRoutes = new Hono<AppEnv>()

const stepSchema = z.object({
  text: z.string().optional(),
  reasoning: z.string().optional(),
  toolCalls: z
    .array(z.object({ name: z.string().min(1), args: z.unknown().optional() }))
    .optional(),
  delayMs: z.number().min(0).max(5000).optional(),
  // How long the step's test effect tools wait inside their execution (a turn
  // cut mid-tool, harness/test-effect-tools.ts).
  toolDelayMs: z.number().min(0).max(120_000).optional(),
  // `echo` answers out of the prompt this step was given (see ScriptedStep):
  // the only way a scenario can assert on content the turn deliberately keeps
  // out of `metadata.toolCalls`, such as decrypted mail.
  echo: z.string().min(1).max(500).optional(),
})

const bodySchema = z.object({
  threadId: z.string().optional(),
  // A routine run's thread is created by the worker, so a scenario scripts the
  // routine: its runs replay these steps when the run thread has no script.
  routineId: z.string().optional(),
  steps: z.array(stepSchema).max(50),
})

/** POST /api/_test/agent-script — replace a thread's scripted turn steps. */
agentScriptTestRoutes.post("/", zValidator("json", bodySchema), async (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  const { threadId, routineId, steps } = c.req.valid("json")
  if (routineId) await setScriptedRoutine(routineId, steps as ScriptedStep[])
  else await setScriptedTurn(threadId ?? null, steps as ScriptedStep[])
  return c.json({
    data: {
      ok: true,
      threadId: threadId ?? null,
      routineId: routineId ?? null,
      steps: steps.length,
      providerActive: scriptedModelEnabled(),
    },
  })
})

/** DELETE /api/_test/agent-script — drop one thread's or routine's script, or all of them. */
agentScriptTestRoutes.delete("/", async (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  const threadId = c.req.query("threadId") ?? null
  const routineId = c.req.query("routineId") ?? null
  await clearScriptedTurns(threadId, routineId)
  return c.json({ data: { ok: true, threadId, routineId } })
})

/** GET /api/_test/agent-script?threadId=... — steps still unread (diagnostic). */
agentScriptTestRoutes.get("/", async (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  const threadId = c.req.query("threadId") ?? null
  return c.json({
    data: {
      remaining: await remainingScriptedSteps(threadId),
      providerActive: scriptedModelEnabled(),
    },
  })
})

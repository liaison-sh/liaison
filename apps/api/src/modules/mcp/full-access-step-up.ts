// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A FRESH STEP-UP BEFORE AN AI TOOL GETS THE PERSON'S WHOLE ACCESS.
//
// An MCP connection bound to no agent carries everything its owner can do, for
// its whole life (until revoked, or until a password change or reset ends it).
// Both paths that mint one, the OAuth authorize consent and the MCP device-grant
// approval, used to accept a signed-in session alone, so whoever held a stolen
// session could hand themselves a standing credential. Approving one now also
// takes a fresh step-up: a code emailed by `POST /api/auth/totp/step-up` with
// purpose `mcp_connect`, which the approval pages send as soon as they show it.
//
// The emailed code is the only proof here, never the password: the approval
// pages carry no password field (a browser autofilled a saved password, and a
// saved username into the code field, on accounts that have no Liaison password
// at all), and the server accepts what the pages ask for, nothing else.
//
// "Full access" is the code's own rule, the one the approval pages already warn
// about: a connection bound to no agent. One bound to an agent is narrowed to
// that agent's ceiling and needs no step-up; a silent re-consent of a client the
// person already approved mints no new trust and needs none either.

import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { assertStepUp, StepUpRequiredError } from "~/modules/auth/step-up"

/** The proof a full-access approval carries in its JSON body. */
const proofSchema = z.object({
  stepUpCode: z
    .string()
    .length(6, "Step-up code must be exactly 6 digits")
    .regex(/^\d+$/, "Step-up code must contain only digits")
    .optional(),
})

export type FullAccessProof = z.infer<typeof proofSchema>

/** Read the step-up proof out of a request body (unknown keys, a password among them, ignored). */
export function readFullAccessProof(body: unknown): FullAccessProof {
  const parsed = proofSchema.safeParse(body ?? {})
  if (!parsed.success) {
    throw new HTTPException(422, { message: parsed.error.issues[0]?.message ?? "Invalid proof" })
  }
  return { stepUpCode: parsed.data.stepUpCode }
}

/**
 * Throws unless `proof` carries the approver's fresh emailed code:
 * `StepUpRequiredError` (400, `STEP_UP_REQUIRED`) without one, the usual
 * step-up refusals (422, 429) for a wrong one. An accepted code is spent.
 */
export async function assertFullAccessStepUp(
  userId: string,
  proof: FullAccessProof,
): Promise<void> {
  if (proof.stepUpCode === undefined) {
    throw new StepUpRequiredError(
      "Provide stepUpCode: the code emailed by POST /api/auth/totp/step-up with purpose mcp_connect",
    )
  }
  await assertStepUp(userId, null, { stepUpCode: proof.stepUpCode }, "mcp_connect")
}

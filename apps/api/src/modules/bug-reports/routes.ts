// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import {
  discardAgentDraft,
  listPendingAgentDrafts,
  readAgentDraft,
  sendAgentDraft,
} from "~/modules/bug-reports/agent-drafts"
import {
  BugReportError,
  bugReportSchema,
  fileBugReport,
  forwardingState,
  forwardPreviewSchema,
  previewBugReportForward,
} from "~/modules/bug-reports/service"

const draftParam = z.object({ draftId: z.uuid() })
const draftSendSchema = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict()

export const bugReports = new Hono<AppEnv>()

// A BugReportForwardError (409 FORWARDING_UNAVAILABLE / FORWARD_PAYLOAD_CHANGED
// with the new preview in `details`, 400 for an attachment that cannot be sent)
// carries its own status, code and details to the error handler.
const asHttp = (err: unknown): unknown =>
  err instanceof BugReportError ? new HTTPException(err.status, { message: err.message }) : err

bugReports
  .post("/", zValidator("json", bugReportSchema), async (c) => {
    try {
      return success(c, await fileBugReport(c.get("orgId"), c.get("userId"), c.req.valid("json")))
    } catch (err) {
      throw asHttp(err)
    }
  })
  // Whether "Also send to the Liaison team" is offered (any signed-in member).
  .get("/forwarding", async (c) => success(c, await forwardingState(c.get("orgId"))))
  // Reports an agent prepared for the Liaison team (team-only), the signed-in
  // reporter's own: listed, read, and sent only by them (agent-drafts.ts).
  .get("/drafts", async (c) =>
    success(c, await listPendingAgentDrafts(c.get("orgId"), c.get("userId"))),
  )
  .get("/drafts/:draftId", zValidator("param", draftParam), async (c) => {
    const draft = await readAgentDraft(
      c.get("orgId"),
      c.get("userId"),
      c.req.valid("param").draftId,
    )
    if (!draft) throw new HTTPException(404, { message: "This report has expired" })
    return success(c, draft)
  })
  // The reporter drops a prepared report instead of sending it. The draft is
  // looked up under the caller's own org and user key, so another member's
  // draft (or one already gone) is a 404, the same answer as reading it.
  .delete("/drafts/:draftId", zValidator("param", draftParam), async (c) => {
    const result = await discardAgentDraft(
      c.get("orgId"),
      c.get("userId"),
      c.req.valid("param").draftId,
    )
    if (!result.discarded) throw new HTTPException(404, { message: "This report has expired" })
    return success(c, result)
  })
  .post(
    "/drafts/:draftId/send",
    zValidator("param", draftParam),
    zValidator("json", draftSendSchema),
    async (c) =>
      success(
        c,
        await sendAgentDraft(
          c.get("orgId"),
          c.get("userId"),
          c.req.valid("param").draftId,
          c.req.valid("json").digest,
        ),
      ),
  )
  // The exact payload the reporter would forward, from one frozen snapshot.
  .post("/forward-preview", zValidator("json", forwardPreviewSchema), async (c) => {
    try {
      return success(
        c,
        await previewBugReportForward(c.get("orgId"), c.get("userId"), c.req.valid("json")),
      )
    } catch (err) {
      throw asHttp(err)
    }
  })

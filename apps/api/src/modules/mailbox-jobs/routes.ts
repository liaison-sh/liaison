// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client job REST surface (spec section 5.3c), mounted under `/api/mailbox`.
//
// Every route is owner scoped and carries no app scope: a queue of one person's
// mailbox work is not something an org role grants access to. Ownership is
// enforced by RLS on `kernel.mailbox_client_jobs`, so these handlers are thin.
//
// There is deliberately no route that ENQUEUES a job. Jobs are written by
// server-side envelope triggers through the sandbox bridge, where the kind and
// the envelope-only payload are checked on the host side. A client-facing
// enqueue would let a compromised tab write whatever it liked into the queue and
// have another of the user's devices run it.

import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import * as service from "~/modules/mailbox-jobs/service"

const sessionSchema = z.object({
  /** An opaque per-tab id the drainer mints. It identifies a lease holder and
   *  nothing else, so it is never trusted for authorisation. */
  sessionId: z.string().min(1).max(200),
})

const completeSchema = sessionSchema.extend({
  status: z.enum(["done", "failed"]),
  resultCiphertext: z
    .string()
    .max(2 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64")
    .nullish(),
})

const listSchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const mailboxJobsRoutes = new Hono<AppEnv>()

mailboxJobsRoutes.get("/client-jobs", zValidator("query", listSchema), async (c) => {
  const query = c.req.valid("query")
  const requested = (query.status ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is service.ClientJobStatus =>
      (service.CLIENT_JOB_STATUSES as readonly string[]).includes(value),
    )
  const jobs = await withRequestRls(c, (tx) =>
    service.listJobs(tx, c.get("userId"), c.get("orgId"), {
      status: requested,
      limit: query.limit,
    }),
  )
  return success(c, jobs)
})

mailboxJobsRoutes.post("/client-jobs/:id/claim", zValidator("json", sessionSchema), async (c) => {
  const claim = await withRequestRls(c, (tx) =>
    service.claimJob(
      tx,
      c.get("userId"),
      c.get("orgId"),
      c.req.param("id"),
      c.req.valid("json").sessionId,
    ),
  )
  return success(c, claim)
})

mailboxJobsRoutes.post("/client-jobs/:id", zValidator("json", completeSchema), async (c) => {
  const body = c.req.valid("json")
  const job = await withRequestRls(c, (tx) =>
    service.completeJob(tx, c.get("userId"), c.get("orgId"), c.req.param("id"), {
      sessionId: body.sessionId,
      status: body.status,
      resultCiphertext: body.resultCiphertext ?? null,
    }),
  )
  return success(c, job)
})

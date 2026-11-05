// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `createCloudOrg`: the org a Control signup creates on a cell (`POST
// /api/cloud/orgs`). Idempotent on (slug, owner email), keyed by the slug in the
// outcome store, which also serialises two creations of one slug:
//  - the slug is checked first: held by another owner, or by an org this API did
//    not create → 409, nothing written;
//  - then, each step idempotent so a resumed attempt completes the org: `ensureOrg`
//    with what follows its commit (apps, login provider, default views), the
//    owner as an active passwordless admin, the tier for the plan and the caps.
// The stored reply never expires (a late retry must still get its 200, and the
// slug check alone would answer 409); deleting the org (modules/org/purge)
// removes it with the org row. The included credits are the credits row's
// opening balance (ensureOrg). The server's default models are added, the first
// as Auto (default-models.ts), so the first chat has a model. Gmail mailboxes
// are switched on when the deployment provides the Google client (the same
// test Settings > Mail shows as "configured"), so the owner can connect a
// mailbox at once; a self-hosted org keeps them off until an admin turns them
// on. No inbox is created: the first mail connection makes one the default.
// A second attempt on a slug being created waits for the first and answers its
// reply; the route never holds a request past Control's deadline.

import {
  CLOUD_ERROR_CODES,
  type CloudCreateOrgReply,
  type CloudCreateOrgRequest,
  type CloudErrorReply,
} from "@liaison/control-plane-contract"
import type { OrgCaps } from "@liaison/shared"
import { eq, or } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { setMailProviderEnabled } from "~/modules/mail/provider-settings"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { getGoogleIntegrationSummary } from "~/modules/settings/google-integration"
import { ensureManagedDefaultModels } from "./default-models"
import { CLOUD_CREATE_ORG_ENDPOINT, claimOutcome, completeOutcome, releaseClaim } from "./outcomes"

const log = rootLogger.child({ module: "cloud-create-org" })

const ENDPOINT = CLOUD_CREATE_ORG_ENDPOINT

/** The kernel tier each Cloud plan maps onto. */
const PLAN_TIER: Record<CloudCreateOrgRequest["plan"], string> = {
  preview: "starter",
  base: "team",
  pro: "business",
}

export type CloudResult =
  | { status: 200; reply: CloudCreateOrgReply }
  | { status: 400 | 404 | 409 | 503; reply: CloudErrorReply }

type CreateRequest = Omit<CloudCreateOrgRequest, "caps"> & { caps?: OrgCaps }

const busyResult = (): CloudResult => ({
  status: 503,
  reply: { ok: false, code: CLOUD_ERROR_CODES.busy },
})

/**
 * How long this endpoint holds a request. Control calls from a sandbox whose
 * fetch gives up at 10 s, and the first org on a cell (its apps' schemas are
 * created then) can take longer than that.
 */
export const CREATE_ANSWER_BUDGET_MS = 8_000
const JOIN_POLL_MS = 250

/**
 * The route's door: the reply when it comes in time, else `busy`, while the
 * creation goes on. Control's next attempt joins it (`createCloudOrg`), so a
 * slow create is one create with a few waits, never a failure.
 */
export async function createCloudOrgWithinBudget(
  req: CreateRequest,
  budgetMs: number = CREATE_ANSWER_BUDGET_MS,
): Promise<CloudResult> {
  const work = createCloudOrg(req, Date.now() + budgetMs)
  // The answer may leave without it: a later failure is logged, and its stale claim resumes.
  work.catch((err) => log.error({ err, slug: req.slug }, "cloud org creation failed"))
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<CloudResult>((resolve) => {
    timer = setTimeout(() => resolve(busyResult()), budgetMs)
  })
  try {
    return await Promise.race([work, budget])
  } finally {
    clearTimeout(timer)
  }
}

export async function createCloudOrg(
  req: CreateRequest,
  /** While the key is held by a running attempt, wait for its reply until this time. */
  joinUntil: number = 0,
): Promise<CloudResult> {
  const ownerEmail = req.ownerEmail.toLowerCase()
  let claim = await claimOutcome(ENDPOINT, req.slug, ownerEmail)
  while (claim.kind === "busy" && Date.now() < joinUntil) {
    await Bun.sleep(JOIN_POLL_MS)
    claim = await claimOutcome(ENDPOINT, req.slug, ownerEmail)
  }
  if (claim.kind === "done") return { status: 200, reply: claim.reply as CloudCreateOrgReply }
  if (claim.kind === "mismatch") {
    return { status: 409, reply: { ok: false, code: CLOUD_ERROR_CODES.slugTaken } }
  }
  if (claim.kind === "busy") return busyResult()

  const holders = await withSystemDb("cloud-create-org-check", (db) =>
    db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(
        req.orgId === undefined
          ? eq(organizations.slug, req.slug)
          : or(eq(organizations.slug, req.slug), eq(organizations.id, req.orgId)),
      ),
  )
  const bySlug = holders.find((h) => h.slug === req.slug)
  const idTakenElsewhere = holders.some((h) => h.id === req.orgId && h.slug !== req.slug)

  // A fresh claim on a held slug: the org was not made by this API for this owner.
  // A resumed claim on it: our own earlier attempt created it, then died.
  if ((bySlug && !claim.resumed) || idTakenElsewhere) {
    await releaseClaim(ENDPOINT, req.slug)
    return { status: 409, reply: { ok: false, code: CLOUD_ERROR_CODES.slugTaken } }
  }

  // On a resumed claim too: what follows the org's commit in there (its apps, the login provider,
  // the default views) is the slow part, so that is where a create dies. Idempotent by slug.
  const { orgId } = await ensureOrg({
    id: req.orgId,
    slug: req.slug,
    name: req.name,
    locale: req.locale,
    credits: { initial: req.includedCredits ?? "0" },
  })

  await ensureUser({
    orgId,
    email: ownerEmail,
    name: req.ownerName,
    role: "admin",
    allowPasswordless: true,
  })
  await withSystemDb("cloud-create-org-plan", (db) =>
    db
      .update(organizations)
      .set({ tier: PLAN_TIER[req.plan], ...(req.caps !== undefined ? { caps: req.caps } : {}) })
      .where(eq(organizations.id, orgId)),
  )

  if ((await getGoogleIntegrationSummary(orgId)).configured) {
    await setMailProviderEnabled(orgId, "gmail", true)
  }

  // Best effort: an OpenRouter outage must not fail the signup. The org then
  // starts without them, and its first turn adds them (default-models.ts,
  // ensureManagedDefaultModelsOnDemand).
  try {
    await ensureManagedDefaultModels(orgId)
  } catch (err) {
    log.error({ err, orgId }, "managed org created without its default models")
  }

  const reply: CloudCreateOrgReply = { ok: true, orgId, slug: req.slug }
  await completeOutcome(ENDPOINT, req.slug, 200, reply)
  return { status: 200, reply }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one way in to a restricted agreement for an admin. While anyone on its list is active,
// an admin gets no row and no hint. Once every person on it has been deactivated for 7 days,
// `POST /api/apps/agreements/agreements/:id/claim` (a route, never a tool: no agent claims)
// adds the caller to the list, and only then. The database decides, in
// `kernel.restricted_claim` (0331), under the caller's own context: the org and the person
// come from the request, the admin scope is checked there too, and every refusal answers the
// same 404 as an id that names nothing. A claim stays on the agreement for anyone reactivated
// to see, is audited (`agreements/agreement:claim`), lets the kernel's copies follow the new
// list (`agreements/agreement:access_changed`), and is mailed to everyone ever on the list.
//
// This is an access rule, not encryption: whoever runs the server can reach the data.

import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { extractRows } from "~/db"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { requireScope } from "~/middleware/require-scope"
import { serverT } from "~/modules/i18n/server-i18n"
import { getOrgEmailConfig } from "~/modules/org/email-from"

const log = rootLogger.child({ module: "restricted-claim" })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The scope a claim needs, checked by the route and again by the database function. */
export const CLAIM_SCOPE = "kernel:users:admin"

interface ClaimResult {
  state: "claimed" | "not_found" | "too_soon" | "not_allowed"
  number?: string
  visible_to?: string[]
  ever_listed?: string[]
}

const NOTHING = {
  error: {
    code: "NOT_FOUND",
    message: "No restricted agreement can be claimed with this id. Nothing was changed.",
  },
}

async function mailTheList(
  orgId: string,
  number: string,
  claimer: { name: string },
  people: Array<{ email: string; locale: string | null }>,
): Promise<void> {
  if (people.length === 0) return
  const cfg = await getOrgEmailConfig(orgId)
  const on = new Date().toISOString().slice(0, 10)
  for (const p of people) {
    const lang = p.locale?.startsWith("fr") ? "fr" : "en"
    const t = (key: string) =>
      serverT(lang, `agreement-evidence.claim.${key}`, { number, name: claimer.name, on })
    const subject = t("subject")
    const { html, text } = renderBrandedEmail({
      subject,
      heading: subject,
      paragraphs: [t("body"), t("why")],
      footer: [t("footer")],
    })
    // Each mail is sent on its own: one refused address never stops the others.
    await sendSystemEmailObserved({
      to: p.email,
      from: cfg.from,
      subject,
      html,
      text,
      template: "agreements.claimed",
    }).catch((err) => {
      log.warn({ err, orgId }, "A claim notice to a person once on the list was not sent")
    })
  }
}

export const restrictedClaimRoutes = new Hono<{
  Variables: {
    orgId: string
    userId: string
    scopes: string[]
    dimensionGrants: Record<string, string[]>
  }
}>().post("/agreements/agreements/:id/claim", requireScope(CLAIM_SCOPE), async (c) => {
  const id = c.req.param("id")
  if (!UUID.test(id)) return c.json(NOTHING, 404)
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const actor = {
    actorType: "user" as const,
    orgId,
    userId,
    scopes: c.get("scopes") ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
  }
  const ks = sql.raw(quoteIdent(schemaRef("kernel")))
  const out = await withRlsContext(actor, async (tx) => {
    const [row] = extractRows<{ r: ClaimResult }>(
      await tx.execute(sql`SELECT ${ks}.restricted_claim(${id}::uuid) AS r`),
    )
    const result = row?.r ?? { state: "not_found" }
    if (result.state !== "claimed") return { result, people: [], claimer: null }
    const visibleTo = result.visible_to ?? []
    await tx.queueEvent({
      app: "agreements",
      entity: "agreement",
      action: "claim",
      entityId: id,
      orgId,
      actorId: userId,
      data: { visible_to: visibleTo },
    })
    await tx.queueEvent({
      app: "agreements",
      entity: "agreement",
      action: "access_changed",
      entityId: id,
      orgId,
      actorId: userId,
      data: { org_access: "none", visible_to: visibleTo, version_ids: [] },
    })
    const ever = result.ever_listed ?? []
    const people =
      ever.length === 0
        ? []
        : extractRows<{ email: string; locale: string | null }>(
            await tx.execute(sql`
              SELECT email, locale FROM ${ks}.users
               WHERE org_id = ${orgId}::uuid AND id = ANY(${`{${ever.join(",")}}`}::uuid[])`),
          )
    const [me] = extractRows<{ name: string | null; email: string }>(
      await tx.execute(
        sql`SELECT name, email FROM ${ks}.users WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid`,
      ),
    )
    return { result, people, claimer: { name: me?.name || me?.email || "An admin" } }
  })
  if (out.result.state !== "claimed" || !out.claimer) return c.json(NOTHING, 404)
  const number = out.result.number ?? ""
  await mailTheList(orgId, number, out.claimer, out.people)
  return c.json({
    data: {
      status: "claimed",
      agreement_id: id,
      number,
      message: `You were added to the list of ${number}. Everyone who was ever on its list was told by mail, and the claim stays shown on the agreement.`,
    },
  })
})

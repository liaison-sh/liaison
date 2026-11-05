// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 11 S5 — Unauthorized denial + grant flip (spec §481).
//
// Updated for the Drive-style sharing model AND its search convergence
// (6ab56d97, migrations 0002-0004; 0008 ports the Meili permission filter off
// the old team/sensitivity dimension model onto the same sharing ACL). Every
// read surface — REST, agent, AND search — now enforces the SAME `org_access`
// + explicit user/role shares plane. team/sensitivity continue to gate
// CLASSIFICATION at write time (assertCanSetDimensions) but grant no read
// access on their own, on any surface — including search, as of 0008.
//
// Elodie creates an organization doc tagged team=[eng-leads] sensitivity=
// confidential with org_access='none' (restricted to owner + shares — also the
// sensitivity-coupled DEFAULT now, kept explicit here since explicitness in
// tests is good). Tobias has knowledge:documents:read but no share — every
// read surface must deny, search included, with no dimension grants involved.
// The grant flip is a SINGLE per-user share (viewer) via PUT
// /documents/:id/sharing; the search-visibility assertion below now also
// proves the share→reindex pipeline (the `share` action re-upserts the doc's
// acl_user_ids into Meili).
//
// Four surfaces under test before and after the grant flip:
//   1. UI federated search (tobias does not see the entry)
//   2. REST GET — zero-knowledge 404 envelope (T23)
//   3. Kernel /api/search
//   4. Federated search via /api/knowledge/search (sandbox/agent path)

import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { createKnowledgeDocument, searchKnowledge } from "./helpers/knowledge-seed"
import { grantUserDimension, seedFactory } from "./helpers/seed"

/** A role carrying `scope` for the person (the role editor's services, as the org's admin). */
async function grantUserScope(
  env: Parameters<typeof grantUserDimension>[0],
  orgId: string,
  userId: string,
  scope: string,
): Promise<void> {
  await seedFactory(env, orgId, "roles.grantScopes", { userId, scopes: [scope] })
}

async function freshLogin(
  env: { serverUrl: string },
  email: string,
  password: string,
): Promise<string> {
  const res = await api(env.serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email, password },
  })
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.data.accessToken as string
}

test("unauthorized-denial-then-grant-flip", async ({ page, env, qa, world }) => {
  const suffix = env.schemaPrefix.replace(/_$/, "")
  const title = `Eng-Leads Confidential Doc ${suffix}`
  const body = `Eng confidential body ${suffix}`

  // NOTE: QA seed grants every user `team:["*"]` and `sensitivity:["restricted"]`
  // for dev convenience (QA_KNOWLEDGE_DIMENSIONS in apps/api/src/seed/world/qa.ts). Under
  // the old dimension-gated search filter that contradicted this test's denial
  // invariant, requiring an explicit revoke here. As of 0008 (search
  // convergence onto the sharing ACL), team/sensitivity grants no longer gate
  // ANY read surface — only classification at write time — so Tobias's broad
  // dimension grants are irrelevant to whether he can read this doc, and no
  // revoke is needed.

  // Elodie needs team=[eng-leads] and sensitivity=[confidential] grants
  // before he can create an org doc tagged with those dimensions
  // (assertCanSetDimensions enforces this).
  await grantUserDimension(env, world.org.id, qa.admin.id, "team", ["eng-leads"])
  // The kernel's `sensitivity` dimension (knowledge reads `knowledge:sensitivity` as it).
  await grantUserDimension(env, world.org.id, qa.admin.id, "sensitivity", ["confidential"])
  const adminToken = await freshLogin(env, "admin@test.com", "12345678")
  ;(qa.admin as { token: string }).token = adminToken

  // 1. Elodie creates the org doc with team=[eng-leads], sensitivity=confidential
  //    and org_access='none' — under the sharing model, org docs default to
  //    org_access='editor' (org-wide readable), which would trivially defeat
  //    the denial phase. 'none' restricts reads to owner/creator + shares.
  let doc: { id: string } | null = null
  try {
    doc = await createKnowledgeDocument(env, qa.admin.token, {
      title,
      body,
      documentScope: "organization",
      sensitivity: "confidential",
      team: ["eng-leads"],
      orgAccess: "none",
    })
  } catch (err) {
    // If the admin role lacks a confidential sensitivity grant, the world is
    // not set up for this scenario — fail loud rather than masking with skip.
    throw new Error(`createKnowledgeDocument (org/confidential) failed: ${String(err)}`)
  }

  // 2. Grant tobias the knowledge:documents:read scope so the access check
  //    reaches the dimension filter (without the scope, the kernel filter
  //    returns null and all hits are dropped before dimensions even matter).
  await grantUserScope(env, world.org.id, qa.tobias.id, "knowledge:documents:read")
  // Re-mint tobias's token to pick up the new scope.
  const tobiasToken = await freshLogin(env, qa.tobias.email, "QaPass1!")
  ;(qa.tobias as { token: string }).token = tobiasToken

  // 3. Wait for indexer to surface the doc for admin (proves the row is in
  //    Meili before testing denial paths against it).
  const indexDeadline = Date.now() + 30_000
  let indexed = false
  while (Date.now() < indexDeadline && !indexed) {
    const res = await searchKnowledge(env, qa.admin.token, title)
    indexed = res.hits.some((h) => h.sourceEntityId === doc!.id)
    if (!indexed) await new Promise((r) => setTimeout(r, 500))
  }
  expect(indexed, "doc must be indexed for admin before denial paths can be tested").toBe(true)

  // ── PHASE A — no share, org_access='none': tobias sees nothing on any surface ──

  // 4. UI search as tobias — no row.
  await loginAs(page, env, qa.tobias.email, "QaPass1!")
  await page.getByTestId("activity-knowledge").click()
  await page.getByTestId("knowledge-sidebar-search-input").fill(title)
  await page.waitForTimeout(1500)
  await expect(page.getByTestId(`knowledge-search-result-document-${doc.id}`)).toHaveCount(0)

  // 5. REST GET → zero-knowledge 404.
  const restDenied = await fetch(`${env.serverUrl}/api/knowledge/documents/${doc.id}`, {
    headers: { authorization: `Bearer ${tobiasToken}` },
  })
  expect(restDenied.status).toBe(404)

  // 6. Kernel /api/search → no entity matches doc id.
  const kernelDenied = await fetch(
    `${env.serverUrl}/api/search?q=${encodeURIComponent(title)}&limit=20`,
    { headers: { authorization: `Bearer ${tobiasToken}` } },
  )
  expect(kernelDenied.status).toBe(200)
  const kernelDeniedJson = (await kernelDenied.json()) as {
    data: { entities?: Array<{ id: string }> }
  }
  expect((kernelDeniedJson.data.entities ?? []).every((e) => e.id !== doc!.id)).toBe(true)

  // 7. Federated knowledge search → empty.
  const fedDenied = await searchKnowledge(env, tobiasToken, title)
  expect(fedDenied.hits.every((h) => h.sourceEntityId !== doc.id)).toBe(true)

  // 7a. Per-tab routing denial — tobias directly navigating (or following a
  //     shared bookmark) to the confidential doc's per-document URL must be
  //     denied at the tab layer: the document fetch 404s, the view self-evicts
  //     its tab (KnowledgeDocumentView → evictTabByEntity), and no
  //     `knowledge:document` tab survives. The denial path lands back on the
  //     previous surface, not /knowledge/documents/.
  await page.goto(`http://localhost:${env.ports[1]}/knowledge/documents/${doc.id}`)
  await expect(page.getByTestId("knowledge-document-view")).toHaveCount(0, {
    timeout: 10_000,
  })
  await expect(
    page.locator('[data-testid="tabstrip"] [data-tab-type="knowledge:document"]'),
  ).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/knowledge\/documents\//)

  // ── PHASE B — grant flip: share the doc with tobias; he should now see it ──
  //
  // A single per-user share is now the ONLY grant needed — REST, search, and
  // the agent-facing federated search all key off the exact same sharing ACL
  // (org_access + document_shares + document_role_shares, mirrored into Meili
  // via acl_user_ids/acl_role_ids by the 0008 search convergence). No
  // dimension re-grant is needed for tobias to see the doc in search.

  // REST reads are governed by the sharing ACL: admin (owner) shares the doc
  // with tobias as viewer via the sharing endpoint.
  const shareRes = await fetch(`${env.serverUrl}/api/knowledge/documents/${doc.id}/sharing`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${qa.admin.token}`,
    },
    body: JSON.stringify({
      orgAccess: "none",
      editScope: null,
      shares: [{ userId: qa.tobias.id, role: "viewer" }],
    }),
  })
  expect(shareRes.status, await shareRes.clone().text()).toBe(200)

  // 8. REST GET → 200 with body intact.
  const restAllowed = await fetch(`${env.serverUrl}/api/knowledge/documents/${doc.id}`, {
    headers: { authorization: `Bearer ${tobiasToken}` },
  })
  expect(restAllowed.status, await restAllowed.clone().text()).toBe(200)
  const restAllowedJson = (await restAllowed.json()) as {
    data: { id: string; title: string }
  }
  expect(restAllowedJson.data.id).toBe(doc.id)
  expect(restAllowedJson.data.title).toBe(title)

  // 9. Federated knowledge search → now includes the doc. Polls up to 15s
  //    because the share must propagate through the indexer (planFromEvent's
  //    "share" upsert verb → recomputed acl_user_ids → Meili) before it
  //    becomes visible — this also proves the share→reindex pipeline works.
  const allowDeadline = Date.now() + 15_000
  let sawAfterGrant = false
  while (Date.now() < allowDeadline && !sawAfterGrant) {
    const res = await searchKnowledge(env, tobiasToken, title)
    sawAfterGrant = res.hits.some((h) => h.sourceEntityId === doc!.id)
    if (!sawAfterGrant) await new Promise((r) => setTimeout(r, 500))
  }
  expect(sawAfterGrant).toBe(true)
})

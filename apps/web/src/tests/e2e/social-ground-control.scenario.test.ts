// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B10 — Social "Ground Control" end-to-end journey.
//
// The killer path exercised entirely against the spawned kernel + the
// sandbox-fetch platform mock (Facebook Graph), with the social app registered
// FROM SOURCE (never frozen/installed — the bundled-app discipline):
//
//   1. INSTALL + CONNECT — the `_test` install route registers the app from
//      source and seeds a `social` connected_account (the connection-established
//      setup path ran). `/api/apps` lists `social` as a registered app and the
//      `social-overview` GUIDE was seeded into the skill registry through the
//      real reconcile (asserted via the production `skill_read` path, §9 #11).
//   2. FINDING → UI → DRAFT → APPROVE → POST — a seeded finding renders in the
//      Findings surface; the gated `reply_to_finding` makes ZERO Graph POSTs
//      before approval, then EXACTLY ONE after approve, and the finding reads
//      `handled` (§4.3 / §9 #4). The detail panel becomes the approval surface
//      when status=awaiting_approval.
//   3. MESSAGES WINDOW — an in-window DM shows the open pill + compose; a DM
//      whose last inbound is >7d old shows the "Window closed" pill + the
//      native-app fallback (no compose) — the §9 #2 recompute, in the UI.
//   4. ROUTINE LIFECYCLE — enabling the morning-digest template instantiates one
//      app routine (sourceKind:'app'); deactivating the app flips it to
//      `paused_app_disabled` WITHOUT deleting it; reactivating restores `active`
//      (Task A12 / §9 last / §1 #10).
import { loginAs } from "./fixtures/test"
import { decideApproval, waitForApproval } from "./helpers/approvals"
import {
  assertSocialBundle,
  expect,
  SOCIAL_MANIFEST,
  test,
} from "./social-ground-control/helpers/social-fixtures"
import {
  deactivateSocial,
  enableTemplate,
  getFinding,
  getSocialRequests,
  graphCommentPosts,
  installSocialApp,
  listRoutines,
  reactivateSocial,
  readGuide,
  resetSocialMock,
  seedConversation,
  seedFinding,
  socialTool,
} from "./social-ground-control/helpers/social-harness"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

test.describe("Social Ground Control — full journey (B10)", () => {
  test("connect → finding → draft → approve → post → routine lifecycle", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertSocialBundle()
    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id
    await resetSocialMock(s, token)

    // ── 1. INSTALL + CONNECT ──────────────────────────────────────────────────
    const installed = await installSocialApp({ serverUrl: s, token, orgId })
    expect(installed.appName).toBe("social")
    expect(installed.connectedAccountId).toBeTruthy()

    // The app is registered + reachable through the kernel: a read tool resolves
    // (200, no "tool not found"). `/api/apps` lists DB-installed + in-tree apps;
    // a from-source registration is neither, so tool-reachability is the genuine
    // proof the runtime registered the app's tools for this org.
    const reach = await socialTool({ serverUrl: s, token, tool: "findings_list", params: {} })
    expect(reach.status, JSON.stringify(reach.body)).toBe(200)
    expect(Array.isArray((reach.body as { findings?: unknown[] }).findings)).toBe(true)

    // The social-overview GUIDE was seeded through the real reconcile path and
    // is readable via the production skill_read tool (§9 #11). Non-placeholder.
    const guide = await readGuide({ serverUrl: s, token, orgId })
    expect(guide.error, JSON.stringify(guide)).toBeUndefined()
    expect(guide.name).toBe("social-overview")
    expect((guide.body ?? "").length).toBeGreaterThan(120)
    expect((guide.body ?? "").toLowerCase()).toMatch(/facebook|instagram|youtube|brand/)

    // ── 2. FINDING → UI → DRAFT → APPROVE → POST ──────────────────────────────
    // Seed a Facebook comment-on-our-content finding (likeable + replyable).
    const finding = await seedFinding({
      serverUrl: s,
      token,
      orgId,
      platform: "facebook",
      relation: "comment_on_our_content",
      contentText: "Love this! Where can I buy one?",
      authorHandle: "@superfan",
      status: "new",
    })
    expect(finding.findingId).toBeTruthy()

    // The Findings surface renders the seeded finding (master/detail).
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })
    await page.goto(`${viteUrl}/social/findings`)
    await page.waitForLoadState("networkidle")
    const mountError = page.locator('[data-testid="plugin-mount-error-social"]')
    if (await mountError.isVisible().catch(() => false)) {
      throw new Error(`social UI bundle failed to mount: ${await mountError.textContent()}`)
    }
    await expect(page.locator('[data-testid="social-findings-list"]')).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      page.locator(`[data-testid="social-finding-row-${finding.findingId}"]`),
    ).toBeVisible({
      timeout: 15_000,
    })
    // Selecting it surfaces the detail panel (also the approval surface).
    await page.locator(`[data-testid="social-finding-row-${finding.findingId}"]`).click()
    await expect(page.locator('[data-testid="social-finding-detail"]')).toBeVisible()
    const bundleErrors = consoleErrors.filter((m) =>
      /Failed to fetch dynamically imported module|does not provide an export named|window\.__liaisonHost/.test(
        m,
      ),
    )
    expect(bundleErrors).toEqual([])

    // Gate proof: zero Graph comment POSTs recorded so far.
    expect(graphCommentPosts(await getSocialRequests(s, token)).length).toBe(0)

    // Draft + post via the gated reply_to_finding tool, staged by the agent
    // (approvals are for agents: the person's own call would post at once).
    // reply_to_finding is gated: the agent's call parks an approval (NO external
    // post yet); the human approves; the kernel runs the handler with
    // ctx.approval set; the post fires EXACTLY ONCE.
    const reply = await socialTool({
      serverUrl: s,
      token,
      asAgent: true,
      tool: "reply_to_finding",
      params: {
        finding_id: finding.findingId,
        reply_text: "Thanks! You can grab one on our site.",
      },
    })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    // The first entry parks for approval (handler-conditional or kernel-gate),
    // making ZERO external posts.
    const replyStatus = reply.body.status as string | undefined
    const blocked = reply.body.blocked as { approvalRequestId?: string } | undefined
    expect(
      replyStatus === "pending_approval" || Boolean(blocked?.approvalRequestId),
      `reply_to_finding should park for approval, got ${JSON.stringify(reply.body)}`,
    ).toBe(true)
    expect(graphCommentPosts(await getSocialRequests(s, token)).length).toBe(0)
    // The kernel gate parks the agent's call before the handler runs, so nothing
    // is written on the finding; reads derive its state from the pending
    // approval: awaiting, with the staged draft and the approval id.
    const awaiting = await getFinding({ serverUrl: s, token, findingId: finding.findingId })
    expect(awaiting.finding, JSON.stringify(awaiting)).toMatchObject({
      status: "awaiting_approval",
      suggested_reply: "Thanks! You can grab one on our site.",
      ...(blocked?.approvalRequestId ? { approval_request_id: blocked.approvalRequestId } : {}),
    })
    // The Findings surface shows it: the status badge and the draft in the composer.
    await page.reload()
    await page.locator(`[data-testid="social-finding-row-${finding.findingId}"]`).click()
    await expect(page.locator('[data-testid="social-finding-status"]')).toHaveText(
      "Awaiting approval",
    )
    await expect(page.locator('[data-testid="social-reply-text"]')).toHaveValue(
      "Thanks! You can grab one on our site.",
    )
    // Approve → the kernel re-enters the handler → the post fires once.
    const pending = await waitForApproval({ serverUrl: s, token, toolPrefix: "social:" })
    const decided = await decideApproval({
      serverUrl: s,
      token,
      requestId: pending.id,
      decision: "approve",
    })
    expect(decided.status, JSON.stringify(decided.body)).toBe(200)

    // Exactly one Graph comment POST recorded (post-approval or direct).
    let posts = graphCommentPosts(await getSocialRequests(s, token))
    const deadline = Date.now() + 15_000
    while (posts.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      posts = graphCommentPosts(await getSocialRequests(s, token))
    }
    expect(posts.length).toBe(1)
    // The reply text rode in the POST body (never the URL) — injection-safe (L5).
    const sentBody = JSON.parse(posts[0].body ?? "{}") as { message?: string }
    expect(sentBody.message).toContain("grab one on our site")
    // The URL was built from the finding's external id, not the reply text.
    expect(new URL(posts[0].url).pathname).toMatch(/\/comments$/)

    // The finding now reads `handled` (§9 #4).
    const after = await getFinding({ serverUrl: s, token, findingId: finding.findingId })
    const findingRow = (after.finding ?? after) as { status?: string }
    expect(findingRow.status, JSON.stringify(after)).toBe("handled")

    // Re-entry idempotency: a second reply makes ZERO additional Graph POSTs.
    await socialTool({
      serverUrl: s,
      token,
      asAgent: true,
      tool: "reply_to_finding",
      params: { finding_id: finding.findingId, reply_text: "second attempt" },
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(graphCommentPosts(await getSocialRequests(s, token)).length).toBe(1)

    // ── 3. MESSAGES WINDOW (open pill vs closed-window fallback) ──────────────
    // An OPEN DM (just received) → open pill + compose.
    const openConvo = await seedConversation({
      serverUrl: s,
      token,
      orgId,
      platform: "instagram",
      participantHandle: "@open_dm",
      lastInboundAt: new Date().toISOString(),
    })
    // A CLOSED DM (last inbound > 7d ago) → "Window closed" pill + native fallback.
    const closedConvo = await seedConversation({
      serverUrl: s,
      token,
      orgId,
      platform: "instagram",
      participantHandle: "@closed_dm",
      lastInboundAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000).toISOString(),
    })
    await page.goto(`${viteUrl}/social/messages`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="social-messages-list"]')).toBeVisible({
      timeout: 15_000,
    })

    // Open conversation → window pill present + compose enabled (no fallback).
    await page
      .locator(`[data-testid="social-conversation-row-${openConvo.conversationId}"]`)
      .click()
    await expect(page.locator('[data-testid="social-dm-window-pill"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-dm-compose"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-dm-fallback"]')).toHaveCount(0)

    // Closed conversation → native-app fallback, no compose.
    await page
      .locator(`[data-testid="social-conversation-row-${closedConvo.conversationId}"]`)
      .click()
    await expect(page.locator('[data-testid="social-dm-fallback"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-dm-open-native"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-dm-compose"]')).toHaveCount(0)

    // ── 4. ROUTINE LIFECYCLE (enable → pause on deactivate → resume) ──────────
    const enabled = await enableTemplate({
      serverUrl: s,
      token,
      app: "social",
      key: "morning-digest",
    })
    // The enable route returns 201 Created (instantiates one routine from the template).
    expect([200, 201], JSON.stringify(enabled.body)).toContain(enabled.status)
    const routinesAfterEnable = await listRoutines({ serverUrl: s, token })
    const morning = routinesAfterEnable.find(
      (r) => r.appName === "social" && r.templateKey === "morning-digest",
    )
    expect(morning, JSON.stringify(routinesAfterEnable)).toBeTruthy()
    expect(morning?.status).toBe("active")
    expect(morning?.sourceKind).toBe("app")

    // Deactivate the app → the instantiated routine is paused, NOT deleted.
    await deactivateSocial({ serverUrl: s, token, orgId })
    const routinesAfterPause = await listRoutines({ serverUrl: s, token })
    const morningPaused = routinesAfterPause.find((r) => r.id === morning?.id)
    expect(morningPaused, "routine must still exist after deactivate (no data loss)").toBeTruthy()
    expect(morningPaused?.status).toBe("paused_app_disabled")

    // Reactivate → the routine resumes to active.
    await reactivateSocial({ serverUrl: s, token, orgId })
    const routinesAfterResume = await listRoutines({ serverUrl: s, token })
    const morningResumed = routinesAfterResume.find((r) => r.id === morning?.id)
    expect(morningResumed?.status).toBe("active")
  })
})

test("manifest declares the social-overview guide + community-manager agent + morning-digest template", async () => {
  // A static guard that the shipped manifest carries the Component-A assets B8
  // wires — cheap, no server. Mirrors the boxtal install smoke's manifest checks.
  const { readFileSync } = await import("node:fs")
  const manifest = JSON.parse(readFileSync(SOCIAL_MANIFEST, "utf8")) as {
    name: string
    skills?: Record<string, { kind?: string }>
    agents?: Record<string, unknown>
    routines?: Record<string, { kind?: string }>
  }
  expect(manifest.name).toBe("social")
  expect(manifest.skills?.["social-overview"]?.kind).toBe("guide")
  expect(manifest.agents && "community-manager" in manifest.agents).toBe(true)
  expect(manifest.routines && "morning-digest" in manifest.routines).toBe(true)
})

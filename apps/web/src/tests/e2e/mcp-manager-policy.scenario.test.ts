// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 15 — E2E extension — MCP Manager Policy flip round-trip.
//
// Closes the SC#8 gap noted in the E2E plan: "admin flips
// `connection_default_policy` from `auto` to `gate_all`, next write-class agent
// call returns the gated structured response". Validates the end-to-end
// boundary the three split-coverage unit tests
// (PolicyTab.test.tsx, policy-routes.test.ts, call.test.ts policy=gate)
// only cover in isolation.
//
// Why `gate_all` instead of `gate_writes`: the mock MCP fixture's `echo` tool
// is annotated read-only-safe (no destructiveHint, no readOnlyHint set → the
// projector's gate_writes branch in projector.ts treats it as "needs gate"
// anyway because !readOnlyHint, but the orchestrator's runtime resolver in
// repo.ts:getPolicyForCall reads the *cached annotations* and only gates
// when destructive/non-readonly). `gate_all` skips that ambiguity by gating
// every tool unconditionally — the scenario semantics are identical
// (default policy flipped from `auto` to something-not-auto → next call
// gates).
//
// Mirrors S2's pattern: warm the connection via `POST /connections/:id/test`
// before any browser interaction so we don't race the first dial. The
// policy flip is observed both via UI (PolicyTab radio click) and verified
// via the executeTool round-trip.

import path from "node:path"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"

const SHOTS_DIR = path.resolve(__dirname, "../../../logs/playwright-diagnostics/mcp-policy")

test("admin flips policy to gate_all; next call returns gated structured response", async ({
  authenticatedPage,
  env,
  qa,
}) => {
  const page = authenticatedPage
  if (!env.mockMcp) throw new Error("Per-worker mock-MCP fixture failed to start")

  // 1. Seed the connection with `auto` policy via the kernel API (admin token).
  const slug = `policy-${env.workerId}`
  const createRes = await api(env.serverUrl, "/api/apps/mcp-manager/connections", {
    method: "POST",
    token: qa.admin.token,
    body: {
      slug,
      displayName: "Policy Flip Test",
      transport: "http",
      ownershipScope: "org",
      authFlavor: "none",
      connectionDefaultPolicy: "auto",
      httpUrl: env.mockMcp.url,
    },
  })
  expect([200, 201]).toContain(createRes.status)
  const createdBody = createRes.body as { id?: string; data?: { id?: string } }
  const connectionId = createdBody.id ?? createdBody.data?.id
  expect(
    connectionId,
    `expected id in create response, got: ${JSON.stringify(createdBody)}`,
  ).toBeTruthy()
  if (!connectionId) throw new Error("create response missing id")

  // 2. Warm the connection (status → connected, no first-dial race per S2).
  // Assert BOTH status AND body.ok — the /test endpoint returns 200 with
  // ok:false on dial failure, which would silently let the next executeTool
  // call 404 on an unregistered tool. The ok:true assertion surfaces dial
  // failures with the actual error message.
  const testRes = await api(
    env.serverUrl,
    `/api/apps/mcp-manager/connections/${connectionId}/test`,
    { method: "POST", token: qa.admin.token },
  )
  expect(testRes.status).toBe(200)
  const testBody = testRes.body as {
    ok?: boolean
    error?: { message?: string; code?: string }
    tools?: Array<{ name: string }>
  }
  expect(
    testBody.ok,
    `/test returned ok=false (dial failed). Body: ${JSON.stringify(testBody)}`,
  ).toBe(true)
  expect(
    testBody.tools?.length,
    `/test returned 0 tools — projector didn't register. Body: ${JSON.stringify(testBody)}`,
  ).toBeGreaterThan(0)

  // Tool name as projected: `mcp:<slug>:<sanitized-server-tool>`.
  // The mock fixture exposes `echo` (already lowercase + no special chars,
  // so `sanitizeToolName("echo") === "echo"`).
  const toolName = `mcp:${slug}:echo`
  const toolPath = `/api/apps/tools/${encodeURIComponent(toolName)}`

  // 3. Baseline call under `auto` — expect a successful round-trip.
  // executeTool wraps the projected handler's return value as `data`, so the
  // orchestrator's `{ ok: true, data: <SDK callTool response> }` envelope
  // surfaces as `body.data` on the HTTP response. Asserting `ok: true` is
  // sufficient — the actual SDK callTool payload shape (content array) is
  // exercised at the unit layer.
  const autoCall = await api(env.serverUrl, toolPath, {
    method: "POST",
    token: qa.admin.token,
    body: { params: { message: "hello from auto" } },
  })
  expect(autoCall.status).toBe(200)
  const autoBody = autoCall.body as {
    data?: { ok?: boolean; data?: unknown; error?: { code?: string; reason?: string } }
  }
  expect(
    autoBody.data?.ok,
    `expected ok=true under auto policy, got: ${JSON.stringify(autoBody)}`,
  ).toBe(true)

  // 4. Navigate to the server's page (Tools & policy section) and flip the radio.
  await page.goto(`http://localhost:${env.ports[1]}/settings/connectors`)
  await expect(page.getByTestId("connectors-mcp")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`mcp-row-${slug}`)).toBeVisible({ timeout: 10000 })
  await page.screenshot({ path: `${SHOTS_DIR}/01-list-with-row.png`, fullPage: true })

  // Open the server's page: its sections (no tabs) include the policy.
  await page.getByTestId(`mcp-open-${slug}`).click()
  await expect(page.getByTestId("mcp-detail-section-tools")).toBeVisible({ timeout: 10000 })
  // A server created over the API was never reviewed, so its page opens the tools
  // review for an admin. Closing it keeps the current default and marks it reviewed.
  await expect(page.getByTestId("mcp-tools-review")).toBeVisible({ timeout: 10000 })
  await page.getByTestId("mcp-tools-review-close").click()
  await expect(page.getByTestId("mcp-tools-review")).toBeHidden({ timeout: 10000 })
  await page.screenshot({ path: `${SHOTS_DIR}/02-detail-open.png`, fullPage: true })

  // Radios live inside `mcp-policy-default-radios`; testids use underscore
  // spelling per PolicyTab.tsx (`mcp-policy-radio-${p}` for p in
  // ["auto","gate_writes","gate_all"]). There is no explicit save button —
  // `onChange` immediately PATCHes the connection.
  await expect(page.getByTestId("mcp-policy-radio-auto")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("mcp-policy-radio-gate_all")).toBeVisible()
  await page.screenshot({ path: `${SHOTS_DIR}/03-policy-tab.png`, fullPage: true })

  // 5. Flip to `gate_all` — assert the radio reflects the change after PATCH
  // round-trip + refetch.
  await page.getByTestId("mcp-policy-radio-gate_all").click()
  await expect(page.getByTestId("mcp-policy-radio-gate_all")).toBeChecked({ timeout: 10000 })
  await page.screenshot({ path: `${SHOTS_DIR}/04-policy-flipped.png`, fullPage: true })

  // 6. Repeat the executeTool call — orchestrator's runtime policy resolver
  // reads from DB on every call (call.ts:getPolicyForCall), so the next call
  // must come back gated. The projected handler returns the orchestrator's
  // structured deny envelope `{ ok: false, error: { code: "denied",
  // reason: "gate_required" } }`. executeTool's `normalizeToolErrorResult`
  // pattern-matches the `error` field and re-throws an Error tagged with
  // `code: "denied"`; the global error handler (middleware/error-handler.ts)
  // surfaces it as a 500 with `{ error: { code: "denied", message, details: { retryable: false } } }`.
  //
  // Known limitation (not asserted here): the orchestrator's `reason` field
  // ("gate_required") is dropped by `normalizeToolErrorResult` because it
  // only extracts `code`/`message`/`retryable` — the structured reason lives
  // in the call's audit row (verified at the unit layer by call.test.ts).
  const gatedCall = await api(env.serverUrl, toolPath, {
    method: "POST",
    token: qa.admin.token,
    body: { params: { message: "hello from gate_all" } },
  })
  expect(gatedCall.status).toBe(500)
  const gatedBody = gatedCall.body as {
    error?: { code?: string; message?: string; details?: { retryable?: boolean } }
  }
  expect(
    gatedBody.error?.code,
    `expected code=denied under gate_all, got: ${JSON.stringify(gatedBody)}`,
  ).toBe("denied")
  expect(gatedBody.error?.details?.retryable).toBe(false)
})

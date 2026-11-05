// SPDX-License-Identifier: FSL-1.1-ALv2
// Connection setup guides + generic credential-connect form — browser E2E +
// visual golden.
//
// Journey: Settings → Connectors (admin) → the in-tree `gitlab` connector
// declares a credentials connection; its card opens on the generic connect
// form (one input per declared credentialField) → open the "?" setup-guide
// popover (summary + numbered steps + docs link).
//
// Everything renders from gitlab's REAL manifest connection config — the
// credentialFields and the setupGuide — exercising the full path:
// connectionConfigRegistry → GET /api/apps/:app/connections → form + popover.
// One visual golden: the open setup-guide popover.

import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures/test"

/** The GitLab card on Connectors, open on its connect form. */
async function openGitlabConnectForm(page: Page, port: number) {
  await page.goto(`http://localhost:${port}/settings/connectors?open=gitlab`)
  const body = page.getByTestId("connector-body-gitlab")
  await expect(body).toBeVisible({ timeout: 15_000 })
  const connect = body.getByTestId("connections-connect-gitlab")
  await expect(connect).toBeVisible({ timeout: 15_000 })
  await connect.click()
  const form = body.getByTestId("gitlab-inline-connect")
  await expect(form).toBeVisible({ timeout: 10_000 })
  return form
}

test("[Connections] Connectors → GitLab card → generic connect form", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  const form = await openGitlabConnectForm(page, env.ports[1])
  // The generic form rendered gitlab's two declared credential fields, with the
  // token field as a password input (driven entirely off credentialFields).
  const token = form.getByTestId("connect-field-token")
  await expect(token).toBeVisible()
  await expect(token).toHaveAttribute("type", "password")
  await expect(form.getByTestId("connect-field-group")).toBeVisible()
  await expect(form.getByTestId("connect-submit")).toBeVisible()
})

test("[Connections] Connectors → setup-guide popover visual golden", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  await openGitlabConnectForm(page, env.ports[1])

  // Open the "?" setup-guide popover next to the form header.
  await page.getByRole("button", { name: /how to connect gitlab/i }).click()
  const guide = page.getByTestId("setup-guide-content")
  await expect(guide).toBeVisible()

  // Functional: the popover renders gitlab's authored guide — summary mentioning
  // the Personal Access Token, numbered steps, and the GitLab docs link.
  await expect(guide).toContainText(/personal access token/i)
  await expect(page.getByTestId("setup-guide-step").first()).toBeVisible()
  await expect(page.getByTestId("setup-guide-docs")).toHaveAttribute("href", /docs\.gitlab\.com/)

  // ── Visual golden: the open setup-guide popover ──────────────────────────
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await expect(guide).toHaveScreenshot("setup-guide-popover-gitlab.png", {
    maxDiffPixelRatio: 0.02,
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-validation-protocol — sentinel scenario marking the §10
// validation protocol checkpoint. Asserts the Tickets activity bar entry is
// reachable; the substantive checks live in the other tickets-*.scenario.*
// files referenced by §10.
import { expect, loginAs, test } from "./fixtures/test"

test("[SC17] tickets-validation-protocol: activity bar entry reachable", async ({
  page,
  env,
  qa,
}) => {
  await loginAs(page, env, qa.admin.email, "12345678")
  await expect(page.getByTestId("activity-tickets")).toBeVisible({ timeout: 10000 })
})

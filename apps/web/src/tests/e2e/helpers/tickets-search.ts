// SPDX-License-Identifier: FSL-1.1-ALv2
// Free-text inbox search over tickets seeded straight into SQL.
//
// The inbox search resolves matches through Meili only (tickets search.ts,
// resolveTicketMatchIds). `seedTicket` writes rows with no domain event, so
// nothing indexes them and a search for their subject correctly returns
// nothing: the rows already on screen go into their exit transition and are
// removed, and any click on them races a detaching element. Index the seeded
// rows through the real `search reindex`, wait until the API search returns
// them, and only then type the query.
import { api, type WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect } from "../fixtures/test"
import { runSearchReindex } from "./mailbox-seed"

export async function indexSeededTickets(
  env: WorkerEnv,
  credentials: { email: string; password: string },
  query: string,
  ticketIds: string[],
): Promise<void> {
  const reindex = await runSearchReindex(env)
  expect(reindex.exitCode, `search reindex failed: ${reindex.stderr}`).toBe(0)
  const login = await api(env.serverUrl, "/api/auth/login", {
    method: "POST",
    body: credentials,
  })
  const token = login.body.data.accessToken as string
  await expect
    .poll(
      async () => {
        const res = await api(env.serverUrl, "/api/apps/run-tool", {
          method: "POST",
          token,
          body: { toolName: "tickets:search", params: { query } },
        })
        const items = (res.body?.data?.items ?? []) as Array<{ id: string }>
        const found = new Set(items.map((t) => t.id))
        return ticketIds.filter((id) => !found.has(id))
      },
      { message: `seeded tickets never became searchable for "${query}"`, timeout: 15000 },
    )
    .toEqual([])
}

/** Type the query and wait for every row to be settled in the result, not
 *  still on screen from the previous view while it exits. */
export async function searchInboxFor(page: Page, query: string, ticketIds: string[]) {
  await page.getByTestId("tickets-search-input").fill(query)
  for (const id of ticketIds) {
    const row = page.getByTestId(`tickets-list-row-${id}`)
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row).toHaveAttribute("data-exiting", "false", { timeout: 15000 })
  }
}

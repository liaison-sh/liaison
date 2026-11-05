// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 13 — S-4: Admin Data Export produces a real downloadable zip with a
// manifest; the CSV row count matches RLS-visible tickets; the partial-skip
// contract is surfaced. S-8 (second test): F1 documentation probe — export
// with a date range records the (currently un-threaded) behavior.
//
// Spec E2 (Admin Data Export view: select apps, format, Export → zip +
// manifest.json + download), E3 (Tickets CSV contains visible rows with
// declared columns under RLS). The QA world is bootstrapped but carries no
// tickets and no enabled apps, so this scenario seeds its own tickets, grants
// Elodie tickets scopes, and enables the `tickets` app on the org row before
// asserting.

import { readFileSync } from "node:fs"
import { login } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { enableAppForOrg, readZipEntries } from "./helpers/org-export"
import { grantTicketsScopes, seedTicket } from "./helpers/seed"

/** CSV data-row count: total newline-terminated lines minus the header. */
function csvDataRowCount(csv: string): number {
  const lines = csv.split("\n").filter((l) => l.length > 0)
  return Math.max(0, lines.length - 1) // first line is the header
}

test("data export: admin export -> real zip + manifest + RLS row-count parity + partial-skip contract", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  const page = authenticatedPage

  // Seed a deterministic number of tickets for the worker org and grant
  // Elodie tickets visibility (QA users carry only kernel/mail scopes).
  const TICKET_COUNT = 3
  for (let i = 0; i < TICKET_COUNT; i++) {
    await seedTicket(env, world.org.id, {
      subject: `Export probe ticket ${i + 1}`,
      status: "open",
      priority: "normal",
    })
  }
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  // grantTicketsScopes bumps permission_version, invalidating every
  // previously-issued JWT (including the fixture-captured qa.admin.token).
  // Re-login for a FRESH token carrying the new tickets scopes for the
  // server-side cross-checks below.
  const { accessToken: adminToken } = await login(env.serverUrl, "admin@test.com", "12345678")

  // Enable the `tickets` app so it appears in the Data Export multi-select.
  await enableAppForOrg(env, world.org.id, "tickets")

  // 1. Empty state: no app selected ⇒ submit disabled (E2 empty state).
  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/data-export`)
  await expect(page.getByTestId("admin-data-export")).toBeVisible({
    timeout: 15000,
  })
  await expect(page.getByTestId("data-export-app-tickets")).toBeVisible({
    timeout: 15000,
  })
  await expect(page.getByTestId("data-export-submit")).toBeDisabled()

  // 2. Select tickets + CSV ⇒ submit enabled.
  await page.getByTestId("data-export-app-tickets").click()
  await page.getByTestId("data-export-format-csv").click()
  await expect(page.getByTestId("data-export-submit")).toBeEnabled()

  // 3. Click Export and capture the real browser download.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("data-export-submit").click(),
  ])

  // 4. The done affordance appears (no skip for a json+csv app).
  await expect(page.getByTestId("data-export-done")).toBeVisible({
    timeout: 15000,
  })

  // 5. Read the downloaded zip; assert manifest.json + a tickets entry.
  const zipPath = await download.path()
  expect(zipPath, "download produced a file on disk").toBeTruthy()
  const zipBytes = new Uint8Array(readFileSync(zipPath!))
  const entries = readZipEntries(zipBytes)
  const names = entries.map((e) => e.name)
  expect(names).toContain("manifest.json")
  const ticketsEntry = entries.find((e) => e.name === "tickets.csv")
  expect(ticketsEntry, `zip entries: ${names.join(",")}`).toBeTruthy()

  const manifestEntry = entries.find((e) => e.name === "manifest.json")!
  const manifest = JSON.parse(manifestEntry.text) as {
    apps: string[]
    schemaVersions: Record<string, string>
    files: Record<string, string>
    skipped: Array<{ app: string; reason: string }>
  }
  expect(manifest.apps).toContain("tickets")
  expect(manifest.files.tickets).toBe("tickets.csv")
  expect(manifest.schemaVersions.tickets).toBeTruthy()
  expect(manifest.skipped).toEqual([])

  // 6. E3 RLS row-count parity. The CSV is `header\n<rows>\n`. The worker
  // schema is shared (and Playwright retries re-seed into it), so the
  // absolute count is non-deterministic; the load-bearing invariant is
  // PARITY: the UI CSV export's data-row count must equal the JSON export
  // length from the SAME production orchestrator/RLS path (GET /api/export) —
  // neither empty nor over-exported — and must include at least the tickets
  // this test seeded (RLS shows them to admin).
  const csv = ticketsEntry!.text
  const csvRows = csvDataRowCount(csv)
  expect(csvRows).toBeGreaterThanOrEqual(TICKET_COUNT)
  // Header row carries the app-declared columns (non-empty, has known cols).
  const header = csv.split("\n")[0]!
  expect(header.length).toBeGreaterThan(0)
  expect(header).toContain("id")
  expect(header).toContain("subject")
  expect(header).toContain("status")

  // Cross-check via the GET export (same orchestrator, same RLS actor) — the
  // JSON array length must match the CSV data-row count exactly.
  const jsonExportRes = await fetch(`${env.serverUrl}/api/export?apps=tickets&format=json`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  expect(jsonExportRes.status).toBe(200)
  const jsonZip = new Uint8Array(await jsonExportRes.arrayBuffer())
  const jsonEntries = readZipEntries(jsonZip)
  const ticketsJson = jsonEntries.find((e) => e.name === "tickets.json")
  expect(ticketsJson, "GET export has tickets.json").toBeTruthy()
  const ticketsArr = JSON.parse(ticketsJson!.text) as unknown[]
  expect(ticketsArr.length).toBeGreaterThanOrEqual(TICKET_COUNT)
  // The decisive RLS-correctness invariant: UI CSV rows == API JSON rows.
  expect(ticketsArr.length).toBe(csvRows)

  // 7. Partial-skip contract (server-side, real orchestrator path). Every
  // shipped app supports json+csv, so no enabled app declines a shipped
  // format — a UI-driven skip cannot fire (per the E2E plan: assert the
  // server skip contract directly rather than ship a scenario that can't
  // fire). Request a valid app + an unregistered app: the orchestrator
  // catches the per-app ExportError (404 no handler) and records it in
  // manifest.skipped, mirrored into the X-Export-Skipped response header.
  const skipRes = await fetch(`${env.serverUrl}/api/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      appNames: ["tickets", "no-such-app-xyz"],
      format: "json",
    }),
  })
  expect(skipRes.status).toBe(200)
  const skipHeader = skipRes.headers.get("X-Export-Skipped")
  expect(skipHeader, "X-Export-Skipped header present").toBeTruthy()
  const skipped = JSON.parse(skipHeader!) as Array<{
    app: string
    reason: string
  }>
  const bogus = skipped.find((s) => s.app === "no-such-app-xyz")
  expect(bogus, `skipped: ${skipHeader}`).toBeTruthy()
  expect(bogus!.reason).toMatch(/no export handler/i)
  // The valid app still exported alongside the skip (true partial success).
  const skipZip = new Uint8Array(await skipRes.arrayBuffer())
  const skipEntries = readZipEntries(skipZip)
  const skipManifest = JSON.parse(skipEntries.find((e) => e.name === "manifest.json")!.text) as {
    apps: string[]
    skipped: Array<{ app: string; reason: string }>
  }
  expect(skipManifest.apps).toContain("tickets")
  expect(skipManifest.skipped.some((s) => s.app === "no-such-app-xyz")).toBe(true)
  // The header mirrors manifest.json exactly (UI renders from the header).
  expect(skipped).toEqual(skipManifest.skipped)
})

test("data export (F1 probe): export with a date range succeeds and records current behavior", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  const page = authenticatedPage

  // seedTicket stamps created_at = now(), so a 2000-01-01..2000-12-31 export
  // window must exclude every seeded ticket. This verifies P13-I1 end-to-end
  // through the Admin Data Export UI: dateRange is threaded from the view →
  // route → orchestrator → each app handler, so the windowed export is empty
  // while the unwindowed export still returns the rows.
  const TICKET_COUNT = 2
  for (let i = 0; i < TICKET_COUNT; i++) {
    await seedTicket(env, world.org.id, {
      subject: `F1 probe ticket ${i + 1}`,
    })
  }
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  // Fresh token after the permission_version bump (see S-4 note).
  const { accessToken: adminToken } = await login(env.serverUrl, "admin@test.com", "12345678")
  await enableAppForOrg(env, world.org.id, "tickets")

  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/data-export`)
  await expect(page.getByTestId("admin-data-export")).toBeVisible({
    timeout: 15000,
  })
  await page.getByTestId("data-export-app-tickets").click()
  await page.getByTestId("data-export-format-csv").click()

  // Narrow window that — IF dateRange were threaded — would exclude the
  // just-seeded (now()) tickets entirely.
  await page.getByTestId("data-export-from").fill("2000-01-01")
  await page.getByTestId("data-export-to").fill("2000-12-31")

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("data-export-submit").click(),
  ])
  await expect(page.getByTestId("data-export-done")).toBeVisible({
    timeout: 15000,
  })

  // Weak invariant: the export still succeeds and produces a valid zip with a
  // non-empty manifest enumerating the tickets app (no crash on date range).
  const zipPath = await download.path()
  expect(zipPath).toBeTruthy()
  const entries = readZipEntries(new Uint8Array(readFileSync(zipPath!)))
  const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json")!.text) as {
    apps: string[]
  }
  expect(manifest.apps).toContain("tickets")

  // Record (do not assert filtered-equivalence): with F1 unfixed, the windowed
  // export still contains all rows because dateRange is not threaded to the
  // handler. Cross-check against the unwindowed GET export.
  const windowedCsv = entries.find((e) => e.name === "tickets.csv")!.text
  const windowedRows = csvDataRowCount(windowedCsv)
  const fullRes = await fetch(`${env.serverUrl}/api/export?apps=tickets&format=json`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const fullEntries = readZipEntries(new Uint8Array(await fullRes.arrayBuffer()))
  const fullRows = (
    JSON.parse(fullEntries.find((e) => e.name === "tickets.json")!.text) as unknown[]
  ).length

  // F1 FIXED (P13-I1): dateRange is now threaded through the orchestrator into
  // every export handler. The narrow 2000-01-01..2000-12-31 window excludes
  // EVERY ticket (all seeded at now()), so the windowed export is empty while
  // the unwindowed export still returns the seeded rows. The worker schema is
  // shared, so absolute counts accumulate — assert the relation, not absolutes.
  expect(windowedRows).toBe(0) // window excludes all now()-seeded tickets
  expect(fullRows).toBeGreaterThanOrEqual(TICKET_COUNT) // unwindowed still returns them
  expect(windowedRows).toBeLessThan(fullRows) // date-range genuinely narrows
})

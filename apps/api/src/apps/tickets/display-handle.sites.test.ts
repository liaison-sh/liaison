// SPDX-License-Identifier: FSL-1.1-ALv2
// A12: every surface that SHOWS a ticket handle carries the display form
// (`ticket-B2B-12`), and every surface that READS one resolves any form by
// number. This enumerates the sites, so a new copy of a raw `t.handle` output
// (or a site that drops the helper) fails here and gets a decision. The
// behaviour itself is proven in display-handle.test.ts, search.handle-key,
// render, summarizers.ref and id-segment-settings.route.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..")
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8")

/** Output sites: each must compute the display handle. */
const OUTPUT_SITES: Array<[file: string, marker: RegExp]> = [
  // get + search + list-for-contact + summary prompt + set-field results
  ["modules/apps/sandbox/bridge/tickets.ts", /loadSegmentConfig[\s\S]*toCamelTicket\([^)]*segment/],
  ["modules/apps/sandbox/bridge/tickets.ts", /applyDisplayHandles/],
  ["modules/apps/sandbox/bridge/tickets.ts", /displayHandleFor/],
  ["apps/tickets/projection.ts", /displayTicketHandle/],
  ["apps/tickets/backlog-health.ts", /applyDisplayHandles/],
  ["apps/tickets/sla-report.ts", /applyDisplayHandles/],
  ["apps/tickets/attention.ts", /displayHandleOfRow/],
  ["apps/tickets/jobs.ts", /displayHandleOfRow/],
  ["apps/tickets/create.ts", /displayTicketHandle/],
  ["apps/tickets/merge.ts", /displayHandleFor/],
  ["apps/tickets/state-machine.ts", /displayHandleFor/],
  ["apps/tickets/summarizers.ts", /displayHandleOfRow/],
  ["apps/tickets/tools.ts", /displayHandleFor/],
  ["apps/tickets/render.ts", /stripTicketHandleTags/],
  ["apps/tickets/admin.ts", /applyDisplayHandles/],
  ["apps/tickets/search-enrichment.ts", /displayHandleOfRow/],
  ["modules/mail/service.ts", /displayTicketHandle/],
  ["modules/apps/sandbox/bridge/conversion.ts", /displayHandleFor/],
  ["modules/webhooks/tickets-public.ts", /displayHandleOfRow/],
  ["modules/approvals/attention.ts", /summary\.ref/],
]

/** Input sites: each must resolve through the number-based lookup. */
const INPUT_SITES: Array<[file: string, marker: RegExp]> = [
  ["apps/tickets/resolve-ticket-ref.ts", /lookupTicketIdByHandle/],
  ["apps/tickets/search.ts", /lookupTicketIdByHandle/],
  ["apps/tickets/inbound.ts", /lookupTicketIdByHandle/],
  ["apps/tickets/merge.ts", /resolveTicketRef/],
]

describe("ticket handle sites", () => {
  it.each(OUTPUT_SITES)("%s shows the display handle", (file, marker) => {
    expect(read(file)).toMatch(marker)
  })

  it.each(INPUT_SITES)("%s resolves every handle form", (file, marker) => {
    expect(read(file)).toMatch(marker)
  })

  it("the database app's raw SQL examples document the STORED form", () => {
    expect(read("modules/apps/connections/sql/adapters/liaison-self.ts")).toMatch(/stored handle/i)
  })
})

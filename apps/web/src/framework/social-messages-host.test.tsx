// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression test for ticket-9967: the social app's Messages page rendered an
// empty conversation list even though dm_list returns conversations. Roots the
// bug at the host `app.createResource` wiring the Messages surface uses to load
// its list. Exercises the REAL createStaleResource-backed host resource with a
// stub invokeTool that returns conversations — asserting the rows actually
// render.

import type { HostServices } from "@liaison/host"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createStaleResource } from "~/primitives/createStaleResource"
import { Messages } from "../../../../bundled-apps/social/src/ui/Messages"

// One representative open conversation (dm_list shape) — enough to prove rows render.
const CONVERSATIONS = [
  {
    id: "dm-1",
    platform: "instagram",
    participant_handle: "@alice",
    last_inbound_at: new Date().toISOString(),
    last_message_snippet: "hi there",
    status: "open",
  },
  {
    id: "dm-2",
    platform: "facebook",
    participant_handle: "@bob",
    last_inbound_at: new Date().toISOString(),
    last_message_snippet: "hello",
    status: "open",
  },
]

function installHost(): void {
  const host: Partial<HostServices> = {
    accessToken: () => "t",
    // The Messages surface only invokes dm_list (list) + dm_get (detail).
    invokeTool: (async (_app: string, tool: string) => {
      if (tool === "dm_list") return { conversations: CONVERSATIONS }
      if (tool === "dm_get") return { conversation: CONVERSATIONS[0], messages: [] }
      return {}
    }) as HostServices["invokeTool"],
    // The REAL host createResource wiring — the exact delegation apps/web ships.
    createResource: (<T,>(fetcher: () => T | Promise<T>, opts?: { staleAfterMs?: number }) => {
      const res = createStaleResource<T>(fetcher, opts)
      return [res, { refetch: res.refetch, mutate: res.mutate }]
    }) as HostServices["createResource"],
  }
  ;(globalThis as unknown as { __liaisonHost: unknown }).__liaisonHost = host
  ;(globalThis as unknown as { __LIAISON_TEST_APP_NAME: string }).__LIAISON_TEST_APP_NAME = "social"
}

describe("social Messages surface (ticket-9967)", () => {
  beforeEach(() => installHost())
  afterEach(() => {
    ;(globalThis as unknown as { __liaisonHost?: unknown }).__liaisonHost = undefined
  })

  it("renders conversation rows returned by dm_list", async () => {
    const { container } = render(() => <Messages />)
    await waitFor(
      () => {
        expect(
          container.querySelector('[data-testid="social-conversation-row-dm-1"]'),
        ).not.toBeNull()
      },
      { timeout: 5000 },
    )
    expect(container.querySelector('[data-testid="social-conversation-row-dm-2"]')).not.toBeNull()
  })
})

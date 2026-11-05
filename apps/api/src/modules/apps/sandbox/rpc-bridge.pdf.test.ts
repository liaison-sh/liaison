// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B4 — `pdf_render` RPC bridge integration tests. Exercises the
// capability gate plus the forwarding seam into the kernel-side `renderPdf`
// helper. The K2 renderer's own behaviour (templates, pool, ghostscript
// fallback, file storage) is covered in detail in
// `modules/pdf/render.test.ts`; here we only check the bridge contract.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { PdfRegistryTestAccess, registerTemplate } from "~/modules/pdf/registry"
import { TEST_FIXTURE_SOURCE } from "~/modules/pdf/templates/test-fixture"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createRpcBridge } from "./rpc-bridge"

describe("rpc-bridge — pdf_render (K2)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })
  afterEach(() => {
    PdfRegistryTestAccess.clear()
  })

  test("rejects when the calling app did not declare 'pdf.render' capability", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    await withPrivilegedDb(org.id, "b4-no-cap", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: [] } as never,
      )
      await expect(
        bridge.pdf_render(
          JSON.stringify({ template_kind: "invoicing:test_v1", data: {}, pdf_a3: false }),
        ),
      ).rejects.toMatchObject({ code: "CAPABILITY_NOT_DECLARED" })
    })
  })

  test("forwards to renderPdf and returns a JSON envelope with file_id + byte_size", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    registerTemplate("invoicing", "invoicing:test_v1", TEST_FIXTURE_SOURCE)
    const raw = await withPrivilegedDb(org.id, "b4-forward", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: ["pdf.render"] } as never,
      )
      return bridge.pdf_render(
        JSON.stringify({
          template_kind: "invoicing:test_v1",
          data: { title: "Hi" },
          pdf_a3: false,
        }),
      )
    })
    const parsed = JSON.parse(raw) as {
      file_id?: string
      byte_size?: number
      page_count?: number
      pdf_a3_normalized?: boolean
    }
    expect(parsed.file_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(parsed.byte_size).toBeGreaterThan(100)
    expect(parsed.page_count).toBe(1)
    expect(parsed.pdf_a3_normalized).toBe(false)
  })

  test("returns an error envelope for unknown template_kind", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const raw = await withPrivilegedDb(org.id, "b4-not-found", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: ["pdf.render"] } as never,
      )
      return bridge.pdf_render(
        JSON.stringify({ template_kind: "invoicing:nope", data: {}, pdf_a3: false }),
      )
    })
    const parsed = JSON.parse(raw) as { error?: { code?: string } }
    expect(parsed.error?.code).toBe("template_not_found")
  })
})

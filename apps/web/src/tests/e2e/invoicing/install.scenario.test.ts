// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S0 — install smoke. Replaces the placeholder
// `bundle-smoke.scenario.test.ts` (which the same PR deletes).
//
// Proves:
//   1. The bundled `invoicing-<version>.liaisonapp` artifact exists on disk (version from the app manifest)
//      and the manifest declares the four Phase 17 PDF templates with the
//      suffixed `invoicing:<doc>_v1` `kind` strings (the corrected form;
//      the placeholder asserted the wrong-format `["invoice", ...]`).
//   2. The I1 install helper drives the full server-side install dance:
//      `installAppFromTarball` + `reloadInstalledApps` + issuer profile
//      seed + Mail connected_account seed. It returns the issuer +
//      mailAccount ids so downstream scenarios can chain.
//   3. After login, the Invoicing activity-bar entry mounts and the
//      sidebar's data-testid is reachable in the rendered DOM.
//   4. `window.__liaisonHost` carries the four host-bridge methods
//      (`fetch`/`invokeTool`/`openConnect`/`accessToken`) the bundle
//      reads at mount.
//   5. The page is free of bridge errors during navigation: no
//      `window.__liaisonHost` reference errors, no failed dynamic
//      imports, no missing-export errors, and no `ctx.requestApproval
//      is not a function` errors (the simplify-pass-flagged latent
//      concern from the bridge wiring).
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"

// __dirname = liaison/apps/web/src/tests/e2e/invoicing
// Walk up 6 levels: invoicing → e2e → tests → src → web → apps → liaison
const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle
const INVOICING_MANIFEST = resolve(LIAISON_ROOT, "bundled-apps/invoicing/app.manifest.json")

test.describe("Invoicing: install smoke", () => {
  test("install harness completes; sidebar reachable; window.__liaisonHost shape OK; no bridge errors", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // 1. Pre-install manifest shape checks (folded in from the placeholder).
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    expect(statSync(INVOICING_BUNDLE).size).toBeGreaterThan(1024)
    expect(existsSync(INVOICING_MANIFEST)).toBe(true)
    const manifest = JSON.parse(readFileSync(INVOICING_MANIFEST, "utf8")) as {
      name: string
      capabilities: string[]
      pdf_templates: Array<{ kind: string }>
      slots?: { contact_detail?: { panels?: Array<{ id: string }> } }
    }
    expect(manifest.name).toBe("invoicing")
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["messages.post", "pdf.render", "sequences.allocate"]),
    )
    expect(manifest.pdf_templates).toHaveLength(5)
    // The corrected (suffixed) `kind` strings: `invoicing:<doc>_v1`.
    const kinds = manifest.pdf_templates.map((t) => t.kind).sort()
    expect(kinds).toEqual([
      "invoicing:credit_note_v1",
      "invoicing:invoice_v1",
      "invoicing:po_v1",
      "invoicing:proforma_v1",
      "invoicing:quote_v1",
    ])
    expect(manifest.slots?.contact_detail?.panels?.[0]?.id).toBe("invoicing-documents")

    // 2. Drive the install via the I1 helper.
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
    })
    expect(installed.appName).toBe("invoicing")
    expect(installed.primaryIssuerProfileId).toBeTruthy()
    expect(installed.mailAccountId).toBeTruthy()

    // 3. Set up the bridge-error listener BEFORE navigation so we catch
    //    everything emitted during initial mount.
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })

    // 4. Login + navigate. Auth cookies are host-scoped to the Vite host;
    //    use the same host the loginAs helper reaches for.
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing`)
    await page.waitForLoadState("networkidle")

    // 5. Sidebar testid mounts. The Invoicing sidebar declares
    //    `data-testid="invoicing-sidebar"` (sidebar.tsx:329).
    await expect(page.locator('[data-testid="invoicing-sidebar"]')).toBeVisible({
      timeout: 15_000,
    })

    // 6. window.__liaisonHost has the four bridge methods.
    const hostShape = await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: window-global probe
      const h = (window as any).__liaisonHost
      return {
        hasFetch: typeof h?.fetch === "function",
        hasInvokeTool: typeof h?.invokeTool === "function",
        hasOpenConnect: typeof h?.openConnect === "function",
        hasAccessToken: typeof h?.accessToken === "function",
      }
    })
    expect(hostShape).toEqual({
      hasFetch: true,
      hasInvokeTool: true,
      hasOpenConnect: true,
      hasAccessToken: true,
    })

    // 7. No bridge errors in console.
    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named|ctx\.requestApproval is not a function/.test(
        m,
      ),
    )
    expect(bridgeErrors).toEqual([])
  })
})

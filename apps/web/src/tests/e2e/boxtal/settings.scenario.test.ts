// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S3 — Settings: ship-from (sender) address round-trips.
//
// The create path reads the sender from `app_config.sender_address` (Amendment
// 3). This scenario proves the round-trip end-to-end against the real kernel:
//   (tool) `settings_sender_address_set` persists a structured party; a fresh
//     `settings_sender_address_get` reads it back with `missing: []`.
//   (tool) a partial address reports the required-but-empty fields in `missing`.
//   (UI)   filling the ship-from fields of the app's settings page (each saves
//          on blur) persists the same party the tool reads — proving the
//          Settings surface drives the same store.
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { assertBoxtalBundle, BOXTAL_BUNDLE, expect, test } from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { resetMock } from "./helpers/mock-boxtal"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

const FULL_SENDER = {
  name: "Fabrikam SAS",
  phone: "+33123456789",
  // Every party needs an email: Boxtal rejects a shipment whose sender contact has none
  // (422 ValidationException.NotBlank), which is why address.ts lists it as required.
  email: "shipping@fabrikam.test",
  street: "12 Rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  countryIsoCode: "FR",
}

test.describe("Boxtal: settings sender address", () => {
  test("set then get round-trips the structured party with missing: []", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })

    // Fresh install: no sender persisted yet → get reports all-missing.
    const before = await api(env.serverUrl, "/api/apps/boxtal/tools/settings_sender_address_get", {
      method: "POST",
      token,
      body: { params: {} },
    })
    expect(before.status).toBe(200)
    const beforeData = unwrap(before.body)
    expect(beforeData.sender).toBeNull()
    // No persisted sender → the "all" sentinel.
    expect(beforeData.missing).toEqual(["all"])

    // Persist a complete ship-from address.
    const setResp = await api(env.serverUrl, "/api/apps/boxtal/tools/settings_sender_address_set", {
      method: "POST",
      token,
      body: { params: FULL_SENDER },
    })
    expect(setResp.status).toBe(200)
    const setData = unwrap(setResp.body)
    expect(setData.ok).toBe(true)
    // A complete party has no missing required fields.
    expect(setData.missing).toEqual([])

    // Read it back — the structured party round-trips field-for-field.
    const after = await api(env.serverUrl, "/api/apps/boxtal/tools/settings_sender_address_get", {
      method: "POST",
      token,
      body: { params: {} },
    })
    expect(after.status).toBe(200)
    const afterData = unwrap(after.body)
    const sender = afterData.sender as Record<string, unknown> | null
    expect(sender).toBeTruthy()
    expect(sender?.name).toBe(FULL_SENDER.name)
    expect(sender?.phone).toBe(FULL_SENDER.phone)
    expect(sender?.street).toBe(FULL_SENDER.street)
    expect(sender?.city).toBe(FULL_SENDER.city)
    expect(sender?.postalCode).toBe(FULL_SENDER.postalCode)
    expect(sender?.countryIsoCode).toBe(FULL_SENDER.countryIsoCode)
    // Complete → nothing missing.
    expect(afterData.missing).toEqual([])
  })

  test("a partial address reports the required-but-empty fields in missing", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })

    // Persist a partial party — name + city only, missing phone/street/postal/country.
    const setResp = await api(env.serverUrl, "/api/apps/boxtal/tools/settings_sender_address_set", {
      method: "POST",
      token,
      body: { params: { name: "Partial Co", city: "Lyon" } },
    })
    expect(setResp.status).toBe(200)
    const setData = unwrap(setResp.body)
    expect(setData.ok).toBe(true)
    const missing = setData.missing as string[]
    // The required structured fields that are still empty are surfaced (not name —
    // name was supplied — and not city — city was supplied).
    expect(missing).toEqual(
      expect.arrayContaining(["phone", "street", "postalCode", "countryIsoCode"]),
    )
    expect(missing).not.toContain("name")
    expect(missing).not.toContain("city")

    // get reports the same incomplete set.
    const after = await api(env.serverUrl, "/api/apps/boxtal/tools/settings_sender_address_get", {
      method: "POST",
      token,
      body: { params: {} },
    })
    const afterMissing = unwrap(after.body).missing as string[]
    expect(afterMissing.length).toBeGreaterThan(0)
    expect(afterMissing).toEqual(expect.arrayContaining(["phone", "street"]))
  })

  test("UI: filling the ship-from fields persists the party the tool reads back", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    // The old path redirects to the app's declarative settings page.
    await page.goto(`${viteUrl}/settings/boxtal`)
    await page.waitForLoadState("networkidle")
    await expect(page).toHaveURL(/\/settings\/apps\/boxtal/)

    // The ship-from section mounts.
    const section = page.getByTestId("settings-section-sender")
    await expect(section).toBeVisible({ timeout: 15_000 })

    // Fill the structured fields, then Save once: the address is one gated
    // whole-object setter, so the section saves as one unit (one approval at
    // most). Email is a required party field (address.ts): without it the
    // create path refuses.
    const fields: Array<[string, string]> = [
      ["name", "UI Sender Ltd"],
      ["phone", "+33611223344"],
      ["email", "ui-sender@e2e.test"],
      ["street", "9 Avenue des Champs"],
      ["postalCode", "75008"],
      ["city", "Paris"],
      ["countryIsoCode", "FR"],
    ]
    for (const [key, value] of fields) {
      const input = section.getByTestId(`settings-input-${key}`)
      await input.fill(value)
      await input.blur()
    }
    await section.getByTestId("settings-unit-save-sender").click()
    await expect(section.getByTestId("settings-unit-bar-sender")).toHaveCount(0, {
      timeout: 15_000,
    })
    await expect(section.getByTestId("settings-unit-error-sender")).toHaveCount(0)

    // The tool reads back exactly what the UI saved — proving the surface drives
    // the same app_config store the create path consumes.
    await expect
      .poll(
        async () => {
          const resp = await api(
            env.serverUrl,
            "/api/apps/boxtal/tools/settings_sender_address_get",
            { method: "POST", token, body: { params: {} } },
          )
          const sender = unwrap(resp.body).sender as Record<string, unknown> | null
          return sender
            ? `${sender.street ?? ""}|${sender.city ?? ""}|${sender.countryIsoCode ?? ""}`
            : null
        },
        { timeout: 15_000 },
      )
      .toBe("9 Avenue des Champs|Paris|FR")

    const resp = await api(env.serverUrl, "/api/apps/boxtal/tools/settings_sender_address_get", {
      method: "POST",
      token,
      body: { params: {} },
    })
    const data = unwrap(resp.body)
    const sender = data.sender as Record<string, unknown>
    expect(sender.name).toBe("UI Sender Ltd")
    expect(sender.phone).toBe("+33611223344")
    expect(sender.email).toBe("ui-sender@e2e.test")
    expect(sender.postalCode).toBe("75008")
    expect(sender.city).toBe("Paris")
    expect(sender.countryIsoCode).toBe("FR")
    expect(data.missing).toEqual([])
  })
})

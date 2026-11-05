// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ClientPlatform, createClientPolicy } from "~/lib/client-version"
import ClientVersionNotice from "~/modules/shell/ClientVersionNotice"

afterEach(cleanup)

const POLICY = { data: { desktop: "0.1.33", ios: "1.0.34", android: "0.1.0" } }

async function setup(
  client: { platform: ClientPlatform; version: string } | null,
  withCheck = true,
) {
  const policy = createRoot(() =>
    createClientPolicy({
      client: async () => client,
      fetchPolicy: async () => new Response(JSON.stringify(POLICY), { status: 200 }),
    }),
  )
  await policy.start()
  const check = vi.fn()
  render(() => <ClientVersionNotice policy={policy} checkForUpdates={withCheck ? check : null} />)
  return { check }
}

describe("the client version notice", () => {
  it("a desktop below its minimum: one notice whose action runs the update check", async () => {
    const { check } = await setup({ platform: "desktop", version: "0.1.30" })
    expect(screen.getByTestId("client-version-notice").textContent).toContain(
      "This server needs a newer version of Liaison.",
    )
    fireEvent.click(screen.getByTestId("client-version-check"))
    expect(check).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("client-version-store-hint")).toBeNull()
  })

  it("an iPhone below its minimum: points at the App Store", async () => {
    await setup({ platform: "ios", version: "1.0.20" }, false)
    expect(screen.getByTestId("client-version-store-hint").textContent).toBe(
      "Update Liaison from the App Store.",
    )
    expect(screen.queryByTestId("client-version-check")).toBeNull()
  })

  it("an Android phone below its minimum: points at Google Play", async () => {
    await setup({ platform: "android", version: "0.0.9" }, false)
    expect(screen.getByTestId("client-version-store-hint").textContent).toBe(
      "Update Liaison from Google Play.",
    )
  })

  it("at or above the minimum: nothing", async () => {
    await setup({ platform: "desktop", version: "0.1.33" })
    expect(screen.queryByTestId("client-version-notice")).toBeNull()
  })

  it("in a browser: nothing", async () => {
    await setup(null)
    expect(screen.queryByTestId("client-version-notice")).toBeNull()
  })

  it("'Not now' hides it", async () => {
    await setup({ platform: "desktop", version: "0.1.30" })
    fireEvent.click(screen.getByTestId("client-version-dismiss"))
    expect(screen.queryByTestId("client-version-notice")).toBeNull()
  })
})

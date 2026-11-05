// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  admin: true,
  list: [] as Array<{ id: string; kind: string; value: string }>,
  posts: [] as unknown[],
}))

vi.mock("~/modules/auth/auth-store", () => ({ hasScope: () => state.admin }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: async () => ({ data: state.list }),
    post: async (_p: string, body: { kind: string; value: string }) => {
      state.posts.push(body)
      return { data: { id: `t${state.posts.length}`, ...body } }
    },
    delete: async () => ({ data: { removed: true } }),
  }),
}))

// Flatten PopupMenu (no portal, no Kobalte focus handling) so items render inline in JSDOM.
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: any) => <>{props.children}</>
  const Trigger = (props: any) => <>{props.children}</>
  const Content = (props: any) => <div role="menu">{props.children}</div>
  const Item = (props: any) => (
    <div role="menuitem" data-testid={props["data-testid"]} onClick={() => props.onSelect?.()}>
      {props.children}
    </div>
  )
  return { PopupMenu: Object.assign(Root, { Trigger, Content, Item }) }
})

import { TrustedSenderControl } from "~/modules/contacts/TrustedSenderControl"
import { I18nProvider } from "~/modules/i18n/i18n-context"

function renderControl(email: string) {
  return render(() => (
    <I18nProvider>
      <TrustedSenderControl email={email} testId="ts" />
    </I18nProvider>
  ))
}

describe("TrustedSenderControl", () => {
  beforeEach(() => {
    state.admin = true
    state.list = []
    state.posts = []
  })
  afterEach(cleanup)

  it("lets an admin trust the address or its whole domain", async () => {
    renderControl("ann@partner.test")
    fireEvent.click(await screen.findByTestId("ts-trust"))
    expect(await screen.findByTestId("ts-trust-domain")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("ts-trust-address"))
    await waitFor(() =>
      expect(state.posts).toEqual([{ kind: "address", value: "ann@partner.test" }]),
    )
  })

  it("never offers a public provider's whole domain", async () => {
    renderControl("ann@gmail.com")
    fireEvent.click(await screen.findByTestId("ts-trust"))
    expect(await screen.findByTestId("ts-trust-address")).toBeInTheDocument()
    expect(screen.queryByTestId("ts-trust-domain")).toBeNull()
  })

  it("shows nothing to change for someone without the admin scope", async () => {
    state.admin = false
    renderControl("bo@other.test")
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("ts-trust")).toBeNull()
  })
})

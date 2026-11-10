// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { ContactShareDialog } from "./ContactShareDialog"

const INBOX = "11111111-1111-4111-8111-111111111111"

function makeApi(sharing: Record<string, unknown>) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/contacts/c1/sharing") return sharing
      if (path === "/sharing/members") {
        return [{ userId: "u-bob", name: "Bob Builder", email: "bob@corp.test" }]
      }
      if (path === "/sharing/roles") return []
      if (path === "/mail/accounts") {
        return [{ id: INBOX, emailAddress: "support@corp.test", displayName: null }]
      }
      throw new Error(`Unexpected GET ${path}`)
    }),
    put: vi.fn(async (_path: string, body: unknown) => body),
  }
}

function renderDialog(api: ReturnType<typeof makeApi>, onSaved = vi.fn()) {
  const onOpenChange = vi.fn()
  render(() => (
    <ApiContext.Provider value={api as never}>
      <ContactShareDialog
        contactId="c1"
        contactName="Jane Client"
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    </ApiContext.Provider>
  ))
  return { onOpenChange, onSaved }
}

describe("ContactShareDialog", () => {
  it("a private contact's owner adds it to the organisation: PUT orgAccess editor", async () => {
    const api = makeApi({
      orgAccess: "none",
      ownerUserId: "u-me",
      canManage: true,
      users: [],
      roles: [],
      dimensions: [],
    })
    const { onOpenChange, onSaved } = renderDialog(api)

    const priv = await screen.findByTestId("contact-share-access-none")
    expect(priv).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByTestId("contact-share-access-editor"))
    fireEvent.click(screen.getByTestId("contact-share-save"))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/contacts/c1/sharing", {
        orgAccess: "editor",
        users: [],
        roles: [],
        dimensions: [],
      }),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onSaved).toHaveBeenCalled()
  })

  it("names a shared mailbox's members and keeps the grant on save", async () => {
    const api = makeApi({
      orgAccess: "none",
      ownerUserId: null,
      canManage: true,
      users: [],
      roles: [],
      dimensions: [{ key: "mail:inbox", value: INBOX, role: "editor" }],
    })
    renderDialog(api)

    const row = await screen.findByTestId(`contact-share-dimension-mail:inbox=${INBOX}`)
    await waitFor(() => expect(row).toHaveTextContent("support@corp.test"))
    fireEvent.click(screen.getByTestId("contact-share-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/contacts/c1/sharing",
        expect.objectContaining({
          dimensions: [{ key: "mail:inbox", value: INBOX, role: "editor" }],
        }),
      ),
    )
  })

  it("is read-only for someone who is not the owner", async () => {
    const api = makeApi({
      orgAccess: "editor",
      ownerUserId: "u-someone-else",
      canManage: false,
      users: [],
      roles: [],
      dimensions: [],
    })
    renderDialog(api)

    expect(await screen.findByTestId("contact-share-read-only")).toBeInTheDocument()
    expect(screen.queryByTestId("contact-share-save")).toBeNull()
    expect(api.put).not.toHaveBeenCalled()
  })

  it("read-only means every control, not only Save: no add, no remove, no role or access change", async () => {
    const api = makeApi({
      orgAccess: "viewer",
      ownerUserId: "u-someone-else",
      canManage: false,
      users: [{ userId: "u-bob", role: "viewer" }],
      roles: [{ roleId: "r-sales", role: "viewer" }],
      dimensions: [{ key: "mail:inbox", value: INBOX, role: "editor" }],
    })
    renderDialog(api)

    await screen.findByTestId("contact-share-read-only")
    // Nothing to add with.
    expect(screen.queryByTestId("contact-share-add-person")).toBeNull()
    expect(screen.queryByTestId("contact-share-add-role")).toBeNull()
    // Nothing to remove with.
    expect(screen.queryAllByRole("button", { name: /^Remove/ })).toHaveLength(0)
    // Access levels shown, not changeable.
    expect(screen.getByTestId("contact-share-person-role-u-bob")).toBeDisabled()
    expect(screen.getByTestId("contact-share-role-role-r-sales")).toBeDisabled()
    for (const key of ["none", "viewer", "editor"]) {
      expect(screen.getByTestId(`contact-share-access-${key}`)).toBeDisabled()
    }
    fireEvent.click(screen.getByTestId("contact-share-access-editor"))
    expect(screen.getByTestId("contact-share-access-viewer")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.getByTestId("contact-share-access-editor")).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  })
})

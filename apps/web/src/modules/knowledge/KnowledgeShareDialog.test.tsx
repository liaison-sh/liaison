// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { ApiContext } from "~/modules/shell/ApiContext"
import KnowledgeShareDialog from "./KnowledgeShareDialog"

interface ApiStub {
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
}

function makeApi(
  overrides?: Partial<ApiStub>,
  sharingOverrides?: { orgAccess?: string; editScope?: string | null },
): ApiStub {
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/sharing")) {
        return {
          orgAccess: sharingOverrides?.orgAccess ?? "none",
          editScope: sharingOverrides?.editScope ?? null,
          shares: [{ userId: "u-viewer", role: "viewer" }],
          roleShares: [],
        }
      }
      if (path === "/knowledge/members") {
        return [
          { userId: "u-viewer", name: "Vera Viewer", email: "vera@example.com" },
          { userId: "u-new", name: "Nadia New", email: "nadia@example.com" },
        ]
      }
      if (path === "/knowledge/roles") {
        return []
      }
      throw new Error(`Unexpected GET ${path}`)
    }),
    put: vi.fn(async (_path: string, body: unknown) => body),
    ...overrides,
  }
}

function renderDialog(
  api: ApiStub,
  props?: { open?: boolean; onOpenChange?: (o: boolean) => void },
) {
  const onOpenChange = props?.onOpenChange ?? vi.fn()
  const utils = render(() => (
    <ApiContext.Provider value={api as never}>
      <KnowledgeShareDialog
        documentId="doc1"
        documentTitle="Runbook"
        open={props?.open ?? true}
        onOpenChange={onOpenChange}
      />
    </ApiContext.Provider>
  ))
  return { ...utils, onOpenChange }
}

describe("KnowledgeShareDialog", () => {
  it("renders current sharing state: orgAccess selected + viewer share listed", async () => {
    const api = makeApi()
    renderDialog(api)

    const restrictedOption = await screen.findByTestId("knowledge-share-access-none")
    expect(restrictedOption).toHaveAttribute("aria-pressed", "true")
    expect(await screen.findByTestId("knowledge-share-access-viewer")).toHaveAttribute(
      "aria-pressed",
      "false",
    )

    const person = await screen.findByTestId("knowledge-share-person-u-viewer")
    expect(person).toHaveTextContent("Vera Viewer")
    const roleSelect = screen.getByTestId(
      "knowledge-share-person-role-u-viewer",
    ) as HTMLSelectElement
    expect(roleSelect.value).toBe("viewer")
  })

  it("changing general access to editor and saving PUTs the new orgAccess + existing shares", async () => {
    const api = makeApi()
    const onOpenChange = vi.fn()
    renderDialog(api, { onOpenChange })

    await screen.findByTestId("knowledge-share-person-u-viewer")
    fireEvent.click(screen.getByTestId("knowledge-share-access-editor"))
    fireEvent.click(screen.getByTestId("knowledge-share-save"))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/knowledge/documents/doc1/sharing",
        expect.objectContaining({
          orgAccess: "editor",
          editScope: null,
          shares: [{ userId: "u-viewer", role: "viewer" }],
          roleShares: [],
        }),
      ),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("adding a person appends a viewer share, changing role updates it, removing deletes it", async () => {
    const api = makeApi()
    renderDialog(api)

    await screen.findByTestId("knowledge-share-person-u-viewer")

    // Add Nadia New from the members list.
    const addInput = screen.getByTestId("knowledge-share-add-person")
    fireEvent.focus(addInput)
    fireEvent.input(addInput, { target: { value: "Nadia" } })
    const option = await screen.findByTestId("knowledge-share-add-option-u-new")
    fireEvent.mouseDown(option)
    fireEvent.click(option)

    const newPerson = await screen.findByTestId("knowledge-share-person-u-new")
    expect(newPerson).toBeInTheDocument()
    const newRoleSelect = screen.getByTestId(
      "knowledge-share-person-role-u-new",
    ) as HTMLSelectElement
    expect(newRoleSelect.value).toBe("viewer")

    // Change role to editor.
    fireEvent.change(newRoleSelect, { target: { value: "editor" } })
    expect(newRoleSelect.value).toBe("editor")

    // Remove the original viewer share.
    fireEvent.click(screen.getByLabelText(/Remove Vera Viewer/i))
    expect(screen.queryByTestId("knowledge-share-person-u-viewer")).not.toBeInTheDocument()

    // Save and verify the resulting list.
    fireEvent.click(screen.getByTestId("knowledge-share-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/knowledge/documents/doc1/sharing",
        expect.objectContaining({
          orgAccess: "none",
          editScope: null,
          shares: [{ userId: "u-new", role: "editor" }],
          roleShares: [],
        }),
      ),
    )
  })

  it("shows a permission error on 404 and keeps the dialog open", async () => {
    const api = makeApi({
      put: vi.fn(async () => {
        throw new ApiError("Forbidden", 404, "NOT_FOUND")
      }),
    })
    const onOpenChange = vi.fn()
    renderDialog(api, { onOpenChange })

    await screen.findByTestId("knowledge-share-person-u-viewer")
    fireEvent.click(screen.getByTestId("knowledge-share-save"))

    expect(
      await screen.findByText(/You don't have permission to change sharing/i),
    ).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId("knowledge-share-dialog")).toBeInTheDocument()
  })

  it("loading a doc with orgAccess viewer + editScope clevel selects the C-Level option", async () => {
    const api = makeApi(undefined, { orgAccess: "viewer", editScope: "clevel" })
    renderDialog(api)

    const clevelOption = await screen.findByTestId("knowledge-share-access-clevel")
    expect(clevelOption).toHaveAttribute("aria-pressed", "true")
    expect(await screen.findByTestId("knowledge-share-access-viewer")).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    expect(await screen.findByTestId("knowledge-share-access-none")).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  })

  it("selecting the C-Level option and saving PUTs orgAccess viewer + editScope clevel", async () => {
    const api = makeApi()
    const onOpenChange = vi.fn()
    renderDialog(api, { onOpenChange })

    await screen.findByTestId("knowledge-share-person-u-viewer")
    fireEvent.click(screen.getByTestId("knowledge-share-access-clevel"))
    fireEvent.click(screen.getByTestId("knowledge-share-save"))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/knowledge/documents/doc1/sharing",
        expect.objectContaining({
          orgAccess: "viewer",
          editScope: "clevel",
          shares: [{ userId: "u-viewer", role: "viewer" }],
          roleShares: [],
        }),
      ),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("selecting Anyone can view (no scope) after loading a C-Level doc PUTs editScope null", async () => {
    const api = makeApi(undefined, { orgAccess: "viewer", editScope: "clevel" })
    const onOpenChange = vi.fn()
    renderDialog(api, { onOpenChange })

    await screen.findByTestId("knowledge-share-access-clevel")
    fireEvent.click(screen.getByTestId("knowledge-share-access-viewer"))
    fireEvent.click(screen.getByTestId("knowledge-share-save"))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/knowledge/documents/doc1/sharing",
        expect.objectContaining({
          orgAccess: "viewer",
          editScope: null,
          shares: [{ userId: "u-viewer", role: "viewer" }],
          roleShares: [],
        }),
      ),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T09 (S8 files): the Files changed drawer lists each file with its +/-
// counts and shows the diff of the file picked; cut and empty states.
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import FilesDrawer from "./FilesDrawer"
import type { FileChange } from "./files-changed"

const FILES: FileChange[] = [
  {
    path: "README.md",
    added: 1,
    removed: 0,
    hunks: [
      [
        { type: "same", text: "# Sample" },
        { type: "add", text: "One line" },
      ],
    ],
    cut: false,
  },
  {
    path: "src/a.ts",
    added: 2,
    removed: 1,
    hunks: [
      [
        { type: "del", text: "old" },
        { type: "add", text: "new" },
        { type: "add", text: "newer" },
      ],
    ],
    cut: true,
  },
]

describe("FilesDrawer", () => {
  it("the drawer lists files with counts and shows the diff of the picked file", () => {
    render(() => <FilesDrawer open files={FILES} onClose={() => {}} />)
    const drawer = screen.getByTestId("files-drawer")
    expect(drawer.textContent).toContain("Files changed · 2")
    const rows = screen.getAllByTestId("file-row")
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("README.md"),
      expect.stringContaining("src/a.ts"),
    ])
    expect(rows[1].textContent).toContain("+2")
    expect(rows[1].textContent).toContain("−1")
    expect(screen.getByTestId("file-diff").textContent).toContain("One line")
    fireEvent.click(rows[1])
    const diff = screen.getByTestId("file-diff")
    expect(diff.textContent).toContain("newer")
    expect(diff.querySelector(".text-error")?.textContent).toContain("old")
    expect(drawer.textContent).toContain("Part of this change was cut at 64 KB.")
  })

  it("empty and closed", () => {
    const onClose = vi.fn()
    const { unmount } = render(() => <FilesDrawer open files={[]} onClose={onClose} />)
    expect(screen.getByText("No file changed yet.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalled()
    unmount()
    render(() => <FilesDrawer open={false} files={FILES} onClose={onClose} />)
    expect(screen.queryByTestId("files-drawer")).toBeNull()
  })
})

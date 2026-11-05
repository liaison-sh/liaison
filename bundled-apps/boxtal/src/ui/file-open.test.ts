// SPDX-License-Identifier: FSL-1.1-ALv2
//
// loadFileInto under the two hosts it runs in. In a browser the fetched PDF goes to the pre-opened
// tab as a blob URL. Under the desktop shell that tab never shows anything (the webview opens no
// tab, the shell refuses `blob:`), so the label button did nothing: there the host must be handed
// the bytes and a file name to open in the system viewer, and no blob tab is attempted.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { loadFileInto } from "./file-open"

type FakeWin = { location: { href: string }; close: ReturnType<typeof mock> }

const g = globalThis as Record<string, unknown>
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
let createObjectURL: ReturnType<typeof mock>

function fakeWin(): FakeWin {
  return { location: { href: "about:blank" }, close: mock(() => {}) }
}

beforeEach(() => {
  createObjectURL = mock(() => "blob:http://tauri.localhost/1")
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
})

afterEach(() => {
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
  delete g.__liaisonHost
})

describe("loadFileInto", () => {
  it("on desktop hands the PDF to the host to open, closes the tab and makes no blob URL", async () => {
    const openFile = mock(async (_file: Blob, _name: string) => true)
    g.__liaisonHost = {
      fetchBlob: async () => new Blob(["%PDF-1.7"], { type: "application/octet-stream" }),
      openFile,
    }
    const win = fakeWin()
    await loadFileInto("0123456789abcdef", win as unknown as Window, "label")
    expect(openFile).toHaveBeenCalledTimes(1)
    const [file, name] = openFile.mock.calls[0] as [Blob, string]
    expect(name).toBe("label-01234567.pdf")
    expect(file.type).toBe("application/pdf")
    expect(await file.text()).toBe("%PDF-1.7")
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(win.location.href).toBe("about:blank")
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it("on desktop a shell that could not open the file is an error, not a silent no-op", async () => {
    g.__liaisonHost = {
      fetchBlob: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      openFile: async () => {
        throw new Error("the desktop app could not open label-01234567.pdf")
      },
    }
    const win = fakeWin()
    await expect(loadFileInto("0123456789abcdef", win as unknown as Window, "label")).rejects.toThrow(
      /could not open/,
    )
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it("in a browser loads the blob URL into the pre-opened tab, as before", async () => {
    const openFile = mock(async () => false)
    g.__liaisonHost = {
      fetchBlob: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      openFile,
    }
    const win = fakeWin()
    await loadFileInto("0123456789abcdef", win as unknown as Window, "label")
    expect(win.location.href).toBe("blob:http://tauri.localhost/1")
    expect(win.close).not.toHaveBeenCalled()
  })

  it("with a host that predates openFile still loads the blob URL into the tab", async () => {
    g.__liaisonHost = { fetchBlob: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }) }
    const win = fakeWin()
    await loadFileInto("0123456789abcdef", win as unknown as Window)
    expect(win.location.href).toBe("blob:http://tauri.localhost/1")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who can see an agreement, from its editor: a share with someone who cannot open the app is
// saved, and the editor says so in the server's words instead of saying nothing.
import { afterEach, describe, expect, it } from "bun:test"
import { saveAccess } from "./Editor"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

function host(answer: unknown) {
  const asked: Array<[string, Record<string, unknown>]> = []
  ;(globalThis as any).__liaisonHost = {
    invokeTool: async (_app: string, tool: string, args: Record<string, unknown>) => {
      asked.push([tool, args])
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = "agreements"
  return asked
}

describe("the editor's access list", () => {
  it("sharing an agreement with someone who cannot open the app shows the notice in the editor", async () => {
    const notice =
      "Lena is on the list but cannot open it yet: no access to agreements. The share is saved; until an admin gives them that access (Settings, roles), they do not see it."
    const asked = host({ id: "a1", access_notice: notice })
    const shares = [{ user_id: "u1", role: "editor" }]
    expect(await saveAccess("a1", "none", shares)).toEqual({ text: notice, error: false })
    expect(asked).toEqual([["agreement_update", { id: "a1", org_access: "none", shares }]])
  })

  it("a share everyone on it can open says nothing, and a refusal says what happened", async () => {
    host({ id: "a1" })
    expect(await saveAccess("a1", "editor", [])).toBeNull()
    host({
      status: "error",
      error: { code: "forbidden", message: "Only its owner changes who sees it." },
    })
    expect(await saveAccess("a1", "none", [])).toEqual({
      text: "Only its owner changes who sees it.",
      error: true,
    })
  })
})

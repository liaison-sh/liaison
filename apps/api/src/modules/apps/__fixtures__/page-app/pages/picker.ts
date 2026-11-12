// SPDX-License-Identifier: FSL-1.1-ALv2
// The `pagefx` picker page: shows which account's token it received
// (`liaisonPage.connectionToken`), as a provider widget would use it.
const page = globalThis as unknown as {
  document: { getElementById(id: string): { textContent: string | null } | null }
  liaisonPage: { connectionToken?: { identifier: string } }
}
const root = page.document.getElementById("root")
if (root) root.textContent = page.liaisonPage.connectionToken?.identifier ?? "no account"

export {}

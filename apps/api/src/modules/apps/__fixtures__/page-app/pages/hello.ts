// SPDX-License-Identifier: FSL-1.1-ALv2
// The `pagefx` hello page: a button that calls the page's `greet` route.
// (The api's tsconfig has no DOM lib: the browser globals are typed locally.)

interface El {
  textContent: string | null
  append(child: El): void
  addEventListener(type: string, fn: () => void): void
}
const page = globalThis as unknown as {
  document: { getElementById(id: string): El | null; createElement(tag: string): El }
  liaisonPage: {
    params: Record<string, unknown>
    call(route: string, body?: unknown): Promise<unknown>
  }
}

const root = page.document.getElementById("root")
const button = page.document.createElement("button")
button.textContent = "Greet"
button.addEventListener("click", async () => {
  const answer = (await page.liaisonPage.call("greet", { name: "page" })) as { greeting: string }
  if (root) root.textContent = answer.greeting
})
root?.append(button)

export {}

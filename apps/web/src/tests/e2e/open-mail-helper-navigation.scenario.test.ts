// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression for the mail helper `openMail` (helpers/mailbox-seed.ts), which
// the mailbox encryption scenarios open the mail surface with.
//
// The shell `loginAs` leaves open reads the keyring at startup. When that read
// has its response headers but not its body as `openMail` navigates away, a
// keyring waiter registered BEFORE the navigation matched it, and Playwright's
// `response.text()` on a response whose document is gone never settles. The
// helper then hung with the landing prompt open until the test timed out
// (CI only: a slow runner widens the window between headers and body).
//
// This forces that ordering deterministically with a local server: it holds
// the shell's keyring read with no answer; when the helper's navigation asks
// for the next document, it sends that read's headers and half its body (never
// the rest), and answers the navigation only half a second later, so the read
// has its response while its document is torn down.
// No product stack: the "app" is the smallest page with the selectors the
// helper drives.

import http from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import { openMailAt } from "./helpers/mailbox-seed"

const BOOT_PAGE = `<!doctype html><title>shell</title>
<script>fetch("/api/mailbox-keys/me")</script><main>shell</main>`

const APP_PAGE = `<!doctype html><title>app</title>
<button type="button" id="mail">Mail</button>
<div id="root"></div>
<script>
document.getElementById("mail").addEventListener("click", async () => {
  const inbox = document.createElement("div")
  inbox.dataset.testid = "mail-inbox"
  inbox.textContent = "inbox"
  document.getElementById("root").append(inbox)
  const keyring = await (await fetch("/api/mailbox-keys/me")).json()
  if (keyring.data.identities.some((row) => row.status === "active")) {
    const host = document.createElement("div")
    host.dataset.testid = "mailbox-unlock-host"
    const dismiss = document.createElement("button")
    dismiss.type = "button"
    dismiss.dataset.testid = "mailbox-unlock-host.dismiss"
    dismiss.textContent = "Not now"
    dismiss.addEventListener("click", () => host.remove())
    host.append(dismiss)
    document.body.append(host)
  }
})
</script>`

test("openMail does not hang on the previous document's unfinished keyring read", async ({
  page,
}) => {
  test.setTimeout(60_000)
  let keyringReads = 0
  const stalled: http.ServerResponse[] = []
  const server = http.createServer((req, res) => {
    if (req.url === "/api/mailbox-keys/me") {
      keyringReads += 1
      // The shell's read: held, no headers yet.
      if (keyringReads === 1) {
        stalled.push(res)
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: { identities: [{ status: "active" }], wraps: [] } }))
      return
    }
    if (req.url === "/app") {
      // The helper navigates: the shell's read now gets its headers and half a
      // body, never the rest, and the next document arrives after it.
      for (const held of stalled) {
        held.writeHead(200, { "content-type": "application/json" })
        held.write('{"data":{"identities":[{"status":')
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" })
        res.end(APP_PAGE)
      }, 500)
      return
    }
    res.writeHead(200, { "content-type": "text/html" })
    res.end(BOOT_PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const firstRead = page.waitForRequest((r) => r.url().endsWith("/api/mailbox-keys/me"))
    await page.goto(`${root}/boot`)
    await firstRead
    await expect.poll(() => stalled.length, { message: "the shell's keyring read is held" }).toBe(1)

    // Bounded well under the test timeout: a helper that matches the stalled
    // read never returns at all.
    const outcome = await Promise.race([
      openMailAt(page, `${root}/app`).then(() => "returned" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 30_000)),
    ])
    expect(outcome, "openMail waited on a response from a document it navigated away").toBe(
      "returned",
    )
    // It read the CURRENT document's keyring and answered its landing prompt.
    expect(keyringReads).toBe(2)
    await expect(page.getByTestId("mailbox-unlock-host")).toHaveCount(0)
  } finally {
    for (const res of stalled) res.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

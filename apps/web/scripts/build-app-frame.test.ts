// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mobile shell's frame document (app-frame.html in the native build): the
// same runtime the desktop shell serves, under the same policy, written as a
// file because the phone serves its page from local files.

import { appFrameDocument, appFramePolicy } from "@liaison/shared"
import { describe, expect, it } from "vitest"

const directive = (policy: string, name: string) =>
  policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `))

describe("the mobile frame document", () => {
  it("runs only its nonced runtime and the blobs it makes, and reaches no network", () => {
    const policy = appFramePolicy("n0nce")
    expect(directive(policy, "default-src")).toBe("default-src 'none'")
    expect(directive(policy, "script-src")).toBe("script-src 'nonce-n0nce' blob:")
    expect(directive(policy, "connect-src")).toBe("connect-src 'none'")
    expect(directive(policy, "img-src")).toBe("img-src data: blob:")
    expect(directive(policy, "frame-src")).toBe("frame-src 'none'")
    expect(directive(policy, "form-action")).toBe("form-action 'none'")
    expect(policy).not.toContain("'self'")
    expect(policy).not.toContain("unsafe-eval")
  })

  it("puts the policy before the runtime, which cannot close its own script element", () => {
    const html = appFrameDocument("a('</script><script>b()')", "n0nce")
    const meta = html.indexOf('http-equiv="Content-Security-Policy"')
    const script = html.indexOf('<script nonce="n0nce">')
    expect(meta).toBeGreaterThan(-1)
    expect(script).toBeGreaterThan(meta)
    expect(html).not.toContain("a('</script>")
    expect(html).toContain('<meta name="referrer" content="no-referrer" />')
    expect(html).toContain('<div id="app"></div>')
  })

  it("matches the desktop shell's frame policy", async () => {
    const { readFileSync } = await import("node:fs")
    const path = await import("node:path")
    // Run from apps/web, as every web unit test is.
    const rust = readFileSync(
      path.resolve(process.cwd(), "../desktop/src-tauri/src/app_frame.rs"),
      "utf8",
    )
    for (const d of appFramePolicy("x").split("; ")) {
      // The nonce is per response there; frame-ancestors is a header only.
      if (d.startsWith("script-src")) continue
      expect(rust).toContain(`"${d}"`)
    }
  })
})

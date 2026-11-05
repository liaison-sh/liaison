// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The chat list's last line is plain text: a mention reads `@Name`, not its
// `@[Name](user:<id>)` markup.
import { describe, expect, it } from "vitest"
import { previewLine } from "~/modules/threads/system-line"

const t = ((key: string) => key) as Parameters<typeof previewLine>[1]

describe("previewLine", () => {
  it("renders the message markup as plain text", () => {
    expect(
      previewLine(
        "@[Recipient](user:11111111-1111-4111-8111-111111111111) see **this** [doc](https://x.test) `npm ci`",
        t,
      ),
    ).toBe("@Recipient see this doc npm ci")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gmail Primary / Other (S13, A40). Primary = CATEGORY_PERSONAL, or no
// CATEGORY_* label at all; Other = categorized without CATEGORY_PERSONAL. The
// switch exists only where the mailbox is Gmail, Primary by default, and the
// choice is remembered per account.

import { beforeEach, describe, expect, it } from "vitest"
import {
  mailCategoryFor,
  mailCategoryScope,
  matchesMailCategory,
  setMailCategory,
} from "~/modules/mail/mail-category"

const gmailShared = { id: "acc-gmail", provider: "gmail", ownerType: "org" as const }
const imapShared = { id: "acc-imap", provider: "imap", ownerType: "org" as const }
const gmailMine = { id: "acc-mine", provider: "gmail", ownerType: "user" as const }
const imapMine = { id: "acc-mine-imap", provider: "imap", ownerType: "user" as const }

beforeEach(() => localStorage.clear())

describe("mail category", () => {
  it("primary keeps 3 of the four Gmail shapes, other 1, all 4", () => {
    const shapes = [
      ["INBOX", "CATEGORY_PERSONAL"],
      ["INBOX", "CATEGORY_PROMOTIONS"],
      ["INBOX"],
      ["INBOX", "CATEGORY_UPDATES", "CATEGORY_PERSONAL"],
    ]
    expect(shapes.filter((l) => matchesMailCategory(l, "primary"))).toHaveLength(3)
    expect(shapes.filter((l) => matchesMailCategory(l, "other"))).toEqual([
      ["INBOX", "CATEGORY_PROMOTIONS"],
    ])
    expect(shapes.filter((l) => matchesMailCategory(l, "all"))).toHaveLength(4)
    expect(shapes.filter((l) => matchesMailCategory(l, undefined))).toHaveLength(4)
  })

  it("has a scope only where the mailbox is Gmail", () => {
    const accounts = [gmailShared, imapShared, gmailMine]
    expect(mailCategoryScope("inbox:acc-gmail", accounts)).toBe("acc-gmail")
    expect(mailCategoryScope("inbox:acc-imap", accounts)).toBeNull()
    expect(mailCategoryScope("inbox:personal", accounts)).toBe("personal")
    expect(mailCategoryScope("inbox:personal", [imapMine, gmailShared])).toBeNull()
    // The all-mailboxes view mixes accounts: no switch there.
    expect(mailCategoryScope("inbox", accounts)).toBeNull()
    expect(mailCategoryScope("starred", accounts)).toBeNull()
  })

  it("defaults to primary on personal Gmail, remembers the choice per account", () => {
    const accounts = [gmailShared, gmailMine]
    expect(mailCategoryFor("personal", accounts)).toBe("primary")
    expect(mailCategoryFor("acc-mine", accounts)).toBe("primary")
    setMailCategory("acc-mine", "other")
    expect(mailCategoryFor("acc-mine", accounts)).toBe("other")
    expect(mailCategoryFor(null, accounts)).toBeUndefined()
  })

  it("A45: a shared Gmail mailbox defaults to All, and its switch can still choose", () => {
    const accounts = [gmailShared, gmailMine]
    expect(mailCategoryFor("acc-gmail", accounts)).toBe("all")
    setMailCategory("acc-gmail", "primary")
    expect(mailCategoryFor("acc-gmail", accounts)).toBe("primary")
    setMailCategory("acc-gmail", "all")
    expect(mailCategoryFor("acc-gmail", accounts)).toBe("all")
  })
})

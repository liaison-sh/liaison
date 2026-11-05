// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gmail's Primary / Other split in the inbox (S13, A40). Primary = carries
// CATEGORY_PERSONAL or no CATEGORY_* label; Other = categorized without
// CATEGORY_PERSONAL. Mirrors the server predicate (api modules/mail/category).
//
// The switch exists only where the mailbox is Gmail: one Gmail account's view,
// or the Personal view when one of the user's own mailboxes is Gmail. The
// all-mailboxes view mixes accounts and stays whole. Primary by default on a
// personal Gmail mailbox; All by default on a shared one (A45: a support team
// must not miss customer mail Gmail files under Updates). The choice is
// remembered per account in this browser (a convenience, not state another
// device needs).

import { createSignal } from "solid-js"

export type MailCategory = "primary" | "other" | "all"

interface CategoryAccount {
  id: string
  provider?: string | null
  ownerType?: "user" | "org"
}

const STORAGE_PREFIX = "liaison.mail.category."

// Bumped on every change so views that read the choice re-run.
const [categoryVersion, setCategoryVersion] = createSignal(0)
// Where the choice lives when browser storage is blocked: this page only.
const unstored = new Map<string, MailCategory>()

export function matchesMailCategory(
  labels: readonly string[] | null | undefined,
  category: MailCategory | undefined,
): boolean {
  if (!category || category === "all") return true
  const list = labels ?? []
  const personal = list.includes("CATEGORY_PERSONAL")
  const categorized = list.some((label) => label.startsWith("CATEGORY_"))
  return category === "primary" ? personal || !categorized : !personal && categorized
}

/** The key the choice is remembered under, or null where there is no switch. */
export function mailCategoryScope(
  view: string,
  accounts: readonly CategoryAccount[],
): string | null {
  if (view === "inbox:personal") {
    return accounts.some((a) => a.ownerType === "user" && a.provider === "gmail")
      ? "personal"
      : null
  }
  if (!view.startsWith("inbox:")) return null
  const accountId = view.slice("inbox:".length)
  const account = accounts.find((a) => a.id === accountId)
  return account?.provider === "gmail" ? accountId : null
}

function isCategory(value: unknown): value is MailCategory {
  return value === "primary" || value === "other" || value === "all"
}

/** Primary on a personal Gmail mailbox, All on a shared one (A45). */
function defaultCategory(scope: string, accounts: readonly CategoryAccount[]): MailCategory {
  if (scope === "personal") return "primary"
  return accounts.find((a) => a.id === scope)?.ownerType === "user" ? "primary" : "all"
}

/** The remembered choice for a scope, else its default; undefined without a scope. */
export function mailCategoryFor(
  scope: string | null,
  accounts: readonly CategoryAccount[],
): MailCategory | undefined {
  categoryVersion()
  if (!scope) return undefined
  let stored: unknown
  try {
    stored = localStorage.getItem(STORAGE_PREFIX + scope)
  } catch {
    stored = unstored.get(scope)
  }
  return isCategory(stored) ? stored : defaultCategory(scope, accounts)
}

export function setMailCategory(scope: string, category: MailCategory): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + scope, category)
  } catch {
    unstored.set(scope, category)
  }
  setCategoryVersion((v) => v + 1)
}

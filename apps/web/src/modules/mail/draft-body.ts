// SPDX-License-Identifier: FSL-1.1-ALv2
import { htmlToText, markdownToEmail } from "@liaison/shared"
import type { Draft } from "~/modules/mail/mail-draft-store"

/**
 * The markdown a draft opens with. A draft written in the shared editor keeps
 * its markdown in textBody. One the earlier mail editor saved holds HTML, with
 * at most that HTML's plain text beside it: it opens from the HTML, formatting
 * included, never empty. A plain body written in the shared editor reads as
 * the same plain text, so a draft whose HTML is its text's email is its own.
 */
export async function draftMarkdown(draft: Pick<Draft, "htmlBody" | "textBody">): Promise<string> {
  const html = draft.htmlBody ?? ""
  const text = draft.textBody ?? ""
  if (!html.trim() || (text && text !== htmlToText(html))) return text
  if (markdownToEmail(text).html === html) return text
  const { htmlToMarkdown } = await import("~/modules/editor/html-markdown")
  return htmlToMarkdown(html)
}

/**
 * Opens a draft in a composer: its text at once, then, for a draft the
 * earlier mail editor saved, the markdown read from its HTML, never over what
 * was typed meanwhile.
 */
export async function openDraftBody(
  draft: Draft,
  composer: { draftId: () => string | null; body: () => string; setBody: (body: string) => void },
): Promise<void> {
  composer.setBody(draft.textBody)
  const markdown = await draftMarkdown(draft)
  if (composer.draftId() === draft.id && composer.body() === draft.textBody) {
    composer.setBody(markdown)
  }
}

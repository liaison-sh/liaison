// SPDX-License-Identifier: FSL-1.1-ALv2
// Mail app exports — resolved by bootstrap trusted registry
// Components and WS handlers referenced in the mail app manifest
import { lazy } from "solid-js"
import { registerAppPhoneHeader, registerAppPhoneTopBarHidden } from "~/framework/define-app"
import { MailIcon } from "~/modules/mail/MailIcon"
import { handleAccountEvent } from "~/modules/mail/mail-account-store"
import { handleConversationEvent } from "~/modules/mail/mail-conversation-store"
import { mailConversationTabLabel } from "~/modules/mail/mail-conversation-tab-label"
import { handleMessageEvent } from "~/modules/mail/mail-message-store"

// Lazy components for code splitting
export const MailInbox = lazy(() =>
  import("~/modules/mail/MailInbox").then((m) => ({ default: m.MailInbox })),
)
export const MailConversation = lazy(() =>
  import("~/modules/mail/MailConversation").then((m) => ({ default: m.MailConversation })),
)
export const MailCompose = lazy(() =>
  import("~/modules/mail/MailCompose").then((m) => ({ default: m.MailCompose })),
)
export const MailSidebar = lazy(() =>
  import("~/modules/mail/MailSidebar").then((m) => ({ default: m.MailSidebar })),
)
// Custom blocks of the Mail settings page (manifest `settings`).
export const MailAccounts = lazy(() =>
  import("~/modules/mail/MailAccounts").then((m) => ({ default: m.MailAccounts })),
)
export const GoogleClientCard = lazy(() =>
  import("~/modules/settings/GoogleClientCard").then((m) => ({ default: m.GoogleClientCard })),
)
// The live frames that change the Mail settings page's values: the Gmail
// switch (and the Google client) set from a chat, a card or another tab
// (AppSettingsPage `settingsChangeEvents`).
export const settingsChangeEvents = ["mail:provider"]
// K4 — the phone top bar's registered header for the mail conversation tab
// type (see registerAppHooks below and MailConversationPhoneHeader's own
// comment).
const MailConversationPhoneHeader = lazy(() => import("~/modules/mail/MailConversationPhoneHeader"))

export { registerEntityPreviews } from "./entity-preview-renderers"

/**
 * S10: the conversation tab's title is the email's subject, whichever opener
 * labelled it first (a Home card, a notification, a mention). "Conversation"
 * while a sealed mailbox is locked; undefined until the conversation loads.
 */
export function resolveMailConversationLabel(entityId: string): string | undefined {
  return mailConversationTabLabel(entityId)
}
// Re-export icon and WS handlers (resolved by registerAppFromManifest)
export { handleAccountEvent, handleConversationEvent, handleMessageEvent, MailIcon }

/**
 * Register the mail-app UI hooks the phone top bar needs. Called from
 * `loadManifestApps()` after the manifest registration so the hooks see a
 * registered app.
 *
 * K4: the conversation detail gets a custom phone header (back / subject /
 * "..."), matching the exact tickets convention (`registerAppHooks` in
 * `tickets/exports.ts`); the inbox tab owns its own large title (the folder
 * name MailInbox already renders at phone tier, tapping it reopens the
 * navigator), so it hides the shared bar entirely instead.
 */
export function registerAppHooks(): void {
  registerAppPhoneHeader("mail", "conversation", MailConversationPhoneHeader)
  registerAppPhoneTopBarHidden("mail", "inbox")
}

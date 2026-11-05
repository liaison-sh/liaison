// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wording that is fixed by the spec rather than by taste.
//
// The approved claim is quoted VERBATIM from spec section 1 (its English is the
// catalog's kernel.mailboxEncryption.copy.approvedClaim). The forbidden list
// is also from section 1: each phrase is a promise this design cannot keep, and
// a settings page that made one would be falsified by the product's own
// behaviour. The words live in the kernel catalog, in every shipped language;
// this file names which key says what, so the tests can assert them and a
// future copy edit has to go through here.
//
// Each accessor takes the translator of the screen that renders it (so the text
// follows a language switch) and defaults to the active locale.
//
// House rule, enforced by a test: no dash punctuation anywhere in these strings.

import { type Translate, tNow } from "~/modules/i18n/i18n-context"
import type { DowngradeFindingKind } from "~/modules/mailbox/downgrade-detector"

export function approvedZeroAccessClaim(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.approvedClaim")
}

/** Before enrollment the claim would be false (nothing is stored, no key exists yet):
 *  this says what WILL be true once the mailbox password is chosen. */
export function pendingSetupClaim(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.pendingSetupClaim")
}

export const FORBIDDEN_MAILBOX_PHRASES = [
  "end-to-end encrypted email",
  "we cannot see your email",
  "tamper proof",
  "tamper-proof",
  "verified sender",
] as const

/** Spec section 2.2, in the user's own words rather than column names. */
export function metadataStillVisible(t: Translate = tNow): string[] {
  return [
    t("kernel.mailboxEncryption.copy.metadata.exists"),
    t("kernel.mailboxEncryption.copy.metadata.correspondents"),
    t("kernel.mailboxEncryption.copy.metadata.arrivalTimes"),
    t("kernel.mailboxEncryption.copy.metadata.frequency"),
    t("kernel.mailboxEncryption.copy.metadata.threadShape"),
    t("kernel.mailboxEncryption.copy.metadata.size"),
    t("kernel.mailboxEncryption.copy.metadata.attachmentNames"),
    t("kernel.mailboxEncryption.copy.metadata.auditEvents"),
  ]
}

/**
 * The agent residual (spec section 15 A13, plan task 6.6). It is a consented,
 * bounded exposure and the page says so plainly: the assistant's answer is
 * stored in a conversation the user can see, so what it wrote about the mail
 * stays there.
 */
export function agentResidualCopy(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.agentResidual")
}

/**
 * Rotation is never remediation (spec section 15 A15). Retired private keys
 * stay in the keyring so old mail keeps opening, which is exactly why rotating
 * buys no forward secrecy.
 */
export function rotationNote(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.rotationNote")
}

/** Spec section 3.2 and section 9.7, shown only when a mailbox password wrap exists. */
export function passphraseCaveat(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.passphraseCaveat")
}

/**
 * What the mailbox password is, said once at enrollment and again wherever it
 * is asked for. It is distinct from the login password on purpose: Liaison
 * checks the login password, so it must never be able to open the mailbox.
 */
export function mailboxPasswordExplainer(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.passwordExplainer")
}

/**
 * How an unlock method is named to the user. A legacy recovery phrase row maps
 * to null: nothing offers it any more, so no screen lists it.
 */
export function wrapLabel(type: string, t: Translate = tNow): string | null {
  if (type === "passphrase") return t("kernel.mailboxEncryption.copy.wrapPassword")
  if (type === "passkey_prf") return t("kernel.mailboxEncryption.copy.wrapPasskey")
  return null
}

/** The passkey is a per computer shortcut, never the only way in. */
export function passkeyShortcutCopy(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.passkeyShortcut")
}

/**
 * The reset confirmation. It names exactly what is lost, because the loss is
 * real: mail comes back from Gmail, but drafts written in Liaison and emails
 * waiting for approval exist nowhere else.
 */
export function mailboxResetConsequences(t: Translate = tNow): string[] {
  return [
    t("kernel.mailboxEncryption.copy.resetConsequences.mailRedownloads"),
    t("kernel.mailboxEncryption.copy.resetConsequences.draftsDeleted"),
    t("kernel.mailboxEncryption.copy.resetConsequences.newPassword"),
  ]
}

/**
 * The downgrade alarm (spec section 9.2, blueprint task 13.1). It says what was
 * found, that it cannot be cleared from the outside, and, per section 15 A15,
 * that adding a new key is not the repair. It must not imply the client can
 * detect an injected message: it cannot (section 9.6).
 */
export function downgradeAlarmHeading(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.downgrade.heading")
}

export function downgradeAlarmIntro(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.downgrade.intro")
}

/** The catalog key that says what each finding kind means. */
export const DOWNGRADE_ALARM_KIND_KEYS: Record<DowngradeFindingKind, string> = {
  "unsealed-row": "kernel.mailboxEncryption.downgrade.kinds.unsealedRow",
  "unopenable-seal": "kernel.mailboxEncryption.downgrade.kinds.unopenableSeal",
  "unattested-identity": "kernel.mailboxEncryption.downgrade.kinds.unattestedIdentity",
  "ledger-ciphertext-changed": "kernel.mailboxEncryption.downgrade.kinds.ledgerCiphertextChanged",
  "ledger-row-missing": "kernel.mailboxEncryption.downgrade.kinds.ledgerRowMissing",
  "ledger-chain-broken": "kernel.mailboxEncryption.downgrade.kinds.ledgerChainBroken",
}

export function downgradeAlarmKindCopy(kind: DowngradeFindingKind, t: Translate = tNow): string {
  return t(DOWNGRADE_ALARM_KIND_KEYS[kind])
}

/**
 * A15 in one sentence the user can act on, plus the honest bound from 9.6: the
 * check sees changes to mail this browser already saw, and it cannot tell you
 * that a message was added or that one you never saw was held back.
 */
export function downgradeAlarmFooter(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.downgrade.footer")
}

export function downgradeAlarmLimitNote(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.downgrade.limitNote")
}

/** Spec section 9.1, stated rather than glossed over. */
export function operatorJavascriptLimitation(t: Translate = tNow): string {
  return t("kernel.mailboxEncryption.copy.operatorLimit")
}

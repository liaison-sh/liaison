// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The check a NEW mailbox password passes before the Account Key is wrapped
// under it.
//
// Why there is a floor: the server holds the passphrase wrap, so someone
// holding a copy of the database (or briefly holding a session) can try
// passwords offline, with no rate limit. PBKDF2-HMAC-SHA256 at 600 000
// iterations makes each guess expensive, but it does not save a password a
// person would guess in the first few thousand tries. The floor is therefore a
// length minimum plus a refusal of the commonest passwords and of trivially
// patterned ones. It is an input check on a NEW password only, enforced here,
// in the browser, because the password never leaves it; it changes nothing
// about how the wrap is derived, and an existing password still unlocks.
//
// Nothing here talks to the network: no password, and no hash of one, is ever
// sent to a "breached passwords" service.

import { tNow } from "~/modules/i18n/i18n-context"

export const PASSPHRASE_MIN_LENGTH = 12

export interface PassphraseVerdict {
  ok: boolean
  reasons: string[]
}

// The most used passwords of the published breach corpora that are at least
// twelve characters long once padded the usual ways, plus the staples. Compared
// after lowercasing and dropping everything that is not a letter or digit, so
// "Password-1234!" and "password1234" are the same entry.
const COMMON = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "password12345",
  "password123456",
  "passw0rd",
  "passw0rd1234",
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "qwertyuiopas",
  "qwertyuiopasdf",
  "qwertyuiop123",
  "qwerty123456",
  "qwertyazerty",
  "azertyuiop",
  "azertyuiopqs",
  "azerty123456",
  "iloveyou1234",
  "iloveyouforever",
  "letmein12345",
  "letmeinletmein",
  "welcome12345",
  "welcome1234567",
  "administrator",
  "administrator1",
  "admin1234567",
  "adminadmin123",
  "changeme1234",
  "changemechangeme",
  "monkey123456",
  "dragon123456",
  "football1234",
  "baseball1234",
  "superman1234",
  "trustno11234",
  "sunshine1234",
  "princess1234",
  "mailboxpassword",
  "mymailboxpassword",
  "mailbox123456",
  "liaison123456",
  "liaisonpassword",
  "motdepasse123",
  "motdepasse1234",
  "motdepasse12345",
  "bonjour123456",
  "aaaaaaaaaaaa",
  "abcdefghijkl",
  "abcdefghijklmnop",
  "abc123abc123",
])

function canonical(passphrase: string): string {
  return passphrase
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
}

function isPatterned(value: string): boolean {
  const chars = [...value]
  if (new Set(chars).size < 5) return true
  // One short unit repeated to fill the password ("abcabcabcabc", "1212121212").
  for (let unit = 1; unit <= 4; unit++) {
    if (chars.length >= unit * 3 && chars.every((c, i) => c === chars[i % unit])) return true
  }
  // A straight run on the keyboard row or the alphabet/digits.
  const runs = [
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    "qwertyuiopasdfghjklzxcvbnm",
    "azertyuiopqsdfghjklmwxcvbn",
  ]
  const lowered = value.toLowerCase()
  return runs.some((run) => run.includes(lowered) || [...run].reverse().join("").includes(lowered))
}

export async function checkPassphrase(passphrase: string): Promise<PassphraseVerdict> {
  if (passphrase.length === 0) {
    return { ok: false, reasons: [tNow("kernel.mailboxEncryption.enrollment.emptyPassword")] }
  }
  if ([...passphrase.normalize("NFKC")].length < PASSPHRASE_MIN_LENGTH) {
    return { ok: false, reasons: [tNow("kernel.mailboxEncryption.enrollment.passwordTooShort")] }
  }
  const canon = canonical(passphrase)
  if (COMMON.has(canon) || isPatterned(canon)) {
    return { ok: false, reasons: [tNow("kernel.mailboxEncryption.enrollment.passwordTooCommon")] }
  }
  return { ok: true, reasons: [] }
}

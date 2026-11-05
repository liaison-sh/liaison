// SPDX-License-Identifier: FSL-1.1-ALv2
// Attributes that keep a browser's (and a password manager's) login autofill
// out of a credential input: an OAuth client id or secret, an API token. A
// saved login email once landed in an OAuth client id field. Chrome ignores
// `autocomplete="off"` on a form it takes for a login, so the input also gets
// a specific name with no user/email/login token, a secret is a NEW password
// (never a saved one), and the 1Password and LastPass opt-outs are set.

export interface NoAutofillAttributes {
  name: string
  autocomplete: "off" | "new-password"
  "data-1p-ignore": true
  "data-lpignore": "true"
}

export function noAutofill(name: string, opts?: { secret?: boolean }): NoAutofillAttributes {
  return {
    name,
    autocomplete: opts?.secret ? "new-password" : "off",
    "data-1p-ignore": true,
    "data-lpignore": "true",
  }
}

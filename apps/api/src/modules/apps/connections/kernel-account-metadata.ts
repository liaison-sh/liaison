// SPDX-License-Identifier: FSL-1.1-ALv2
// The keys of a connected account's `metadata` that the kernel owns: it writes
// them when an account connects (connections/service.ts) and reads them as
// decisions (the recorded OAuth grant behind protected-scope checks, the token's
// expiry). App code shares the object through `ctx.accounts.setMetadata`, which
// refuses these keys, so an app cannot widen its own recorded grant. Every other
// key is the app's own (a choice made on the account), kept across a reconnect of
// the same account by the same owner (service.ts).
// The connect path builds its metadata typed against this list, so a new key
// the kernel writes there is reserved by construction.
export const KERNEL_ACCOUNT_METADATA_KEYS = ["grantedOAuthScopes", "tokenExpiry"] as const

export type KernelAccountMetadataKey = (typeof KERNEL_ACCOUNT_METADATA_KEYS)[number]

const RESERVED: ReadonlySet<string> = new Set(KERNEL_ACCOUNT_METADATA_KEYS)

/** True when `key` is one the kernel owns. */
export function isKernelAccountMetadataKey(key: string): boolean {
  return RESERVED.has(key)
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// The keys of a connected account's `metadata` that the kernel owns: it writes
// them when an account connects (connections/service.ts) and reads them as
// decisions (the recorded OAuth grant behind protected-scope checks, the shared
// drives and picked items an admin chose, the token's expiry). App code shares
// the object through `ctx.accounts.setMetadata`, which refuses these keys, so
// an app cannot widen its own recorded grant or its admin-chosen read set.
// The connect path builds its metadata typed against this list, so a new key
// the kernel writes there is reserved by construction.
export const KERNEL_ACCOUNT_METADATA_KEYS = [
  "grantedOAuthScopes",
  "pickedItems",
  "sharedDrives",
  "tokenExpiry",
] as const

export type KernelAccountMetadataKey = (typeof KERNEL_ACCOUNT_METADATA_KEYS)[number]

const RESERVED: ReadonlySet<string> = new Set(KERNEL_ACCOUNT_METADATA_KEYS)

/** True when `key` is one the kernel owns. */
export function isKernelAccountMetadataKey(key: string): boolean {
  return RESERVED.has(key)
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The commerce layer's row ids. Pure and deterministic: the same org, kind and
 * key always give the same uuid, which is what lets another layer (the support
 * layer's approvals, written before commerce runs) name a commerce row by key.
 */
import { createHash } from "node:crypto"

/** Stable uuid for a seeded commerce row: same org and key always give the same id. */
export function commerceDemoId(orgId: string, kind: string, key: string): string {
  const h = createHash("sha256")
    .update(`liaison.demo.commerce|${orgId}|${kind}|${key}`)
    .digest("hex")
  const variant = "89ab"[Number.parseInt(h.slice(16, 17), 16) % 4]
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What every seed tier shares. Today: the deterministic id every demo row is
// written under, so a re-seed of the same org recomputes the SAME id and
// adopts the row it wrote, and two orgs never collide.
import { createHash } from "node:crypto"

/** Every row the demo tier writes is keyed under this namespace. */
const DEMO_ID_NAMESPACE = "liaison.demo.support"

/**
 * A stable uuid for (org, kind, key). Same shape as a v5 uuid: the sha1 of the
 * namespaced name, with the version and variant nibbles forced. The point is
 * only that it is a valid uuid and a pure function of its inputs, so a re-seed
 * of the same org recomputes the SAME id and collides on the primary key.
 */
export function demoId(orgId: string, kind: string, key: string): string {
  const digest = createHash("sha1")
    .update(`${DEMO_ID_NAMESPACE}:${orgId}:${kind}:${key}`)
    .digest("hex")
  const v = `${digest.slice(0, 12)}5${digest.slice(13, 16)}${(
    (Number.parseInt(digest[16] as string, 16) & 0x3) | 0x8
  ).toString(16)}${digest.slice(17, 32)}`
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`
}

/**
 * What a factory that writes into an existing org is handed: the org, the one
 * `now` every timestamp is an offset from, the deterministic id of a row by
 * (kind, key), and the tier's log. Built once per tier run by `seedContext`.
 */
export interface SeedContext {
  orgId: string
  now: Date
  id(kind: string, key: string): string
  log: (msg: string) => void
}

export function seedContext(input: {
  orgId: string
  now: Date
  log?: (msg: string) => void
  /**
   * The id scheme, when a layer keeps its own (the demo commerce layer's rows
   * keep the ids another layer already names them by). Defaults to `demoId`.
   */
  idScheme?: (orgId: string, kind: string, key: string) => string
}): SeedContext {
  const { orgId, now } = input
  const idScheme = input.idScheme ?? demoId
  return {
    orgId,
    now,
    id: (kind, key) => idScheme(orgId, kind, key),
    log: input.log ?? (() => {}),
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// Who can use an app, in a few words (prototype S-ACCESS): "Everyone",
// "Support + 2 people", "Admins only" when the list is empty.
import type { OrgAppAccessMode } from "./org-apps-store"

type Translate = (key: string, params?: Record<string, string | number>) => string

const M = "kernel.appManagement"

export function accessSummary(
  access: { mode: OrgAppAccessMode; roleIds: readonly string[]; userIds: readonly string[] },
  roleName: (id: string) => string | undefined,
  t: Translate,
): string {
  if (access.mode === "everyone") return t(`${M}.everyone`)
  const parts = access.roleIds.map((id) => roleName(id) ?? id)
  const n = access.userIds.length
  if (n === 1) parts.push(t(`${M}.onePerson`))
  else if (n > 1) parts.push(t(`${M}.people`, { count: n }))
  return parts.length ? parts.join(" + ") : t(`${M}.adminsOnly`)
}

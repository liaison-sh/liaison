// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-walk D6: an owner's computers often share a name ("Mac"). Wherever they
// are listed together, a repeated name carries what tells them apart: "active
// now" for the one seen in the last few minutes, else when it was last seen,
// else its place in the list.

import type { I18nValue } from "~/modules/i18n/i18n-context"

/** Seen this recently, a computer reads as active now. */
const ACTIVE_MS = 5 * 60_000

export interface LabelledNode {
  nodeId: string
  nodeName: string
  lastSeenAt?: string | null
}

/** nodeId -> the name to show: the name itself when no other computer has it. */
export function distinctNodeLabels(
  nodes: readonly LabelledNode[],
  i18n: Pick<I18nValue, "t" | "fmtDate">,
  now: number = Date.now(),
): Map<string, string> {
  const count = new Map<string, number>()
  for (const n of nodes) count.set(n.nodeName, (count.get(n.nodeName) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const n of nodes) {
    if ((count.get(n.nodeName) ?? 0) < 2) {
      labels.set(n.nodeId, n.nodeName)
      continue
    }
    const seen = n.lastSeenAt ? Date.parse(n.lastSeenAt) : Number.NaN
    let label: string
    if (Number.isFinite(seen) && now - seen < ACTIVE_MS) {
      label = i18n.t("kernel.nodeSessions.profile.nodeActive", { node: n.nodeName })
    } else if (Number.isFinite(seen)) {
      const date = i18n.fmtDate(seen, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
      label = i18n.t("kernel.nodeSessions.profile.nodeLastSeen", { node: n.nodeName, date })
    } else {
      label = n.nodeName
    }
    labels.set(n.nodeId, label)
  }
  // Still the same (never seen, or seen at the same minute): numbered.
  const again = new Map<string, number>()
  for (const l of labels.values()) again.set(l, (again.get(l) ?? 0) + 1)
  const nth = new Map<string, number>()
  for (const n of nodes) {
    const l = labels.get(n.nodeId) as string
    if ((again.get(l) ?? 0) < 2) continue
    const k = (nth.get(l) ?? 0) + 1
    nth.set(l, k)
    labels.set(
      n.nodeId,
      i18n.t("kernel.nodeSessions.profile.nodeNumbered", { node: l, n: String(k) }),
    )
  }
  return labels
}

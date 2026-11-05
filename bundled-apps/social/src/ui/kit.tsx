// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Social UI kit: the shared primitive set from @liaison/app-ui/kit, plus the
// social-only untrusted-content fence stripper.
export {
  Badge,
  type BadgeTone,
  Button,
  Card,
  cx,
  EmptyState,
  inputClass,
  PageHeader,
  SectionLabel,
} from "@liaison/app-ui/kit"

// ── Untrusted-content fence ──────────────────────────────────────────────────
// reads.ts wraps third-party social text (finding content_text, DM body /
// last_message_snippet) in `<external-content source="untrusted">...
// </external-content>` so the AGENT reads it as data, not instructions
// (fenceField in reads.ts). That fence is right for the agent but must never
// be shown to a HUMAN verbatim — strip it before rendering. Tolerant: content
// that isn't fenced (e.g. our own outbound text) is returned unchanged.
const EXTERNAL_CONTENT_FENCE =
  /^<external-content source="untrusted">\n([\s\S]*)\n<\/external-content>$/

export function stripExternalFence(s: string | null | undefined): string {
  if (!s) return s ?? ""
  const match = s.match(EXTERNAL_CONTENT_FENCE)
  return match ? match[1]! : s
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Monitoring UI kit: the shared primitive set from @liaison/app-ui/kit, trimmed
// to what the monitoring surfaces use, plus the severity dot helper.
import { type BadgeTone, badgeDotClass } from "@liaison/app-ui/kit"

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
  Segmented,
} from "@liaison/app-ui/kit"

export const severityDotClass = (tone: BadgeTone): string => badgeDotClass(tone)

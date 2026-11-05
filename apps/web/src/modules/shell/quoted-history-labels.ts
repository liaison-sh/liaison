// SPDX-License-Identifier: FSL-1.1-ALv2
// Copy for the presentation-layer QuotedHistory (src/ui cannot import the i18n
// module), shared by the Mail and Tickets conversations.

import type { Translate } from "~/modules/i18n/i18n-context"
import type { QuotedHistoryLabels } from "~/ui/QuotedHistory"

export function quotedHistoryLabels(t: Translate): QuotedHistoryLabels {
  return {
    show: t("kernel.quotedHistory.show"),
    hide: t("kernel.quotedHistory.hide"),
    loading: t("kernel.common.loading2"),
    summary: (count, linked) => {
      const earlier = t(
        count === 1
          ? "kernel.quotedHistory.earlierEmailsOne"
          : "kernel.quotedHistory.earlierEmailsOther",
        { count },
      )
      // "0 already in this thread" says nothing: the part shows once one links.
      return linked > 0
        ? `${earlier} · ${t("kernel.quotedHistory.alreadyInThread", { count: linked })}`
        : earlier
    },
    inThread: t("kernel.quotedHistory.inThread"),
    inThreadLabel: t("kernel.quotedHistory.inThreadLabel"),
    showOriginal: t("kernel.quotedHistory.showOriginal"),
    hideOriginal: t("kernel.quotedHistory.hideOriginal"),
    unknownSender: t("kernel.quotedHistory.unknownSender"),
  }
}

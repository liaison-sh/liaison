// SPDX-License-Identifier: FSL-1.1-ALv2

import { ChevronLeft } from "lucide-solid"
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { setKnowledgeView } from "./knowledge-store"

/** The way back from Unfiled and Search to the Knowledge home. */
const KnowledgeHomeLink: Component = () => {
  const i18n = useI18n()
  return (
    <button
      type="button"
      data-testid="knowledge-view-home"
      onClick={() => setKnowledgeView("home")}
      class="-ml-1 mb-2 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-text-tertiary outline-none transition-colors hover:bg-surface-hover hover:text-text-secondary focus-visible:bg-surface-hover"
    >
      <ChevronLeft size={14} />
      {i18n.t("knowledge.backToKnowledge")}
    </button>
  )
}

export default KnowledgeHomeLink

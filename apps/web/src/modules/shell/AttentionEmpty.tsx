// SPDX-License-Identifier: FSL-1.1-ALv2

import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"

const AttentionEmpty: Component = () => {
  const i18n = useI18n()
  return (
    <div
      data-testid="home-empty-state"
      class="flex flex-col items-center justify-center gap-3 py-24 text-center"
    >
      <p class="font-display text-[18px] font-medium text-text">
        {i18n.t("kernel.nothingNeedsYouRightNow")}
      </p>
      <p class="text-[13px] text-text-secondary">
        <button
          type="button"
          data-testid="home-empty-link-projects"
          class="hover:text-accent"
          onClick={() =>
            openTab({
              type: "projects:home",
              entityId: "projects-home",
              label: i18n.t("kernel.shellUi.projects"),
            })
          }
        >
          {i18n.t("kernel.shellUi.openProjects")}
        </button>
        <span class="mx-2 text-text-tertiary">·</span>
        <button
          type="button"
          data-testid="home-empty-link-tickets"
          class="hover:text-accent"
          onClick={() =>
            openTab({
              type: "tickets:inbox",
              entityId: "tickets-inbox",
              label: i18n.t("kernel.shellUi.tickets"),
            })
          }
        >
          {i18n.t("kernel.shellUi.openTickets")}
        </button>
        <span class="mx-2 text-text-tertiary">·</span>
        <button
          type="button"
          data-testid="home-empty-link-mail"
          class="hover:text-accent"
          onClick={() =>
            openTab({
              type: "mail:inbox",
              entityId: "mail-inbox",
              label: i18n.t("kernel.shellUi.mail"),
            })
          }
        >
          {i18n.t("kernel.shellUi.openMail")}
        </button>
      </p>
    </div>
  )
}

export default AttentionEmpty

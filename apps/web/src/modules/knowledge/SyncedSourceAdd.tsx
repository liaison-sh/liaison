// SPDX-License-Identifier: FSL-1.1-ALv2
// The Knowledge settings page's "Add source" block (custom block
// `SyncedSourceAdd`, declared in the knowledge manifest `settings`), under the
// synced sources list. Adding a source is the full-tab SyncedSourceAddTab flow,
// so the agent panel stays reachable while it is filled in
// ([[feedback_no_popups_for_cognitive_work]]).
//
// A Google Drive connected in picked mode (a personal Google account) syncs
// only the files its owner picks: the same picker card the chat and the Drive
// connection in Settings draw sits here, so files are added from Knowledge too.
import type { Component } from "solid-js"
import { DrivePickerCard } from "~/modules/drive-picker/DrivePickerCard"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"

export const SyncedSourceAdd: Component = () => {
  const i18n = useI18n()
  return (
    <div class="flex flex-col gap-2">
      <DrivePickerCard quiet />
      <div class="flex items-center justify-between gap-4">
        <p class="text-[13px] text-text-tertiary">
          {i18n.t("knowledge.mountAnExternalFolderGoogleDrive")}
        </p>
        <Button
          class="shrink-0 whitespace-nowrap"
          data-testid="synced-sources-add-button"
          onClick={() =>
            openTab({
              type: "knowledge:synced-source-add",
              entityId: "new",
              label: i18n.t("knowledge.addSyncedSource"),
            })
          }
        >
          {i18n.t("knowledge.addSource")}
        </Button>
      </div>
    </div>
  )
}

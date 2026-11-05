// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One line above the search box. It renders only when search cannot answer in
// full, which is the whole contract: no banner means the results are complete.

import { type Component, Show } from "solid-js"
import { searchIndexBanner } from "~/modules/mailbox/search-index/search-index-store"

export const MailSearchIndexBanner: Component = () => {
  return (
    <Show when={searchIndexBanner()}>
      {(banner) => (
        <div
          data-testid="mail-search-index-banner"
          data-status={banner().status}
          class="rounded-md bg-surface-sunken px-3 py-2 text-[12px] text-text-secondary ring-1 ring-border"
        >
          {banner().text}
        </div>
      )}
    </Show>
  )
}

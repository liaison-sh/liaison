// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The channel list's sort order, remembered per device. Storage can be absent
// or throw (private window, blocked site data): the default then applies.
import type { ChannelSort } from "~/modules/threads/thread-list-model"

export const CHANNEL_SORT_KEY = "liaison:channels-sort"
export const CHANNEL_SORTS: readonly ChannelSort[] = ["recent", "name", "unread"]

export function loadChannelSort(): ChannelSort {
  try {
    const raw = localStorage.getItem(CHANNEL_SORT_KEY)
    return CHANNEL_SORTS.find((s) => s === raw) ?? "recent"
  } catch {
    return "recent"
  }
}

export function saveChannelSort(sort: ChannelSort): void {
  try {
    localStorage.setItem(CHANNEL_SORT_KEY, sort)
  } catch {
    // Not remembered; the choice still holds for this session.
  }
}

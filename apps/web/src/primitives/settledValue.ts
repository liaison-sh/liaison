// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Resource, untrack } from "solid-js"

/**
 * A resource's value once it has one, read WITHOUT suspending.
 *
 * Reading a resource accessor inside a render computation registers that
 * computation on the nearest <Suspense>, which then shows its fallback while
 * the resource loads, now or on any later refetch. For a small piece of UI that
 * has its own loading look (an attachment preview's skeleton or icon) the
 * nearest boundary is MainPanel's per-tab one: every new message with a picture
 * pulled the whole thread out of the document for a few frames, and the
 * message list came back scrolled to the top of the history.
 *
 * `state` is a plain signal, so tracking it is enough to re-render when the
 * value lands; the value itself is read untracked, which never touches
 * Suspense. Undefined while unresolved or errored.
 */
export function settledValue<T>(resource: Resource<T>): T | undefined {
  const state = resource.state
  if (state !== "ready" && state !== "refreshing") return undefined
  return untrack(() => resource.latest)
}

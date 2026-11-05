// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * ResponsiveDetail: a desktop multi-column detail view that stacks vertically
 * at phone width.
 *
 * `content` comes before `metadata` in DOM order at every width, so
 * "metadata after content, not beside it" (spec-responsive.md) holds literally
 * when stacked and reads the same way when side by side. Only the flex
 * direction changes at the `md:` breakpoint.
 */
import type { JSX } from "solid-js"
import { cn } from "~/lib/cn"

export interface ResponsiveDetailProps {
  content: JSX.Element
  metadata: JSX.Element
  class?: string
  contentClass?: string
  metadataClass?: string
}

export function ResponsiveDetail(props: ResponsiveDetailProps): JSX.Element {
  return (
    <div
      class={cn("flex min-h-0 flex-col md:flex-row md:items-stretch", props.class)}
      data-responsive="detail"
    >
      <div class={cn("min-w-0 flex-1", props.contentClass)} data-responsive="content">
        {props.content}
      </div>
      <div class={cn("min-w-0 shrink-0", props.metadataClass)} data-responsive="metadata">
        {props.metadata}
      </div>
    </div>
  )
}

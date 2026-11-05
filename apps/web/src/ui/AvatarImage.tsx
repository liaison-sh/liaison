// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createSignal, type JSX, Show } from "solid-js"
import { serverResourceUrl } from "~/lib/env"

/**
 * An avatar picture that falls back when it cannot be shown.
 *
 * Every avatar in the app (people, agents, contacts in a thread) renders
 * through this: no URL, or a URL that fails to load (a 404 after the file
 * was replaced or deleted, a dead host), shows `fallback` (the initials or the
 * agent glyph the caller would show for no picture) instead of the browser's
 * broken image. A new URL gets a fresh try.
 */
export const AvatarImage: Component<{
  /** The stored avatar URL; a server-relative one is resolved here. */
  url: string | null | undefined
  fallback: JSX.Element
  alt?: string
  class?: string
  style?: JSX.CSSProperties
  loading?: "lazy" | "eager"
  testId?: string
}> = (props) => {
  const [failedSrc, setFailedSrc] = createSignal<string | null>(null)
  const src = () => {
    const resolved = serverResourceUrl(props.url)
    return resolved && resolved !== failedSrc() ? resolved : null
  }
  return (
    <Show when={src()} fallback={props.fallback} keyed>
      {(s) => (
        <img
          src={s}
          alt={props.alt ?? ""}
          class={props.class}
          style={props.style}
          loading={props.loading}
          data-testid={props.testId}
          onError={() => setFailedSrc(s)}
        />
      )}
    </Show>
  )
}

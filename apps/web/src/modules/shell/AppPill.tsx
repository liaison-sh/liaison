// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one pill that names an app's action: "Tickets: reply", "Invoicing: create
// quote and issue", "Shopify: create discount". Home's approval rows, the
// approval filter chips and the approval card all render it, so they agree on
// the colour of an app the way the rail and the tab strip already do.
//
// It owns the COLOUR only (plus the round border every pill shares): size,
// padding and weight stay with the surface, which is why a 32px phone filter
// chip and an 11px row badge can both be this component. The colour is the
// app's hue (app-color.ts); a kernel action, or one with no app at all, is
// neutral. Colour identifies the app and nothing else: it is never a risk or
// urgency signal.

import { type Component, type JSX, splitProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import { cn } from "~/lib/cn"
import { appIdOfTabType, appPillVars, isSystemAppId } from "~/modules/shell/app-color"

/** The app a gated tool belongs to (`tickets:reply` -> `tickets`). */
export function appIdOfTool(toolName: string | null | undefined): string | null {
  if (!toolName) return null
  return appIdOfTabType(toolName) || null
}

type PillElementProps = JSX.HTMLAttributes<HTMLElement> & {
  type?: "button"
}

export interface AppPillProps extends PillElementProps {
  /** The app whose colour the pill takes. `kernel` or none reads neutral. */
  appId: string | null | undefined
  /** `button` for a pill that is a control (a filter chip). */
  as?: "span" | "button"
  /** A pressed control (selected filter): outlined in its own text colour. */
  pressed?: boolean
  testid?: string
  children: JSX.Element
}

export const AppPill: Component<AppPillProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "appId",
    "as",
    "pressed",
    "testid",
    "class",
    "style",
    "children",
  ])
  const system = (): boolean => isSystemAppId(local.appId)
  const style = (): JSX.CSSProperties | undefined => {
    const base = typeof local.style === "object" ? local.style : undefined
    if (system() || !local.appId) return base
    return { ...base, ...appPillVars(local.appId) }
  }
  return (
    <Dynamic
      component={local.as ?? "span"}
      {...rest}
      data-testid={local.testid}
      data-app={system() ? "system" : local.appId}
      data-app-tone={system() ? "system" : "app"}
      aria-pressed={
        local.as === "button" && local.pressed !== undefined ? local.pressed : undefined
      }
      class={cn(
        "rounded-full border",
        system()
          ? local.pressed
            ? "border-accent-border bg-accent-glow text-accent"
            : "border-border bg-surface text-text-secondary"
          : "app-pill",
        local.class,
      )}
      style={style()}
    >
      {local.children}
    </Dynamic>
  )
}

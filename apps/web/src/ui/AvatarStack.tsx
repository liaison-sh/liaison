// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createSignal, For, Show } from "solid-js"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { AvatarImage } from "~/ui/AvatarImage"
import { agentAvatarStyle, avatarColors } from "~/ui/avatar-palette"
import { Tooltip } from "~/ui/Tooltip"

export interface AvatarUser {
  id: string
  name: string
  avatarUrl: string | null
  /** Agent seats render the agent glyph instead of initials or a photo.
   *  Absent means a human, which is what every non-thread caller passes. */
  participantType?: "user" | "agent"
}

// ── Avatar colors: the one app wide palette (`~/ui/avatar-palette`) ──

const colorForUser = avatarColors

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

// ── Sizing ───────────────────────────────────────────────────────

const STACK_SIZES = {
  sm: { square: 24, mini: 17, full: 20, miniFont: 7, fullFont: 9, badge: 12, badgeFont: 7, gap: 3 },
  md: {
    square: 32,
    mini: 22,
    full: 26,
    miniFont: 9,
    fullFont: 10,
    badge: 14,
    badgeFont: 8,
    gap: 4,
  },
  lg: {
    square: 40,
    mini: 28,
    full: 32,
    miniFont: 11,
    fullFont: 12,
    badge: 16,
    badgeFont: 9,
    gap: 5,
  },
}

// ── Single Avatar (public) ───────────────────────────────────────

interface AvatarProps {
  user: AvatarUser
  size?: "sm" | "md" | "lg"
  showPresence?: boolean
  presenceStatus?: Record<string, string>
  /** An exact diameter in px, for surfaces whose grid is not one of the three
   *  named sizes (the chat dock's 20px bar item and 34px window header). It
   *  overrides `size` for the box and the initials; the presence dot keeps
   *  the named size's. */
  pixelSize?: number
}

const AVATAR_SIZES = {
  sm: { box: "h-6 w-6", text: "text-[10px]", presence: "h-2 w-2 border-[1.5px]" },
  md: { box: "h-8 w-8", text: "text-[12px]", presence: "h-2.5 w-2.5 border-2" },
  lg: { box: "h-10 w-10", text: "text-[13px]", presence: "h-3 w-3 border-2" },
}

export const Avatar: Component<AvatarProps> = (props) => {
  const s = () => AVATAR_SIZES[props.size ?? "md"]
  const isOnline = () => props.showPresence && props.presenceStatus?.[props.user.id] === "online"
  const color = () => colorForUser(props.user.id)
  const isAgent = () => props.user.participantType === "agent"
  const box = () => (props.pixelSize ? "" : s().box)
  const text = () => (props.pixelSize ? "" : s().text)
  const boxStyle = () =>
    props.pixelSize
      ? {
          width: `${props.pixelSize}px`,
          height: `${props.pixelSize}px`,
          "font-size": `${Math.max(8, Math.round(props.pixelSize * 0.4))}px`,
        }
      : undefined

  return (
    <div class={`relative shrink-0 ${box()}`} style={boxStyle()}>
      <Show
        when={!isAgent()}
        fallback={
          <div
            class={`flex items-center justify-center rounded-full font-medium ${box()} ${text()}`}
            style={{ ...boxStyle(), ...agentAvatarStyle(props.user.id) }}
          >
            <AgentGlyph />
          </div>
        }
      >
        <AvatarImage
          url={props.user.avatarUrl}
          alt={props.user.name}
          class={`rounded-full object-cover ${box()}`}
          style={boxStyle()}
          fallback={
            <div
              class={`flex items-center justify-center rounded-full font-medium ${box()} ${text()}`}
              style={{ ...boxStyle(), "background-color": color().bg, color: color().text }}
            >
              {initials(props.user.name)}
            </div>
          }
        />
      </Show>
      <Show when={isOnline()}>
        <div
          class={`absolute -bottom-0.5 -right-0.5 rounded-full border-bg bg-success ${s().presence}`}
        />
      </Show>
    </div>
  )
}

// ── Circle (internal to stack) ───────────────────────────────────

function Circle(props: { user: AvatarUser; diameter: number; fontSize: number }) {
  const color = () => colorForUser(props.user.id)
  const isAgent = () => props.user.participantType === "agent"

  return (
    <Show
      when={!isAgent()}
      fallback={
        <div
          class="flex items-center justify-center rounded-full font-semibold"
          style={{
            width: `${props.diameter}px`,
            height: `${props.diameter}px`,
            ...agentAvatarStyle(props.user.id),
            "font-size": `${props.fontSize}px`,
            "line-height": "1",
          }}
        >
          <AgentGlyph />
        </div>
      }
    >
      <AvatarImage
        url={props.user.avatarUrl}
        alt={props.user.name}
        class="rounded-full object-cover"
        style={{ width: `${props.diameter}px`, height: `${props.diameter}px` }}
        fallback={
          <div
            class="flex items-center justify-center rounded-full font-semibold"
            style={{
              width: `${props.diameter}px`,
              height: `${props.diameter}px`,
              "background-color": color().bg,
              color: color().text,
              "font-size": `${props.fontSize}px`,
              "line-height": "1",
            }}
          >
            {initials(props.user.name)}
          </div>
        }
      />
    </Show>
  )
}

// ── AvatarStack ──────────────────────────────────────────────────
//
// Collapsed: fixed square with 2 diagonally offset circles.
//   - 3+ users: small "+N" badge at bottom-right.
// Expanded (hover): circles unroll into a horizontal row spanning
//   the parent width, alpha-fading at the trailing edge.
//   - Hover on individual circle: name tooltip (pop-under).
//   - Spring easing on expand, smooth ease on collapse.

interface AvatarStackProps {
  users: AvatarUser[]
  size?: "sm" | "md" | "lg"
  max?: number
  showPresence?: boolean
  presenceStatus?: Record<string, string>
}

const AvatarStack: Component<AvatarStackProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false)
  const [expandedWidth, setExpandedWidth] = createSignal(240)
  let containerRef!: HTMLDivElement

  const size = () => props.size ?? "md"
  const cfg = () => STACK_SIZES[size()]
  const visible = () => {
    const m = props.max
    return m != null && m > 0 ? props.users.slice(0, m) : props.users
  }
  const hiddenCount = () => props.users.length - visible().length
  const overflow = () => Math.max(0, props.users.length - 2)
  /** What the unrolled row wants: every circle plus the gaps between them. */
  const naturalWidth = () => {
    const count = visible().length + (hiddenCount() > 0 ? 1 : 0)
    return count * cfg().full + Math.max(0, count - 1) * cfg().gap
  }
  /** What it gets: never more than the room left beside it in the header. */
  const rowWidth = () => Math.min(naturalWidth(), expandedWidth())
  const contentOverflows = () => naturalWidth() > expandedWidth()

  function measureWidth() {
    if (!containerRef) return
    // Walk up to the nearest button ancestor (sidebar items), or 2 levels up to reach
    // past constrained flex children (e.g. min-w-0 sections) to the full-width layout
    // container. DO NOT regress this to parentElement alone — it causes the expanded
    // row to clip after ~4 avatars instead of spanning the full header width.
    const parent =
      containerRef.closest("button") ??
      containerRef.parentElement?.parentElement ??
      containerRef.parentElement
    if (!parent) return
    const pRect = parent.getBoundingClientRect()
    const cRect = containerRef.getBoundingClientRect()
    const available = pRect.right - cRect.left - 12
    // A layoutless environment (and a hidden header) measures zero: keep the
    // last sane width rather than collapsing the row to nothing.
    if (available > 0) setExpandedWidth(available)
  }

  return (
    <Show
      when={props.users.length > 1}
      fallback={
        <Show when={props.users[0]}>
          <Avatar
            user={props.users[0]}
            size={size()}
            showPresence={props.showPresence}
            presenceStatus={props.presenceStatus}
          />
        </Show>
      }
    >
      {/* THE EXPANDED ROW TAKES ITS WIDTH IN FLOW. It used to unroll as an
          overlay over whatever sat beside it, which in a thread header is the
          channel title: hovering the stack hid half the title for as long as
          it was open. The box grows instead, and the title, a flex sibling,
          slides right by exactly as much. */}
      <div
        ref={containerRef}
        role="group"
        data-testid="avatar-stack"
        aria-label={`${props.users.length} participants`}
        tabindex="0"
        class="relative shrink-0"
        style={{
          width: isExpanded() ? `${rowWidth()}px` : `${cfg().square}px`,
          height: `${cfg().square}px`,
          transition: "width 220ms cubic-bezier(0.4, 0, 0.2, 1)",
          "z-index": isExpanded() ? "20" : undefined,
        }}
        onMouseEnter={() => {
          measureWidth()
          setIsExpanded(true)
        }}
        onMouseLeave={() => {
          setIsExpanded(false)
        }}
        onFocus={() => {
          measureWidth()
          setIsExpanded(true)
        }}
        onBlur={() => {
          setIsExpanded(false)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            measureWidth()
            setIsExpanded((v) => !v)
          }
        }}
      >
        {/* ── Collapsed: 2 diagonally offset circles ── */}
        <div
          class="absolute inset-0"
          style={{
            opacity: isExpanded() ? "0" : "1",
            "pointer-events": isExpanded() ? "none" : "auto",
            transition: isExpanded()
              ? "opacity 120ms cubic-bezier(0.4, 0, 0.2, 1)"
              : "opacity 200ms cubic-bezier(0.4, 0, 0.2, 1) 80ms",
          }}
        >
          {/* Front circle — bottom-left */}
          <div style={{ position: "absolute", left: "0", bottom: "0", "z-index": "2" }}>
            <Circle user={props.users[0]} diameter={cfg().mini} fontSize={cfg().miniFont} />
          </div>
          {/* Back circle — top-right */}
          <Show when={props.users[1]}>
            <div style={{ position: "absolute", right: "0", top: "0", "z-index": "1" }}>
              <Circle user={props.users[1]} diameter={cfg().mini} fontSize={cfg().miniFont} />
            </div>
          </Show>
          {/* Overflow badge */}
          <Show when={overflow() > 0}>
            <div
              class="absolute flex items-center justify-center rounded-full font-semibold"
              style={{
                right: "-2px",
                bottom: "-2px",
                width: `${cfg().badge}px`,
                height: `${cfg().badge}px`,
                "font-size": `${cfg().badgeFont}px`,
                "background-color": "var(--color-surface-hover)",
                color: "var(--color-text-secondary)",
                "z-index": "3",
              }}
            >
              +{overflow()}
            </div>
          </Show>
        </div>

        {/* ── Expanded: horizontal row with alpha fade ── */}
        <div
          data-testid="avatar-stack-expanded"
          class="flex items-center"
          classList={{
            absolute: !isExpanded(),
            "left-0": !isExpanded(),
            "top-0": !isExpanded(),
          }}
          style={{
            height: `${cfg().square}px`,
            width: `${rowWidth()}px`,
            gap: `${cfg().gap}px`,
            opacity: isExpanded() ? "1" : "0",
            "pointer-events": isExpanded() ? "auto" : "none",
            "-webkit-mask-image": contentOverflows()
              ? "linear-gradient(to right, black 0%, black 78%, transparent 100%)"
              : undefined,
            "mask-image": contentOverflows()
              ? "linear-gradient(to right, black 0%, black 78%, transparent 100%)"
              : undefined,
            transition: isExpanded()
              ? "opacity 200ms cubic-bezier(0.4, 0, 0.2, 1) 60ms"
              : "opacity 120ms cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          <For each={visible()}>
            {(user, i) => {
              const delay = () => i() * 25
              return (
                <Tooltip content={user.name}>
                  <div
                    class="relative shrink-0 cursor-default"
                    style={{
                      transform: isExpanded()
                        ? "scale(1) translateX(0)"
                        : `scale(0.5) translateX(${-i() * 10}px)`,
                      opacity: isExpanded() ? "1" : "0",
                      transition: isExpanded()
                        ? `transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1) ${delay()}ms, opacity 180ms ease-out ${delay()}ms`
                        : "transform 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms ease-out",
                    }}
                  >
                    <Circle user={user} diameter={cfg().full} fontSize={cfg().fullFont} />
                    <Show when={props.showPresence && props.presenceStatus?.[user.id] === "online"}>
                      <div
                        class="absolute rounded-full bg-success"
                        style={{
                          width: "6px",
                          height: "6px",
                          bottom: "-1px",
                          right: "-1px",
                          border: "1.5px solid var(--color-bg)",
                        }}
                      />
                    </Show>
                  </div>
                </Tooltip>
              )
            }}
          </For>
          <Show when={hiddenCount() > 0}>
            <div
              class="flex shrink-0 items-center justify-center rounded-full font-semibold"
              style={{
                width: `${cfg().full}px`,
                height: `${cfg().full}px`,
                "font-size": `${cfg().fullFont}px`,
                "background-color": "var(--color-surface-hover)",
                color: "var(--color-text-secondary)",
              }}
            >
              +{hiddenCount()}
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}

export { AvatarStack }

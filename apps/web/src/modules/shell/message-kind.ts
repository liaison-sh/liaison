// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One presentation contract for the three kinds of thing in a message stream,
// shared by tickets, mail and threads (ticket-10175).
//
// The three are not variants of one object, they carry different WEIGHT, and the
// design should say so:
//
//   inbound    EVIDENCE     what the customer actually said. Quoted back in
//                           disputes. Recessive: it is the ground, not the act.
//   outbound   COMMITMENT   what we told them. They have it. It cannot be
//                           unsent. Prominent, because this is the row whose
//                           consequences leave the building.
//   note       INTERNAL     neither. The costly mistake here is in BOTH
//                           directions: reading a note as something the
//                           customer saw, or writing one believing they will.
//
// Why the cue is not colour. The surfaces already tinted cards amber and blue at
// ~20% opacity, which is a hue difference at low saturation: it disappears in a
// bright room, in greyscale, and for the ~8% of men with a colour vision
// deficiency. So every kind carries a LEFT RAIL (present/absent, solid/dashed)
// and an explicit human LABEL. Colour is left in as reinforcement, never as the
// carrier.
//
// And the label is words, not the enum. The ticket stream printed `m.kind`
// straight into the badge, so operators read "outbound-pending" and "inbound" --
// machine vocabulary for a human judgement about who can see what.

export interface MessageKindPresentation {
  /** Human label for the badge. Never the raw enum. English; a stable hook. */
  label: string
  /** Catalog key for `label`, for the reader's language. */
  labelKey: string
  /** Catalog key for `visibility`. */
  visibilityKey: string
  /**
   * Who can see this. Rendered on the internal kind, where getting it wrong is
   * expensive, and available to any surface that wants it elsewhere.
   */
  visibility: string
  /**
   * Background class for the rail ELEMENT, or "" for no rail.
   *
   * An element, not a `border-l-*` utility. The first cut used border
   * utilities and the colour silently lost the cascade: the surface class sets
   * `border-border` on all four sides, which overrides `border-l-accent`, so
   * outbound rendered a 3px left border in the ORDINARY border colour --
   * present in the class string, invisible on screen, and identical to inbound.
   * Measured on prod: borderLeftWidth 3px, borderLeftColor rgb(223,223,229).
   * Class-string assertions cannot see that; computed style can. An absolutely
   * positioned span owns its own background and cannot be overridden by the
   * card's border utilities -- the same approach AttentionRow already uses for
   * its hover accent.
   */
  rail: string
  /** Card surface. Reinforcement only. */
  surface: string
  /** Badge chip. */
  badge: string
  /** Stable semantic hook for tests and oracles, independent of styling. */
  tone: "evidence" | "commitment" | "internal"
}

const INBOUND: MessageKindPresentation = {
  label: "From customer",
  labelKey: "kernel.shellUi.kind.inbound",
  visibility: "Received from the customer",
  visibilityKey: "kernel.shellUi.kind.inboundVisibility",
  // No rail: inbound is the baseline the other two are read AGAINST. Giving
  // every kind a rail would flatten the distinction it exists to carry.
  rail: "",
  surface: "border-border bg-surface-sunken",
  badge: "bg-surface text-text-secondary",
  tone: "evidence",
}

const OUTBOUND: MessageKindPresentation = {
  label: "Sent to customer",
  labelKey: "kernel.shellUi.kind.outbound",
  visibility: "The customer has received this",
  visibilityKey: "kernel.shellUi.kind.outboundVisibility",
  rail: "bg-accent",
  surface: "border-border bg-surface",
  badge: "bg-accent-glow text-accent",
  tone: "commitment",
}

const OUTBOUND_PENDING: MessageKindPresentation = {
  ...OUTBOUND,
  label: "Sending",
  labelKey: "kernel.shellUi.kind.pending",
  visibility: "Not delivered yet",
  visibilityKey: "kernel.shellUi.kind.pendingVisibility",
  // Half-strength, not solid: the commitment is not made until it lands, and
  // the rail should not claim otherwise at a glance.
  rail: "bg-accent/50",
}

const NOTE: MessageKindPresentation = {
  label: "Internal note",
  labelKey: "kernel.shellUi.kind.note",
  visibility: "Not visible to the customer",
  visibilityKey: "kernel.shellUi.kind.noteVisibility",
  rail: "bg-warning",
  surface: "border-warning-border bg-warning-glow/30",
  badge: "bg-warning-glow text-warning",
  tone: "internal",
}

export function presentMessageKind(kind: string | null | undefined): MessageKindPresentation {
  switch (kind) {
    case "outbound":
      return OUTBOUND
    case "outbound-pending":
      return OUTBOUND_PENDING
    case "note":
      return NOTE
    default:
      // Unknown kinds read as inbound rather than throwing: a stream must still
      // render when the backend grows a kind the frontend has not shipped yet,
      // and the recessive treatment is the safe default -- it never claims a
      // message was sent to anyone.
      return INBOUND
  }
}

/** True for the kinds the customer can see. The question worth asking directly
 *  rather than re-deriving from a kind comparison at each call site. */
export function isCustomerVisible(kind: string | null | undefined): boolean {
  return kind === "inbound" || kind === "outbound" || kind === "outbound-pending"
}

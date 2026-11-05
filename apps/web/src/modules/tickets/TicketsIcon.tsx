// SPDX-License-Identifier: FSL-1.1-ALv2
import { Ticket } from "lucide-solid"
import type { Component } from "solid-js"

export const TicketsIcon: Component<{ size?: number }> = (props) => (
  <Ticket size={Math.max(props.size ?? 20, 16)} />
)

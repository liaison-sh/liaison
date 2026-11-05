// SPDX-License-Identifier: FSL-1.1-ALv2
import { Calendar } from "lucide-solid"
import type { Component } from "solid-js"

export const CalendarIcon: Component<{ size?: number }> = (props) => (
  <Calendar size={Math.max(props.size ?? 20, 16)} />
)

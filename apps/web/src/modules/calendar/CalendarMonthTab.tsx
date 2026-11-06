// SPDX-License-Identifier: FSL-1.1-ALv2
// Manifest tab entry — renders the unified CalendarShell (Day/Week/Month switcher inside).
import type { Component } from "solid-js"
import { CalendarShell } from "./CalendarShell"

const CalendarMonthTab: Component<{ entityId?: string }> = (props) => (
  <CalendarShell initialView="month" testId="calendar-month-tab" entityId={props.entityId} />
)

export default CalendarMonthTab

// SPDX-License-Identifier: FSL-1.1-ALv2
// Manifest tab entry — renders the unified CalendarShell opened on the week view.
import type { Component } from "solid-js"
import { CalendarShell } from "./CalendarShell"

const CalendarWeekTab: Component<{ entityId?: string }> = (props) => (
  <CalendarShell initialView="week" testId="calendar-week-tab" entityId={props.entityId} />
)

export default CalendarWeekTab

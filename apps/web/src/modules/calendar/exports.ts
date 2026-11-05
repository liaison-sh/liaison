// SPDX-License-Identifier: FSL-1.1-ALv2
// Every component the calendar manifest's `views` block declares must be exported here — a
// missing export aborts the whole manifest-app registration (mirrors knowledge/tickets exports.ts).
import { lazy } from "solid-js"

export { CalendarIcon } from "./CalendarIcon"
export const CalendarMonthTab = lazy(() => import("./CalendarMonthTab"))
export const CalendarWeekTab = lazy(() => import("./CalendarWeekTab"))
export const CalendarSidebar = lazy(() => import("./CalendarSidebar"))
export const CalendarChoices = lazy(() =>
  import("./CalendarChoices").then((m) => ({ default: m.CalendarChoices })),
)

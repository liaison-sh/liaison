// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A tiny tour used by tests (not in the shipped catalogue): one show beat, one
 * do beat completing on a thread message, one demo-only world beat, and one
 * beat that exists only when the tickets app is installed.
 */
import { defineTour } from "../schema"

export const kernelSampleTour = defineTour({
  id: "kernel.sample",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "welcome",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "activity-bar",
      anchorPhone: "phone-tab-bar",
    },
    {
      id: "post-message",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      anchor: "compose-editor",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [
        { type: { testid: "compose-editor", text: "tours.kernel.sample.postMessage.text" } },
        { click: "compose-send" },
        { waitEvent: true },
      ],
    },
    {
      id: "live-ticket",
      kind: "world",
      title: "tours.kernel.sample.liveTicket.title",
      body: "tours.kernel.sample.liveTicket.body",
      injector: "sample-ticket",
    },
    {
      id: "tickets-inbox",
      kind: "show",
      title: "tours.kernel.sample.ticketsInbox.title",
      body: "tours.kernel.sample.ticketsInbox.body",
      optional: { whenApp: "tickets" },
    },
  ],
})

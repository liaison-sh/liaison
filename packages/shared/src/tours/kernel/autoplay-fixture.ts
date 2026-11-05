// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Test fixture (not in the shipped catalogue): one beat per kind of real-UI
 * input "Do it for me" must drive, played by the web's autoplay Playwright
 * scenario: a rich editor with an @mention picked from the picker, a composer
 * textarea, and a popup menu opened and picked from.
 */
import { defineTour } from "../schema"

export const kernelAutoplayFixtureTour = defineTour({
  id: "kernel.autoplay-fixture",
  app: "kernel",
  title: "tours.kernel.autoplayFixture.title",
  summary: "tours.kernel.autoplayFixture.summary",
  beats: [
    {
      id: "mention",
      kind: "do",
      title: "tours.kernel.autoplayFixture.mention.title",
      body: "tours.kernel.autoplayFixture.mention.body",
      anchor: "compose-editor",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [
        { type: { testid: "compose-editor", text: "tours.kernel.autoplayFixture.mention.text" } },
        { waitFor: "mention-autocomplete" },
        { click: "mention-result-user" },
        {
          type: {
            testid: "compose-editor",
            text: "tours.kernel.autoplayFixture.mention.textAfter",
            append: true,
          },
        },
        { click: "compose-send" },
        { waitEvent: true },
      ],
    },
    {
      id: "session",
      kind: "do",
      title: "tours.kernel.autoplayFixture.session.title",
      body: "tours.kernel.autoplayFixture.session.body",
      anchor: "session-composer-field",
      event: { app: "kernel", entity: "node_session", action: "update" },
      autoplay: [
        {
          type: {
            testid: "session-composer-field",
            text: "tours.kernel.autoplayFixture.session.text",
          },
        },
        { waitEvent: true },
      ],
    },
    {
      id: "status",
      kind: "do",
      title: "tours.kernel.autoplayFixture.status.title",
      body: "tours.kernel.autoplayFixture.status.body",
      anchor: "tickets-detail-status",
      event: { app: "tickets", entity: "ticket", action: "update" },
      autoplay: [
        { click: "tickets-detail-status" },
        { waitFor: "tickets-status-option-awaiting_customer" },
        { click: "tickets-status-option-awaiting_customer" },
        { waitEvent: true },
      ],
    },
  ],
})

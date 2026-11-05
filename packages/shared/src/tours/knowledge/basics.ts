// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge: what the company knows, where it lives, how a document gets
 * written (with the agent) and edited, and who sees it.
 */
import { defineTour } from "../schema"

const k = (path: string) => `tours.knowledge.basics.${path}`

/** The document the create beat made: the edit works on it, never on someone's existing one. */
const CREATED_DOC = { beat: "create", attr: "data-document-id" } as const

export const knowledgeBasicsTour = defineTour({
  id: "knowledge.basics",
  app: "knowledge",
  title: k("title"),
  summary: k("summary"),
  beats: [
    {
      id: "home",
      kind: "show",
      title: k("home.title"),
      body: k("home.body"),
      anchor: "knowledge-home",
      route: "/knowledge",
    },
    {
      id: "collections",
      kind: "show",
      title: k("collections.title"),
      body: k("collections.body"),
      anchor: "knowledge-home-collections",
      route: "/knowledge",
    },
    {
      id: "create",
      kind: "do",
      title: k("create.title"),
      body: k("create.body"),
      anchor: "knowledge-home-create-from-cta",
      route: "/knowledge",
      // The agent writes the document from what the person gives it.
      event: { app: "knowledge", entity: "document", action: "create", actor: "user-or-agent" },
      autoplay: [{ click: "knowledge-home-create-from-cta" }, { waitEvent: true }],
    },
    {
      id: "recent",
      kind: "show",
      title: k("recent.title"),
      body: k("recent.body"),
      anchor: "knowledge-home-recently-touched",
      route: "/knowledge",
    },
    {
      id: "edit",
      kind: "do",
      title: k("edit.title"),
      body: k("edit.body"),
      anchor: "knowledge-doc-edit",
      event: { app: "knowledge", entity: "document", action: "update", actor: "user-or-agent" },
      // Only the document this tour created. When the create beat was skipped
      // there is none, and "Do it for me" stops: the person picks what to edit.
      autoplay: [
        // From the home (the scenario playing on), open that document first.
        {
          click: { testid: "knowledge-recent-*", created: CREATED_DOC },
          unlessVisible: { testid: "knowledge-document-view", created: CREATED_DOC },
        },
        { waitFor: { testid: "knowledge-document-view", created: CREATED_DOC } },
        { click: "knowledge-doc-edit" },
        { waitFor: "knowledge-doc-body-editor" },
        // Added to the document, never over it.
        {
          type: {
            testid: "knowledge-doc-body-editor",
            text: "tours.knowledge.basics.edit.text",
            append: true,
          },
        },
        { click: "knowledge-doc-save" },
        { waitEvent: true },
      ],
    },
    {
      id: "share",
      kind: "show",
      title: k("share.title"),
      body: k("share.body"),
      anchor: "knowledge-share-button",
    },
    {
      id: "agents",
      kind: "show",
      title: k("agents.title"),
      body: k("agents.body"),
    },
  ],
})

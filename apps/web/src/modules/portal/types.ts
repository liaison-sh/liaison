// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the portal's routes answer, as the page reads it. A part that could not
// be read is null (R-10: that part says so, the rest of the page stands).

export interface PortalMe {
  id: string
  name: string
  email: string
  locale: string | null
  timezone: string | null
  contactName: string | null
  /** The notice version the person acknowledged, or null. */
  noticeVersion?: number | null
}

export interface PortalProject {
  id: string
  name: string
  ownerName: string | null
}

export interface PortalInvoice {
  id: string
  type: string
  number: string | null
  status: string
  paymentStatus: string | null
  currency: string | null
  grandTotalMinor: string | null
  issuedAt: string | null
  dueAt: string | null
  paidAt: string | null
  originalDocumentId: string | null
  label: string | null
  hasPdf: boolean
}

export interface PortalUpcoming {
  label: string | null
  amountMinor: string | null
  currency: string | null
  dueOn: string | null
}

export interface PortalMessage {
  id: string
  kind: "inbound" | "outbound" | string
  fromName: string | null
  authorLabel: string | null
  textBody: string | null
  sentAt: string | null
}

export interface PortalRequest {
  id: string
  subject: string | null
  status: string
  createdAt: string | null
  lastMessageAt: string | null
  messages: PortalMessage[] | null
}

export interface PortalHome {
  me: PortalMe | null
  projects: PortalProject[] | null
  invoices: PortalInvoice[] | null
  upcoming: PortalUpcoming[] | null
  requests: PortalRequest[] | null
  /** Whether the company may send requests here. */
  requestsOpen?: boolean
  unavailable: string[]
}

export interface PortalStep {
  id: string
  title: string
  state: "done" | "open" | string
  doneShare: number | null
  dueOn: string | null
}

export interface PortalProjectDetail extends PortalProject {
  steps: PortalStep[] | null
  /** False when the project is listed without its progress open: its steps are not shown. */
  stepsShown?: boolean
  hours: {
    kind: string
    usedMinutes: number
    ofMinutes: number | null
    period: string | null
  } | null
  /** Why no hours show: the project bills by milestone. Null otherwise, a closed share included. */
  hoursNote?: "by_milestone" | null
}

export interface PortalDocument {
  id: string
  number: string | null
  kind: string | null
  title: string | null
  status: string | null
  signedAt: string | null
}

export interface PortalAction {
  id: string
  kind: "sign" | "accept" | "approve" | string
  invitedName: string | null
  expiresAt: string | null
  decidedAt: string | null
  decision: string | null
  revokedAt: string | null
  mine: boolean
  words?: string
}

export interface PortalDocumentDetail extends PortalDocument {
  versions: Array<{
    id: string
    number: number
    hasFile: boolean
    pageCount: number
    /** The frozen source: a generated version's blocks are in `body.blocks`. */
    source?: unknown
  }> | null
  evidence: Array<{
    versionId: string
    signedPdfFileId: string | null
    copyFileId: string | null
    sealedAt: string | null
  }> | null
  actions: PortalAction[] | null
}

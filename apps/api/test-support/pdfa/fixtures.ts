// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared fixtures for the kernel PDF/A tests: a draw-command program, an extension schema, a
// small embedded XML, a CMYK JPEG header and a renderer call producing a PDF/A-3B sample.

import type { DrawCommand } from "@liaison/shared"
import type { XmpExtension } from "../../src/modules/pdf/pdfa/xmp"
import { replayDrawCommands } from "../../src/modules/pdf/replay"

const LOGO_ID = "5b9f6e1e-9d1c-4a3a-8f0e-9c1a2b3c4d5e"

export const PDFA_COMMANDS: DrawCommand[] = [
  {
    op: "setMetadata",
    title: "Invoice FA-1",
    producer: "Liaison Invoicing",
    creator: "Liaison Invoicing",
  },
  { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
  { op: "embedFont", ref: "f2", standardFont: "HelveticaBold" },
  { op: "addPage", width: 595, height: 842 },
  {
    op: "drawText",
    page: 0,
    text: "Facture FA-1 — Société Générale Ł",
    x: 40,
    y: 800,
    size: 12,
    font: "f2",
  },
  { op: "drawText", page: 0, text: "Total 120,00 €", x: 40, y: 780, size: 10, font: "f1" },
  { op: "drawLine", page: 0, start: { x: 40, y: 770 }, end: { x: 555, y: 770 }, thickness: 0.5 },
  { op: "embedImage", ref: "logo", fileId: LOGO_ID },
  { op: "drawImage", page: 0, ref: "logo", x: 400, y: 820, maxWidth: 100, maxHeight: 40 },
]

export const SAMPLE_EXTENSION: XmpExtension = {
  schema: "Factur-X PDFA Extension Schema",
  namespaceUri: "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#",
  prefix: "fx",
  properties: [
    {
      name: "DocumentFileName",
      value: "factur-x.xml",
      description: "name of the embedded XML invoice",
    },
    { name: "DocumentType", value: "INVOICE", description: "type of the hybrid document" },
    { name: "Version", value: "1.0", description: "version of the standard" },
    { name: "ConformanceLevel", value: "EN 16931", description: "conformance level of the XML" },
  ],
}

export const SAMPLE_XML = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8"?><rsm:CrossIndustryInvoice/>',
)

export const EXPECT = {
  attachments: [{ name: "factur-x.xml", mime: "text/xml", afRelationship: "Data" }],
  xmpExtensions: [
    {
      namespaceUri: SAMPLE_EXTENSION.namespaceUri,
      prefix: "fx",
      values: {
        DocumentFileName: "factur-x.xml",
        DocumentType: "INVOICE",
        Version: "1.0",
        ConformanceLevel: "EN 16931",
      },
    },
  ],
}

/** A 1x1 CMYK baseline JPEG header (frame declares 4 components). */
export const CMYK_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x14, 0x08, 0x00, 0x01, 0x00, 0x01, 0x04, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0x04, 0x11, 0x00, 0xff, 0xd9,
])

export async function renderSamplePdfA(
  over: { commands?: DrawCommand[]; image?: { bytes: Uint8Array; mime: string } } = {},
) {
  return replayDrawCommands(over.commands ?? PDFA_COMMANDS, {
    resolveImage: async () => over.image ?? null,
    pdfa: {
      level: "3b",
      attachments: [
        {
          name: "factur-x.xml",
          mime: "text/xml",
          bytes: SAMPLE_XML,
          afRelationship: "Data",
          description: "Factur-X invoice",
        },
      ],
      xmpExtensions: [SAMPLE_EXTENSION],
      now: new Date("2026-11-03T10:15:00Z"),
    },
  })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PDF template fixture used by render.test.ts.
//
// Templates are sandbox-executable bundles that set `globalThis.renderTemplate`
// to a function returning a JSON draw-command list (see
// packages/shared/src/pdf/commands.ts). The kernel runs the bundle inside the
// QuickJS app sandbox and replays the commands against pdf-lib on the host
// (modules/pdf/replay.ts). We hand-author the bundle as a string literal so it
// is trivially loadable from any environment.

export const TEST_FIXTURE_SOURCE = `
globalThis.renderTemplate = (data) => ([
  { op: "setMetadata", title: (data && data.title) ? String(data.title) : "Hello, World" },
  { op: "embedFont", ref: "f", standardFont: "Helvetica" },
  { op: "addPage", width: 300, height: 200 },
  {
    op: "drawText",
    page: 0,
    text: (data && data.title) ? String(data.title) : "Hello, World",
    x: 20,
    y: 100,
    size: 18,
    font: "f",
  },
]);
`

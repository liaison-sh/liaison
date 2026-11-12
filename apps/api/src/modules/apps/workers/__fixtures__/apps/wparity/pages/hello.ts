// SPDX-License-Identifier: FSL-1.1-ALv2
// The parity fixture's page: proves a page script is built into the package.
// (The api's tsconfig has no DOM lib: the browser globals are typed locally.)
const page = globalThis as unknown as { document: { title: string } }
page.document.title = "wparity"

export {}

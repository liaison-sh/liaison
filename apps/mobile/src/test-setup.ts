// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mobile shell's code runs in a webview, so its tests need a DOM. This is
// the one place that registers one (bunfig.toml preloads it): the registrator
// throws on a second call, so a test file that registers for itself breaks
// every other file in the package the day a second one does the same.

import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

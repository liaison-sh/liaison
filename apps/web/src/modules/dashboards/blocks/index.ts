// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dashboard block renderers, reusable outside the dashboard tab (an app
// view may embed a block the same way).
export type { BlockCardProps } from "./BlockCard"
export { BlockCard } from "./BlockCard"
export type { BlockRendererProps } from "./BlockRenderer"
export { BlockRenderer } from "./BlockRenderer"
export type { ChartDataset, ChartKind, ChartProps } from "./Chart"
export { Chart, chartConfig, loadChartJs } from "./Chart"
export { formatAxisLabel, formatValue } from "./format"
export type { MetricBlockProps } from "./MetricBlock"
export { MetricBlock } from "./MetricBlock"
export type { TableBlockProps } from "./TableBlock"
export { TableBlock } from "./TableBlock"

// SPDX-License-Identifier: FSL-1.1-ALv2
import { Mail } from "lucide-solid"
import type { Component } from "solid-js"

export const MailIcon: Component<{ size?: number }> = (props) => (
  <Mail size={Math.max(props.size ?? 20, 16)} />
)

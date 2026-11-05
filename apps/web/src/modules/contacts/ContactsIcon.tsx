// SPDX-License-Identifier: FSL-1.1-ALv2
import { Users } from "lucide-solid"
import type { Component } from "solid-js"

export const ContactsIcon: Component<{ size?: number }> = (props) => (
  <Users size={props.size ?? 16} />
)

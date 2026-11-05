// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The glyph an entity row leads with, shared by every surface that lists
// entities of mixed kinds (search results, the mention picker). A row is read
// by its shape before its text, so two different kinds must never draw the
// same mark: the mention picker fell back to the channel hash for everything
// that was not a person, a channel or an approval, which put a `#` on task
// rows and made a task read as a channel.
//
// Unknown kinds fall back to the generic document mark rather than to nothing.
import {
  Calendar,
  Contact,
  FileText,
  ListTodo,
  Mail,
  MessageSquare,
  Ticket,
  User,
} from "lucide-solid"

export function entityIcon(entityType: string) {
  switch (entityType) {
    case "thread":
    case "message":
      return MessageSquare
    case "conversation":
    case "mail":
      return Mail
    case "ticket":
      return Ticket
    case "task":
      return ListTodo
    // A contact is an outside person on file, not a colleague: it draws the
    // address-card mark, so a `#` contact row never reads as a member.
    case "contact":
      return Contact
    case "user":
      return User
    case "event":
      return Calendar
    default:
      return FileText
  }
}

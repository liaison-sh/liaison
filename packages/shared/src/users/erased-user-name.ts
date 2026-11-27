// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The name an erased person's row carries.
//
// Erasure (the API's `erase-user.ts`) tombstones a `kernel.users` row instead
// of deleting it, and keeps the messages, notes and comments the person wrote
// in shared spaces. Their author name used to be set to the email placeholder
// ("deleted-user-<uuid>"), which every thread, ticket and task then printed.
// The row now carries this neutral name (it holds no personal data), and the
// web prints the reader's own word for it ("Utilisateur supprimé") wherever a
// person's name renders. The email stays the non-routable placeholder: that is
// what marks the row as erased (`erasedUserEmail`).

export const ERASED_USER_DISPLAY_NAME = "Deleted user"

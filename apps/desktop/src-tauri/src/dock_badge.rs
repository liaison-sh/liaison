// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE APP ICON'S UNREAD BADGE: how many direct messages and mentions are
// waiting, counted by the page (apps/web modules/notifications/desktop-badge.ts)
// and handed over through `set_unread_badge`. Channel traffic that names
// nobody is not in it. Zero takes the badge down.
//
// - macOS: the dock tile's badge (Tauri `set_badge_count`, the number itself).
// - Linux: the launcher entry's count (the same call, through the Unity
//   launcher API that GNOME's and KDE's docks read).
// - Windows: the taskbar has no count, so an OVERLAY ICON carries it: a red
//   disc with the digit for 1 to 9, the plain disc above 9.

// Each platform uses one half: the overlay is Windows only, the count the rest.
// Both halves are compiled and tested everywhere.
#![cfg_attr(not(test), allow(dead_code))]

use tauri::{AppHandle, Manager, Runtime};

/// What the Windows taskbar overlay shows for a count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overlay {
    /// No overlay at all: nothing is unread.
    None,
    /// The red disc with this digit (1 to 9).
    Digit(u8),
    /// The red disc alone: more than nine.
    Dot,
}

/// The dock and launcher badge for a count: none at zero.
pub fn badge_count(unread: u32) -> Option<i64> {
    (unread > 0).then(|| i64::from(unread))
}

/// The overlay for a count.
pub fn overlay_for(unread: u32) -> Overlay {
    match unread {
        0 => Overlay::None,
        1..=9 => Overlay::Digit(unread as u8),
        _ => Overlay::Dot,
    }
}

/// The overlay is drawn square at this many pixels; Windows scales it down.
pub const OVERLAY_SIZE: u32 = 32;
/// The badge red (the web tab badge's `--color-danger`, #e5484d).
const DISC: [u8; 4] = [0xe5, 0x48, 0x4d, 0xff];
const INK: [u8; 4] = [0xff, 0xff, 0xff, 0xff];
/// Each glyph cell is a SCALE x SCALE square.
const SCALE: u32 = 4;

/// The digits, three columns by five rows, the top bit the left column.
const GLYPHS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// Whether the glyph of `digit` inks the pixel at (x, y) of the overlay.
fn glyph_inks(digit: u8, x: u32, y: u32) -> bool {
    let width = 3 * SCALE;
    let height = 5 * SCALE;
    let left = (OVERLAY_SIZE - width) / 2;
    let top = (OVERLAY_SIZE - height) / 2;
    if x < left || x >= left + width || y < top || y >= top + height {
        return false;
    }
    let column = (x - left) / SCALE;
    let row = (y - top) / SCALE;
    let bits = GLYPHS[usize::from(digit % 10)][row as usize];
    bits & (0b100 >> column) != 0
}

/// The overlay's RGBA pixels, row by row, OVERLAY_SIZE square; None for no
/// overlay.
pub fn overlay_pixels(overlay: Overlay) -> Option<Vec<u8>> {
    let digit = match overlay {
        Overlay::None => return None,
        Overlay::Digit(digit) => Some(digit),
        Overlay::Dot => None,
    };
    let size = OVERLAY_SIZE;
    let centre = size as f32 / 2.0;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - centre;
            let dy = y as f32 + 0.5 - centre;
            let colour = if dx * dx + dy * dy > centre * centre {
                [0, 0, 0, 0]
            } else if digit.is_some_and(|digit| glyph_inks(digit, x, y)) {
                INK
            } else {
                DISC
            };
            pixels.extend_from_slice(&colour);
        }
    }
    Some(pixels)
}

/// What the shell puts on the app icon for a count: the number itself on the
/// macOS dock and the Linux launcher, an overlay image on the Windows taskbar
/// (which has no count). `None` in either takes the badge down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BadgeUpdate {
    /// `set_badge_count` with this value.
    Count(Option<i64>),
    /// `set_overlay_icon` with these RGBA pixels, OVERLAY_SIZE square.
    Overlay(Option<Vec<u8>>),
}

/// The badge update for `unread` on a platform: `windows` picks the overlay.
pub fn badge_update(unread: u32, windows: bool) -> BadgeUpdate {
    if windows {
        BadgeUpdate::Overlay(overlay_pixels(overlay_for(unread)))
    } else {
        BadgeUpdate::Count(badge_count(unread))
    }
}

/// Sets the app icon's badge to `count` unread direct messages and mentions
/// (zero clears it). Never fails the page: a platform without a badge, or a
/// window not there yet, costs the badge only.
#[tauri::command]
pub fn set_unread_badge<R: Runtime>(app: AppHandle<R>, count: u32) {
    let Some(window) = app.get_webview_window(crate::tray::MAIN_WINDOW) else {
        return;
    };
    match badge_update(count, cfg!(target_os = "windows")) {
        BadgeUpdate::Overlay(rgba) => {
            #[cfg(target_os = "windows")]
            {
                let icon = rgba
                    .map(|rgba| tauri::image::Image::new_owned(rgba, OVERLAY_SIZE, OVERLAY_SIZE));
                let _ = window.set_overlay_icon(icon);
            }
            #[cfg(not(target_os = "windows"))]
            let _ = rgba;
        }
        BadgeUpdate::Count(value) => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = window.set_badge_count(value);
            }
            #[cfg(target_os = "windows")]
            let _ = value;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_clears_the_badge_and_any_other_count_is_shown_as_is() {
        assert_eq!(badge_count(0), None);
        assert_eq!(badge_count(1), Some(1));
        assert_eq!(badge_count(42), Some(42));
        assert_eq!(badge_count(u32::MAX), Some(i64::from(u32::MAX)));
    }

    #[test]
    fn the_windows_overlay_is_none_a_digit_up_to_nine_then_a_dot() {
        assert_eq!(overlay_for(0), Overlay::None);
        assert_eq!(overlay_for(1), Overlay::Digit(1));
        assert_eq!(overlay_for(9), Overlay::Digit(9));
        assert_eq!(overlay_for(10), Overlay::Dot);
        assert_eq!(overlay_for(500), Overlay::Dot);
    }

    #[test]
    fn windows_gets_the_overlay_and_every_other_platform_the_count() {
        // Windows: an overlay image for a count, none at zero (which clears it).
        assert_eq!(badge_update(0, true), BadgeUpdate::Overlay(None));
        assert_eq!(
            badge_update(3, true),
            BadgeUpdate::Overlay(overlay_pixels(Overlay::Digit(3)))
        );
        assert_eq!(
            badge_update(12, true),
            BadgeUpdate::Overlay(overlay_pixels(Overlay::Dot))
        );
        // macOS and Linux: the number itself, none at zero.
        assert_eq!(badge_update(0, false), BadgeUpdate::Count(None));
        assert_eq!(badge_update(3, false), BadgeUpdate::Count(Some(3)));
        assert_eq!(badge_update(12, false), BadgeUpdate::Count(Some(12)));
    }

    #[test]
    fn this_build_takes_its_own_platform_arm() {
        let windows = cfg!(target_os = "windows");
        match badge_update(1, windows) {
            BadgeUpdate::Overlay(_) => assert!(windows, "only Windows draws an overlay"),
            BadgeUpdate::Count(_) => assert!(!windows, "Windows has no badge count"),
        }
    }

    fn pixel(pixels: &[u8], x: u32, y: u32) -> [u8; 4] {
        let at = ((y * OVERLAY_SIZE + x) * 4) as usize;
        [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
    }

    #[test]
    fn no_overlay_has_no_pixels_and_an_overlay_is_a_square_rgba_image() {
        assert_eq!(overlay_pixels(Overlay::None), None);
        for overlay in [Overlay::Dot, Overlay::Digit(3)] {
            let pixels = overlay_pixels(overlay).expect("an overlay is drawn");
            assert_eq!(pixels.len(), (OVERLAY_SIZE * OVERLAY_SIZE * 4) as usize);
            // A disc: corners clear, the edge midpoints red.
            assert_eq!(pixel(&pixels, 0, 0)[3], 0);
            assert_eq!(pixel(&pixels, OVERLAY_SIZE - 1, OVERLAY_SIZE - 1)[3], 0);
            assert_eq!(pixel(&pixels, 1, OVERLAY_SIZE / 2), DISC);
            assert_eq!(pixel(&pixels, OVERLAY_SIZE / 2, 1), DISC);
        }
    }

    #[test]
    fn the_dot_has_no_ink_and_each_digit_draws_its_own_glyph() {
        let ink = |overlay| {
            overlay_pixels(overlay)
                .expect("drawn")
                .chunks(4)
                .filter(|colour| *colour == INK)
                .count()
        };
        assert_eq!(ink(Overlay::Dot), 0);
        let cell = (SCALE * SCALE) as usize;
        // 1: a stem of five cells, its flag and a foot of two more (8 cells).
        assert_eq!(ink(Overlay::Digit(1)), 8 * cell);
        // 8: every cell but the two holes (13 cells).
        assert_eq!(ink(Overlay::Digit(8)), 13 * cell);
        let one = overlay_pixels(Overlay::Digit(1)).expect("drawn");
        let seven = overlay_pixels(Overlay::Digit(7)).expect("drawn");
        assert_ne!(one, seven);
    }
}

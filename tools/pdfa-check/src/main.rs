// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only PDF/A smoke check: runs oxidize-pdf's `PdfAValidator` (MIT) at one level over each
// file given on the command line and prints one JSON line per file:
//   {"file":"…","valid":true|false,"parse_error":null|"…","errors":[{"code":"…","message":"…"}]}
// Usage: pdfa-check [--level 3b|2b|3a|3u|2a|2u|1b|1a] <file.pdf>...
// Exit status: 0 when every file is valid, 1 otherwise, 2 on bad usage.

use oxidize_pdf::parser::PdfReader;
use oxidize_pdf::pdfa::{PdfALevel, PdfAValidator};

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

fn level(s: &str) -> Option<PdfALevel> {
    Some(match s {
        "1a" => PdfALevel::A1a,
        "1b" => PdfALevel::A1b,
        "2a" => PdfALevel::A2a,
        "2b" => PdfALevel::A2b,
        "2u" => PdfALevel::A2u,
        "3a" => PdfALevel::A3a,
        "3b" => PdfALevel::A3b,
        "3u" => PdfALevel::A3u,
        _ => return None,
    })
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut lvl = PdfALevel::A3b;
    if args.len() >= 2 && args[0] == "--level" {
        match level(&args[1]) {
            Some(l) => lvl = l,
            None => {
                eprintln!("unknown level {}", args[1]);
                std::process::exit(2);
            }
        }
        args.drain(0..2);
    }
    if args.is_empty() {
        eprintln!("usage: pdfa-check [--level 3b] <file.pdf>...");
        std::process::exit(2);
    }
    let mut all_valid = true;
    for file in &args {
        let outcome = std::panic::catch_unwind(|| match PdfReader::open(file) {
            Err(e) => (false, Some(format!("{}", e)), Vec::new()),
            Ok(mut reader) => match PdfAValidator::new(lvl).validate(&mut reader) {
                Err(e) => (false, Some(format!("{}", e)), Vec::new()),
                Ok(r) => {
                    let errs: Vec<(String, String)> = r
                        .errors()
                        .iter()
                        .map(|e| {
                            let dbg = format!("{:?}", e);
                            let code = dbg.split(|c| c == ' ' || c == '{' || c == '(').next().unwrap_or("").to_string();
                            (code, format!("{}", e))
                        })
                        .collect();
                    (r.is_valid(), None, errs)
                }
            },
        });
        let (valid, parse_error, errors) = outcome.unwrap_or((false, Some("validator panicked".to_string()), Vec::new()));
        if !valid {
            all_valid = false;
        }
        let errs = errors
            .iter()
            .map(|(c, m)| format!("{{\"code\":\"{}\",\"message\":\"{}\"}}", esc(c), esc(m)))
            .collect::<Vec<_>>()
            .join(",");
        let pe = parse_error.map(|p| format!("\"{}\"", esc(&p))).unwrap_or_else(|| "null".to_string());
        println!("{{\"file\":\"{}\",\"valid\":{},\"parse_error\":{},\"errors\":[{}]}}", esc(file), valid, pe, errs);
    }
    std::process::exit(if all_valid { 0 } else { 1 });
}

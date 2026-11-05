// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH PERMISSION ANSWERS THE PAGE MAY GIVE, AND WHICH ONLY THE SHELL MAY.
//
// The page is not a boundary: any script that runs in the desktop window
// reaches the shell's commands and hears every broadcast event, including the
// `permission_request` lines a local session (or a node chat) asks. A request
// id it heard is therefore one it can answer. For a Liaison tool that is
// acceptable: the server gates those calls itself, and the in-page card stays.
// For a call that acts on THIS computer outside Liaison's reach (a shell
// command, a file written outside the session's folder or into a file that runs
// code later, a tool of some other MCP server), an allow is only written after
// the shell's own native dialog, drawn from the sidecar's own words, says yes.
// The page can ask for that dialog; it cannot answer it.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Tools the page may answer: they read, plan or ask, and change nothing on
/// this computer. Anything not named here (and not a Liaison tool or a write
/// inside the folder) is the shell's to confirm: fail closed.
pub const PAGE_ANSWERABLE_TOOLS: [&str; 17] = [
    "Read",
    "Glob",
    "Grep",
    "LS",
    "NotebookRead",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "TodoRead",
    "Task",
    "Agent",
    "ExitPlanMode",
    "AskUserQuestion",
    "BashOutput",
    "KillShell",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
];

/// The Liaison MCP server's tools (sdk-runner.ts names the server `liaison`).
pub const LIAISON_TOOL_PREFIX: &str = "mcp__liaison__";

/// Tools that write a file, and the input field naming it (auto-policy.ts
/// `FILE_WRITE_TOOLS`).
pub const FILE_WRITE_TOOLS: [(&str, &str); 4] = [
    ("Write", "file_path"),
    ("Edit", "file_path"),
    ("MultiEdit", "file_path"),
    ("NotebookEdit", "notebook_path"),
];

/// Directories whose files configure or run code (auto-policy.ts
/// `RUNNABLE_DIRS`): a write there is a command that runs later.
pub const RUNNABLE_DIRS: [&str; 14] = [
    ".git",
    ".husky",
    ".githooks",
    ".github",
    ".gitlab",
    ".circleci",
    ".buildkite",
    ".devcontainer",
    ".vscode",
    ".idea",
    ".claude",
    ".cursor",
    ".codex",
    ".gemini",
];

/// Files a build, a package manager or the shell runs (auto-policy.ts
/// `RUNNABLE_FILES`).
pub const RUNNABLE_FILES: [&str; 50] = [
    "package.json",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "bunfig.toml",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "noxfile.py",
    "conftest.py",
    "Pipfile",
    "Makefile",
    "makefile",
    "GNUmakefile",
    "justfile",
    "Justfile",
    ".justfile",
    "Taskfile.yml",
    "Taskfile.yaml",
    "Rakefile",
    "Gemfile",
    "Cargo.toml",
    "build.rs",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "pom.xml",
    "CMakeLists.txt",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    ".envrc",
    ".env",
    ".gitattributes",
    ".gitmodules",
    ".pre-commit-config.yaml",
    ".gitlab-ci.yml",
    "Jenkinsfile",
    "azure-pipelines.yml",
    ".travis.yml",
    "lefthook.yml",
    ".lefthook.yml",
    ".bashrc",
    ".zshrc",
    ".profile",
    ".bash_profile",
];

/// What the shell's own dialog says about one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellAsk {
    pub title: String,
    pub message: String,
    /// False when the dialog could not show the whole call (a command or an
    /// input longer than it shows): what the person did not see cannot be
    /// allowed, so the call is denied without a dialog, and the agent is told
    /// why.
    pub allowable: bool,
}

impl ShellAsk {
    fn allowable(title: impl Into<String>, message: String) -> Self {
        Self {
            title: title.into(),
            message,
            allowable: true,
        }
    }
}

/// The longest stretch of a tool's input a dialog shows.
const DETAIL_LIMIT: usize = 900;

/// Whether the dialog shows `text` whole.
fn shown_whole(text: &str) -> bool {
    text.chars().count() <= DETAIL_LIMIT
}

/// The answer to the agent when a call is longer than the dialog shows.
pub fn too_long_to_confirm(what: &str, length: usize) -> String {
    format!(
        "denied: the {what} is {length} characters, longer than this computer's confirmation \
         shows in full ({DETAIL_LIMIT}); nothing unseen is allowed, so run it in shorter steps"
    )
}

/// The real location of a path that may not exist yet, resolved one component
/// at a time the way the system walks it: each existing prefix with its
/// symlinks followed before the next `..` applies (so `link/..` is the parent
/// of where the link points, not the folder the link sits in), and whatever
/// does not exist yet appended as written.
fn real_location(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Prefix(_) | Component::RootDir => out.push(part.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                out.push(name);
                if let Ok(real) = out.canonicalize() {
                    out = real;
                }
            }
        }
    }
    out
}

/// Where a write tool writes, relative to `folder` when it is inside it.
/// `Err(target)` when it is outside (or the folder is unknown).
fn write_target(path: &str, folder: Option<&Path>) -> Result<PathBuf, PathBuf> {
    let Some(folder) = folder else {
        return Err(PathBuf::from(path));
    };
    let raw = Path::new(path);
    let absolute = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        folder.join(raw)
    };
    let target = real_location(&absolute);
    let root = real_location(folder);
    match target.strip_prefix(&root) {
        Ok(inside) if !inside.as_os_str().is_empty() => Ok(inside.to_path_buf()),
        _ => Err(target),
    }
}

/// True when a path inside the folder is a file that runs code later.
pub fn runs_later(relative: &Path) -> bool {
    let parts: Vec<String> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let Some((name, dirs)) = parts.split_last() else {
        return true;
    };
    RUNNABLE_FILES.contains(&name.as_str())
        || name.starts_with(".env.")
        || dirs.iter().any(|dir| RUNNABLE_DIRS.contains(&dir.as_str()))
}

/// None when the page may answer this call (the in-page card); otherwise the
/// question the shell asks before an allow is written.
pub fn shell_confirmation(
    tool: &str,
    input: &serde_json::Value,
    folder: Option<&Path>,
) -> Option<ShellAsk> {
    if tool.starts_with(LIAISON_TOOL_PREFIX) || PAGE_ANSWERABLE_TOOLS.contains(&tool) {
        return None;
    }
    let where_ = folder
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| "this computer".to_string());
    if let Some((_, field)) = FILE_WRITE_TOOLS.iter().find(|(name, _)| *name == tool) {
        let path = input.get(*field).and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return Some(ShellAsk::allowable(
                "Allow a file change",
                format!("The agent asks to use {tool} on a file it does not name. Allow it?"),
            ));
        }
        return match write_target(path, folder) {
            Ok(inside) if !runs_later(&inside) => None,
            Ok(inside) => Some(ShellAsk::allowable(
                "Allow a file that runs code",
                format!(
                    "The agent asks to change {}, in {where_}. This file runs or configures code \
                     later (a hook, a build or a package script). Allow it?",
                    inside.display()
                ),
            )),
            Err(target) => Some(ShellAsk::allowable(
                "Allow a file change outside the folder",
                format!(
                    "The agent asks to change {}, outside the session's folder {where_}. Allow it?",
                    target.display()
                ),
            )),
        };
    }
    if tool == "Bash" {
        let command = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if !shown_whole(command) {
            return Some(ShellAsk {
                title: "Allow a command".into(),
                message: too_long_to_confirm("command", command.chars().count()),
                allowable: false,
            });
        }
        return Some(ShellAsk::allowable(
            "Allow a command",
            format!("The agent asks to run this command in {where_}:\n\n{command}\n\nAllow it?"),
        ));
    }
    let shown = serde_json::to_string_pretty(input).unwrap_or_default();
    if !shown_whole(&shown) {
        return Some(ShellAsk {
            title: "Allow a tool".into(),
            message: too_long_to_confirm(&format!("input to {tool}"), shown.chars().count()),
            allowable: false,
        });
    }
    Some(ShellAsk::allowable(
        "Allow a tool",
        format!("The agent asks to use {tool} on this computer with:\n\n{shown}\n\nAllow it?"),
    ))
}

/// The prompts only the shell's dialog may allow, by request id, and a
/// generation that moves every time the prompts are retired (a turn ended, the
/// session stopped or was replaced). Request ids are a per-process counter
/// (`perm-1`, `perm-2`, ...), so a dialog answered after its session ended
/// must not answer the next session's prompt of the same name.
#[derive(Default)]
pub struct ShellAskBook {
    asks: HashMap<String, (ShellAsk, u64)>,
    generation: u64,
}

impl ShellAskBook {
    pub fn record(&mut self, request_id: String, ask: ShellAsk) {
        let generation = self.generation;
        self.asks.insert(request_id, (ask, generation));
    }

    /// Takes one prompt for a dialog: the second caller finds nothing, so one
    /// prompt never shows two dialogs.
    pub fn take(&mut self, request_id: &str) -> Option<(ShellAsk, u64)> {
        self.asks.remove(request_id)
    }

    /// Whether a prompt taken at `generation` is still one the session waits
    /// on: nothing was retired since.
    pub fn still_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    pub fn retire_all(&mut self) {
        self.asks.clear();
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn drain(&mut self) -> Vec<String> {
        self.asks.drain().map(|(id, _)| id).collect()
    }
}

/// What one protocol line does to the two sets of open prompts.
#[derive(Debug, PartialEq, Eq)]
pub enum PromptEffect {
    /// A prompt the page may answer (its in-page card).
    PageAnswerable(String),
    /// A prompt only the shell's own dialog may allow.
    ShellConfirmed(String, ShellAsk),
    /// The turn (or the process) ended: nothing can still be answered.
    RetireAll,
    Nothing,
}

/// Reads one sidecar line for its effect. `tool` is `toolName` (a local
/// session, a node chat) or `tool` (an unattended job's line).
pub fn prompt_effect(line: &str, folder: Option<&Path>) -> PromptEffect {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
        return PromptEffect::Nothing;
    };
    match parsed.get("type").and_then(|value| value.as_str()) {
        Some("permission_request") => {
            let Some(id) = parsed
                .get("requestId")
                .and_then(|id| id.as_str())
                .filter(|id| !id.is_empty())
            else {
                return PromptEffect::Nothing;
            };
            let tool = parsed
                .get("toolName")
                .or_else(|| parsed.get("tool"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            let input = parsed
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            match shell_confirmation(tool, &input, folder) {
                None => PromptEffect::PageAnswerable(id.to_string()),
                Some(ask) => PromptEffect::ShellConfirmed(id.to_string(), ask),
            }
        }
        // A parked tool call cannot outlive its turn.
        Some("turn_done") | Some("done") | Some("job_done") => PromptEffect::RetireAll,
        _ => PromptEffect::Nothing,
    }
}

/// Records one line's effect in the page's set and the shell's book.
pub fn record_prompt_line(
    page: &Mutex<HashSet<String>>,
    shell: &Mutex<ShellAskBook>,
    folder: Option<&Path>,
    line: &str,
) {
    match prompt_effect(line, folder) {
        PromptEffect::PageAnswerable(id) => {
            if let Ok(mut open) = page.lock() {
                open.insert(id);
            }
        }
        PromptEffect::ShellConfirmed(id, ask) => {
            if let Ok(mut book) = shell.lock() {
                book.record(id, ask);
            }
        }
        PromptEffect::RetireAll => {
            if let Ok(mut open) = page.lock() {
                open.clear();
            }
            if let Ok(mut book) = shell.lock() {
                book.retire_all();
            }
        }
        PromptEffect::Nothing => {}
    }
}

pub fn retire_all(page: &Mutex<HashSet<String>>, shell: &Mutex<ShellAskBook>) {
    if let Ok(mut open) = page.lock() {
        open.clear();
    }
    if let Ok(mut book) = shell.lock() {
        book.retire_all();
    }
}

/// The answer the shell writes for one prompt.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Denied, with the message the agent is told.
    Deny(Option<String>),
}

/// The refusal for an id nobody is waiting on (`sidecar.rs` names it too).
pub const UNKNOWN_REQUEST: &str = "UnknownPermissionRequest";

/// DECIDES ONE ANSWER THE PAGE SENT, with the shell's dialog injected so both
/// of its answers are drivable without a window.
///
/// - an id the page may answer: its answer stands, once;
/// - an id only the shell may allow: a deny stands (the worst a page deny does
///   is stop a call), an allow stands only when `confirm` (the shell's own
///   dialog) says yes, else it becomes a deny;
/// - any other id is refused.
///
/// `still_current` is asked AFTER the dialog: a prompt whose turn ended while
/// the dialog was up is answered by nobody.
pub fn decide<C>(
    page: &Mutex<HashSet<String>>,
    shell: &Mutex<ShellAskBook>,
    request_id: &str,
    allow: bool,
    message: Option<String>,
    confirm: C,
) -> Result<Decision, &'static str>
where
    C: FnOnce(&ShellAsk) -> bool,
{
    let page_answerable = page
        .lock()
        .map(|mut open| open.remove(request_id))
        .unwrap_or(false);
    if page_answerable {
        return Ok(if allow {
            Decision::Allow
        } else {
            Decision::Deny(message)
        });
    }
    let taken = shell.lock().ok().and_then(|mut book| book.take(request_id));
    let Some((ask, generation)) = taken else {
        return Err(UNKNOWN_REQUEST);
    };
    if !allow {
        return Ok(Decision::Deny(message));
    }
    // A call the dialog cannot show whole is never allowed: no dialog, and the
    // agent learns why.
    if !ask.allowable {
        return Ok(Decision::Deny(Some(ask.message)));
    }
    let confirmed = confirm(&ask);
    let current = shell
        .lock()
        .map(|book| book.still_current(generation))
        .unwrap_or(false);
    if !current {
        return Err(UNKNOWN_REQUEST);
    }
    Ok(if confirmed {
        Decision::Allow
    } else {
        Decision::Deny(Some("denied in this computer's confirmation".into()))
    })
}

/// One native dialog at a time: two prompts asked together are two questions
/// the person answers in turn, never two sheets stacked on each other.
static DIALOG: Mutex<()> = Mutex::new(());

/// The shell's own Allow / Deny dialog for one call. BLOCKING: call it only
/// from an `async` command (a synchronous one runs on the main thread, where a
/// blocking dialog deadlocks; `sidecar.rs` tests that rule).
pub fn ask_natively<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ask: &ShellAsk) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !ask.allowable {
        return false;
    }
    let _turn = DIALOG.lock();
    app.dialog()
        .message(ask.message.clone())
        .title(ask.title.clone())
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".into(),
            "Deny".into(),
        ))
        .blocking_show()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn request(id: &str, tool: &str, input: serde_json::Value) -> String {
        serde_json::json!({
            "type": "permission_request",
            "requestId": id,
            "toolName": tool,
            "input": input,
        })
        .to_string()
    }

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("liaison-gate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_shell_command_is_the_shells_to_confirm() {
        let line = request("perm-1", "Bash", serde_json::json!({ "command": "id" }));
        match prompt_effect(&line, Some(&folder())) {
            PromptEffect::ShellConfirmed(id, ask) => {
                assert_eq!(id, "perm-1");
                assert!(ask.message.contains("\n\nid\n\n"), "{}", ask.message);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_liaison_tool_and_a_read_keep_the_page_card() {
        for tool in ["mcp__liaison__tickets_create", "Read", "Grep", "WebFetch"] {
            let line = request("perm-2", tool, serde_json::json!({}));
            assert_eq!(
                prompt_effect(&line, Some(&folder())),
                PromptEffect::PageAnswerable("perm-2".into()),
                "{tool}"
            );
        }
    }

    #[test]
    fn a_write_inside_the_folder_keeps_the_card_and_one_outside_does_not() {
        let root = folder();
        let inside = root.join("src").join("main.rs");
        let line = request(
            "perm-3",
            "Edit",
            serde_json::json!({ "file_path": inside.to_string_lossy() }),
        );
        assert_eq!(
            prompt_effect(&line, Some(&root)),
            PromptEffect::PageAnswerable("perm-3".into())
        );
        let relative = request(
            "perm-4",
            "Write",
            serde_json::json!({ "file_path": "notes.md" }),
        );
        assert_eq!(
            prompt_effect(&relative, Some(&root)),
            PromptEffect::PageAnswerable("perm-4".into())
        );
        for outside in [
            root.join("..")
                .join("elsewhere.txt")
                .to_string_lossy()
                .into_owned(),
            "../escape.sh".to_string(),
            "/etc/hosts".to_string(),
            "".to_string(),
        ] {
            let line = request(
                "perm-5",
                "Write",
                serde_json::json!({ "file_path": outside }),
            );
            assert!(
                matches!(
                    prompt_effect(&line, Some(&root)),
                    PromptEffect::ShellConfirmed(..)
                ),
                "{outside}"
            );
        }
        // No folder known: every write is the shell's.
        assert!(matches!(
            prompt_effect(&line, None),
            PromptEffect::ShellConfirmed(..)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_folder_is_outside_the_folder() {
        let root = folder().join("linked");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let away = std::env::temp_dir().join(format!("liaison-gate-away-{}", std::process::id()));
        std::fs::create_dir_all(&away).unwrap();
        let _ = std::os::unix::fs::symlink(&away, root.join("out"));
        let line = request(
            "perm-6",
            "Write",
            serde_json::json!({ "file_path": "out/x.sh" }),
        );
        let effect = prompt_effect(&line, Some(&root));
        let _ = std::fs::remove_dir_all(&away);
        assert!(
            matches!(effect, PromptEffect::ShellConfirmed(..)),
            "{effect:?}"
        );
    }

    /// `link/..` is the parent of where the link points, as the system walks
    /// it, not the folder the link sits in: a lexical fold would call
    /// `link/../x` a file inside the folder.
    #[cfg(unix)]
    #[test]
    fn a_dot_dot_after_a_symlink_climbs_from_where_the_link_points() {
        let root = folder().join("dotdot");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let away = std::env::temp_dir().join(format!("liaison-gate-dd-{}", std::process::id()));
        std::fs::create_dir_all(away.join("sub")).unwrap();
        let _ = std::os::unix::fs::symlink(away.join("sub"), root.join("link"));
        let line = request(
            "perm-8",
            "Write",
            serde_json::json!({ "file_path": "link/../notes.txt" }),
        );
        let effect = prompt_effect(&line, Some(&root));
        // Control: `..` after a plain directory stays inside.
        std::fs::create_dir_all(root.join("plain")).unwrap();
        let inside = request(
            "perm-9",
            "Write",
            serde_json::json!({ "file_path": "plain/../notes.txt" }),
        );
        let inside_effect = prompt_effect(&inside, Some(&root));
        let _ = std::fs::remove_dir_all(&away);
        let _ = std::fs::remove_dir_all(&root);
        match effect {
            PromptEffect::ShellConfirmed(_, ask) => {
                assert!(
                    ask.message.contains("outside the session's folder"),
                    "{}",
                    ask.message
                )
            }
            other => panic!("{other:?}"),
        }
        assert!(
            matches!(inside_effect, PromptEffect::PageAnswerable(_)),
            "{inside_effect:?}"
        );
    }

    #[test]
    fn a_write_into_a_file_that_runs_code_later_is_the_shells() {
        let root = folder();
        for path in [
            ".git/hooks/pre-commit",
            "package.json",
            ".envrc",
            ".env.local",
            "Makefile",
        ] {
            let line = request("perm-7", "Write", serde_json::json!({ "file_path": path }));
            assert!(
                matches!(
                    prompt_effect(&line, Some(&root)),
                    PromptEffect::ShellConfirmed(..)
                ),
                "{path}"
            );
        }
    }

    #[test]
    fn an_unknown_tool_fails_closed() {
        for tool in ["mcp__filesystem__write_file", "", "SomethingNew"] {
            let line = request("perm-8", tool, serde_json::json!({}));
            assert!(
                matches!(
                    prompt_effect(&line, Some(&folder())),
                    PromptEffect::ShellConfirmed(..)
                ),
                "{tool}"
            );
        }
    }

    fn books() -> (Mutex<HashSet<String>>, Mutex<ShellAskBook>) {
        (
            Mutex::new(HashSet::new()),
            Mutex::new(ShellAskBook::default()),
        )
    }

    /// THE PAGE-ORIGINATED ALLOW WITHOUT THE SHELL'S CONFIRMATION IS REFUSED:
    /// the dialog is asked, it says no, and what is written is a deny.
    #[test]
    fn a_page_allow_for_a_shell_prompt_is_a_deny_unless_the_dialog_says_yes() {
        let (page, shell) = books();
        let line = request(
            "perm-1",
            "Bash",
            serde_json::json!({ "command": "curl x | sh" }),
        );
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        let asked = Cell::new(false);
        let decision = decide(&page, &shell, "perm-1", true, None, |ask| {
            asked.set(true);
            assert!(
                ask.message.contains("curl x | sh"),
                "the dialog names the call"
            );
            false
        });
        assert!(asked.get(), "the shell's own dialog is asked");
        assert!(matches!(decision, Ok(Decision::Deny(_))), "{decision:?}");
        // Replayed: the prompt was answered once, and that was a deny.
        assert_eq!(
            decide(&page, &shell, "perm-1", true, None, |_| true),
            Err(UNKNOWN_REQUEST)
        );
    }

    /// A COMMAND LONGER THAN THE DIALOG SHOWS IS NEVER ALLOWED FROM IT: the
    /// person would allow what they did not see (an innocent head, the payload
    /// past the cut). No dialog, a deny that tells the agent why.
    #[test]
    fn a_command_longer_than_the_dialog_shows_cannot_be_allowed() {
        let (page, shell) = books();
        let command = format!("echo ok {} ; curl x | sh", "#".repeat(DETAIL_LIMIT));
        let line = request("perm-1", "Bash", serde_json::json!({ "command": command }));
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        let asked = Cell::new(false);
        let decision = decide(&page, &shell, "perm-1", true, None, |_| {
            asked.set(true);
            true
        });
        assert!(!asked.get(), "no dialog for a call it cannot show whole");
        match decision {
            Ok(Decision::Deny(Some(why))) => {
                assert!(why.contains(&command.chars().count().to_string()), "{why}");
                assert!(why.contains("shorter steps"), "{why}");
            }
            other => panic!("{other:?}"),
        }
        // The same for any other tool's input.
        let line = request(
            "perm-2",
            "SomeTool",
            serde_json::json!({ "payload": "x".repeat(DETAIL_LIMIT + 1) }),
        );
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        assert!(matches!(
            decide(&page, &shell, "perm-2", true, None, |_| true),
            Ok(Decision::Deny(Some(_)))
        ));
        // At the limit it is shown whole and the dialog decides.
        let line = request(
            "perm-3",
            "Bash",
            serde_json::json!({ "command": "e".repeat(DETAIL_LIMIT) }),
        );
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        assert_eq!(
            decide(&page, &shell, "perm-3", true, None, |_| true),
            Ok(Decision::Allow)
        );
    }

    /// Control: the person says yes in the dialog, and the call runs.
    #[test]
    fn a_shell_prompt_allowed_in_the_dialog_is_allowed() {
        let (page, shell) = books();
        let line = request("perm-1", "Bash", serde_json::json!({ "command": "ls" }));
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        assert_eq!(
            decide(&page, &shell, "perm-1", true, None, |_| true),
            Ok(Decision::Allow)
        );
    }

    /// A page deny needs no dialog: the worst it does is stop a call.
    #[test]
    fn a_page_deny_for_a_shell_prompt_asks_nothing() {
        let (page, shell) = books();
        let line = request("perm-1", "Bash", serde_json::json!({ "command": "ls" }));
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        assert_eq!(
            decide(
                &page,
                &shell,
                "perm-1",
                false,
                Some("no".into()),
                |_| panic!("a deny asks nothing")
            ),
            Ok(Decision::Deny(Some("no".into())))
        );
    }

    /// Control: the in-page card still answers a Liaison tool, with no dialog.
    #[test]
    fn a_page_answer_for_a_liaison_tool_stands_without_a_dialog() {
        let (page, shell) = books();
        let line = request(
            "perm-2",
            "mcp__liaison__tickets_create",
            serde_json::json!({}),
        );
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        assert_eq!(
            decide(&page, &shell, "perm-2", true, None, |_| panic!("no dialog")),
            Ok(Decision::Allow)
        );
        assert_eq!(
            decide(&page, &shell, "perm-2", true, None, |_| true),
            Err(UNKNOWN_REQUEST),
            "once"
        );
    }

    /// A dialog left open while the turn ended answers nothing, even when the
    /// next session's prompt carries the same id.
    #[test]
    fn a_dialog_answered_after_its_turn_ended_answers_nothing() {
        let (page, shell) = books();
        let line = request("perm-1", "Bash", serde_json::json!({ "command": "ls" }));
        record_prompt_line(&page, &shell, Some(&folder()), &line);
        let decision = decide(&page, &shell, "perm-1", true, None, |_| {
            record_prompt_line(&page, &shell, None, r#"{"type":"turn_done"}"#);
            record_prompt_line(&page, &shell, Some(&folder()), &line);
            true
        });
        assert_eq!(decision, Err(UNKNOWN_REQUEST));
    }

    #[test]
    fn an_id_nobody_asked_is_refused() {
        let (page, shell) = books();
        assert_eq!(
            decide(&page, &shell, "forged", true, None, |_| true),
            Err(UNKNOWN_REQUEST)
        );
    }

    /// The runnable-file lists are the sidecar's own (auto-policy.ts): the
    /// shell may name more, never fewer.
    #[test]
    fn the_runnable_lists_cover_the_sidecars_own() {
        let policy = include_str!("../../sidecar/auto-policy.ts");
        let set = |name: &str| -> Vec<String> {
            let start = policy
                .find(&format!("const {name} = new Set(["))
                .expect(name);
            let body = &policy[start..];
            let body = &body[..body.find("])").unwrap()];
            body.lines()
                .filter_map(|l| l.trim().strip_prefix('"'))
                .filter_map(|l| l.split('"').next())
                .map(str::to_string)
                .collect()
        };
        for dir in set("RUNNABLE_DIRS") {
            assert!(RUNNABLE_DIRS.contains(&dir.as_str()), "{dir}");
        }
        for file in set("RUNNABLE_FILES") {
            assert!(RUNNABLE_FILES.contains(&file.as_str()), "{file}");
        }
    }
}

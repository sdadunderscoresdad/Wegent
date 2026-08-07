//
// SPDX-License-Identifier: Apache-2.0

//! Cross-platform Git helpers for the local executor.
//!
//! Wegent's UI relies on a stable set of `git_*` device commands. On macOS and Linux those
//! commands can safely be dispatched as shell one-liners, but on Windows spawning
//! `cmd /C` / `bash -lc` for every Git query is fragile:
//!
//! - Git is frequently installed in a non-default location (e.g. `C:\\Program Files\\Git\\cmd`)
//!   and the executor's sanitised PATH may not contain it.
//! - `cmd /C` creates an intermediate shell that can hang on credential helpers or encoding
//!   mismatches, producing the "command timed out" errors users see after the first call.
//!
//! This module provides a small, synchronous Git runner that executes `git` directly with
//! argv arguments and a PATH that has been pre-filled with common installation directories on
//! Windows.

#[cfg(windows)]
use std::path::PathBuf;
use std::{
    collections::HashMap,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use crate::local::command::build_env;

/// Common installation directories for Git on Windows. These are appended to the process PATH
/// so that `git` can be resolved even when the executor is started from an environment that
/// does not include them.
#[cfg(windows)]
const WINDOWS_GIT_PATHS: &[&str] = &[
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files (x86)\\Git\\cmd",
    "C:\\ProgramData\\chocolatey\\bin",
];

/// Result of running a Git command.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration: f64,
    pub timed_out: bool,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }

    pub fn into_command_result(
        self,
        stdout_on_success: bool,
    ) -> crate::local::command::CommandResult {
        use crate::local::command::CommandResult;
        if self.success() {
            CommandResult::ok(if stdout_on_success {
                self.stdout
            } else {
                String::new()
            })
        } else {
            CommandResult::error(
                if self.stderr.is_empty() {
                    format!("git exited with code {:?}", self.exit_code)
                } else {
                    self.stderr
                },
                self.duration,
                self.timed_out,
            )
        }
    }
}

/// Maximum time a single Git invocation may run before the child is killed.
///
/// Mirrors `DEFAULT_TIMEOUT_SECONDS` for shell commands so native Git calls cannot hang
/// the blocking pool indefinitely (e.g. network stalls on `push`).
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// Read a child's pipe to the end on a dedicated thread so the child can never block on a
/// full pipe buffer while we poll its exit status.
fn read_pipe_to_end(
    mut reader: impl std::io::Read + Send + 'static,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        bytes
    })
}

/// Run a Git subcommand in `cwd` with the given argv arguments.
///
/// The first argument is the Git subcommand (e.g. `"branch"`, `"status"`); remaining entries
/// are passed verbatim. The working directory is resolved from the caller-provided `path`.
/// The child process is killed if it does not exit within [`GIT_COMMAND_TIMEOUT`].
pub fn run_git(cwd: &str, args: &[&str], extra_env: &HashMap<String, String>) -> GitOutput {
    let started_at = Instant::now();

    let environment = build_env(extra_env);
    #[cfg(windows)]
    let environment = prepend_windows_git_paths(environment);

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env_clear()
        .envs(&environment)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return GitOutput {
                stdout: String::new(),
                stderr: error.to_string(),
                exit_code: None,
                duration: started_at.elapsed().as_secs_f64(),
                timed_out: false,
            };
        }
    };

    let stdout_reader = child.stdout.take().map(read_pipe_to_end);
    let stderr_reader = child.stderr.take().map(read_pipe_to_end);

    let deadline = started_at + GIT_COMMAND_TIMEOUT;
    let mut timed_out = false;
    let mut wait_error = None;
    let mut status = None;
    loop {
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                status = Some(exit_status);
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                wait_error = Some(error);
                break;
            }
        }
    }

    if let Some(error) = wait_error {
        let _ = child.kill();
        let _ = child.wait();
        let stdout = stdout_reader.and_then(|handle| handle.join().ok());
        let _ = stderr_reader.and_then(|handle| handle.join().ok());
        return GitOutput {
            stdout: String::from_utf8_lossy(stdout.as_deref().unwrap_or_default()).to_string(),
            stderr: format!("failed to poll git process: {error}"),
            exit_code: None,
            duration: started_at.elapsed().as_secs_f64(),
            timed_out: false,
        };
    }

    let stdout = stdout_reader.and_then(|handle| handle.join().ok());
    let stderr = stderr_reader.and_then(|handle| handle.join().ok());
    let stdout = String::from_utf8_lossy(stdout.as_deref().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(stderr.as_deref().unwrap_or_default()).to_string();

    if timed_out {
        return GitOutput {
            stdout,
            stderr: format!(
                "git command timed out after {}s: {stderr}",
                GIT_COMMAND_TIMEOUT.as_secs()
            ),
            exit_code: None,
            duration: started_at.elapsed().as_secs_f64(),
            timed_out: true,
        };
    }

    GitOutput {
        stdout,
        stderr,
        exit_code: status.and_then(|exit_status| exit_status.code()),
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: false,
    }
}

/// Run a Git subcommand and return its stdout if it succeeded and produced output.
pub fn git_stdout(cwd: &str, args: &[&str], extra_env: &HashMap<String, String>) -> Option<String> {
    let output = run_git(cwd, args, extra_env);
    if !output.success() {
        return None;
    }
    let trimmed = output.stdout.trim().to_owned();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

/// Check whether `path` points to a Git worktree.
pub fn is_worktree(path: &str, extra_env: &HashMap<String, String>) -> bool {
    git_stdout(path, &["rev-parse", "--is-inside-work-tree"], extra_env)
        .map(|output| output == "true")
        .unwrap_or(false)
        || git_stdout(path, &["rev-parse", "--git-dir"], extra_env).is_some()
}

/// Resolve the best merge-base candidate for branch-diff operations.
///
/// This re-implements the shell logic from `GIT_BRANCH_DIFF_SHORTSTAT_SCRIPT` in a
/// cross-platform way so Windows does not need bash.
pub fn resolve_merge_base(cwd: &str, extra_env: &HashMap<String, String>) -> Option<String> {
    // Try the remote default branch symbolic ref first.
    if let Some(remote_default) = git_stdout(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        extra_env,
    ) {
        if git_rev_parse_verify(cwd, &format!("{remote_default}^{{commit}}"), extra_env) {
            if let Some(base) = git_stdout(cwd, &["merge-base", &remote_default, "HEAD"], extra_env)
            {
                return Some(base);
            }
        }
    }

    for candidate in ["origin/main", "main", "origin/master", "master"] {
        if git_rev_parse_verify(cwd, &format!("{candidate}^{{commit}}"), extra_env) {
            if let Some(base) = git_stdout(cwd, &["merge-base", candidate, "HEAD"], extra_env) {
                return Some(base);
            }
        }
    }

    None
}

/// Async variant of [`run_git`]; spawns the synchronous git runner on the
/// blocking thread pool so it cannot starve the tokio runtime.
pub async fn run_git_async(
    cwd: &str,
    args: &[&str],
    extra_env: &HashMap<String, String>,
) -> GitOutput {
    let cwd = cwd.to_owned();
    let args: Vec<String> = args.iter().map(|&arg| arg.to_owned()).collect();
    let extra_env = extra_env.clone();
    tokio::task::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(&cwd, &arg_refs, &extra_env)
    })
    .await
    .unwrap_or_else(|error| GitOutput {
        stdout: String::new(),
        stderr: format!("git task panicked: {error}"),
        exit_code: None,
        duration: 0.0,
        timed_out: false,
    })
}

/// Async variant of [`git_stdout`].
pub async fn git_stdout_async(
    cwd: &str,
    args: &[&str],
    extra_env: &HashMap<String, String>,
) -> Option<String> {
    let output = run_git_async(cwd, args, extra_env).await;
    if !output.success() {
        return None;
    }
    let trimmed = output.stdout.trim().to_owned();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

/// Async variant of [`is_worktree`].
pub async fn is_worktree_async(path: &str, extra_env: &HashMap<String, String>) -> bool {
    git_stdout_async(path, &["rev-parse", "--is-inside-work-tree"], extra_env)
        .await
        .map(|output| output == "true")
        .unwrap_or(false)
        || git_stdout_async(path, &["rev-parse", "--git-dir"], extra_env)
            .await
            .is_some()
}

/// Async variant of [`resolve_merge_base`].
pub async fn resolve_merge_base_async(
    cwd: &str,
    extra_env: &HashMap<String, String>,
) -> Option<String> {
    if let Some(remote_default) = git_stdout_async(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        extra_env,
    )
    .await
    {
        if git_rev_parse_verify_async(cwd, &format!("{remote_default}^{{commit}}"), extra_env).await
        {
            if let Some(base) =
                git_stdout_async(cwd, &["merge-base", &remote_default, "HEAD"], extra_env).await
            {
                return Some(base);
            }
        }
    }

    for candidate in ["origin/main", "main", "origin/master", "master"] {
        if git_rev_parse_verify_async(cwd, &format!("{candidate}^{{commit}}"), extra_env).await {
            if let Some(base) =
                git_stdout_async(cwd, &["merge-base", candidate, "HEAD"], extra_env).await
            {
                return Some(base);
            }
        }
    }

    None
}

async fn git_rev_parse_verify_async(
    cwd: &str,
    reference: &str,
    extra_env: &HashMap<String, String>,
) -> bool {
    run_git_async(
        cwd,
        &["rev-parse", "--verify", "--quiet", reference],
        extra_env,
    )
    .await
    .success()
}

fn git_rev_parse_verify(cwd: &str, reference: &str, extra_env: &HashMap<String, String>) -> bool {
    run_git(
        cwd,
        &["rev-parse", "--verify", "--quiet", reference],
        extra_env,
    )
    .success()
}

#[cfg(windows)]
fn prepend_windows_git_paths(mut environment: HashMap<String, String>) -> HashMap<String, String> {
    // Extend the PATH already computed by `build_env` (which carries standard developer
    // paths and any caller-provided entries) instead of replacing it with the raw
    // process PATH, so WEGENT_EXTRA_PATHS and frontend-supplied PATH are not dropped.
    let current_path = environment.get("PATH").cloned().unwrap_or_default();
    let mut entries: Vec<PathBuf> = std::env::split_paths(&current_path).collect();

    // Add user-level Git installations as well.
    if let Some(local_app_data) = dirs::data_local_dir() {
        let user_git = local_app_data.join("Programs").join("Git").join("cmd");
        if user_git.is_dir() {
            entries.insert(0, user_git);
        }
    }

    for path in WINDOWS_GIT_PATHS.iter().map(PathBuf::from).rev() {
        if path.is_dir() {
            entries.insert(0, path);
        }
    }

    if let Ok(joined) = std::env::join_paths(entries) {
        environment.insert("PATH".to_owned(), joined.to_string_lossy().to_string());
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn run_git_or_panic(cwd: &str, args: &[&str]) -> String {
        run_git(cwd, args, &HashMap::new()).stdout
    }

    #[test]
    fn detects_non_worktree() {
        let tmp = TempDir::new().unwrap();
        assert!(!is_worktree(tmp.path().to_str().unwrap(), &HashMap::new()));
    }

    #[test]
    fn detects_worktree() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        run_git_or_panic(cwd, &["init", "--quiet"]);
        assert!(is_worktree(cwd, &HashMap::new()));
    }

    #[test]
    fn reads_current_branch() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        run_git_or_panic(cwd, &["init", "--quiet"]);
        run_git_or_panic(cwd, &["config", "user.email", "test@example.com"]);
        run_git_or_panic(cwd, &["config", "user.name", "Test"]);
        run_git_or_panic(cwd, &["checkout", "-b", "feature/test"]);
        let output = run_git_or_panic(cwd, &["branch", "--show-current"]);
        assert_eq!(output.trim(), "feature/test");
    }

    #[test]
    fn diff_no_index_reports_differences() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "one").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "two").unwrap();
        let output = run_git(
            cwd,
            &["diff", "--no-index", "--", "a.txt", "b.txt"],
            &HashMap::new(),
        );
        // `git diff --no-index` exits 1 when the files differ and emits the patch on
        // stdout; the spawn/poll runner must capture both even though exit code != 0.
        assert_eq!(output.exit_code, Some(1));
        assert!(!output.stdout.is_empty());
    }
}

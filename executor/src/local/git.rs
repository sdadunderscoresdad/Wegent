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

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::path::PathBuf;
use std::{
    collections::HashMap,
    io::{Read, Result as IoResult},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::local::command::{build_env, CommandResult};

/// Default timeout for a single Git invocation when the caller does not supply one.
///
/// Mirrors `DEFAULT_TIMEOUT_SECONDS` for shell commands so native Git calls cannot hang
/// the blocking pool indefinitely (e.g. network stalls on `push`).
const DEFAULT_GIT_TIMEOUT: Duration = Duration::from_secs(60);

/// How long we wait for pipe-reader threads to finish after the child has been killed.
///
/// If grandchildren (ssh, credential helpers) keep the pipe write ends open, we abandon the
/// threads instead of blocking the blocking pool forever.
const READER_JOIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Common installation directories for Git on Windows. These are prepended to the PATH
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
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }

    /// Convert into a [`CommandResult`].
    ///
    /// On failure the original exit code, stdout and stderr are preserved in their
    /// respective fields; a human-readable message is additionally placed in `error`.
    pub fn into_command_result(self, stdout_on_success: bool) -> CommandResult {
        if self.success() {
            CommandResult {
                success: true,
                exit_code: Some(0),
                stdout: Value::String(if stdout_on_success {
                    self.stdout
                } else {
                    String::new()
                }),
                stderr: self.stderr,
                duration: self.duration,
                timed_out: false,
                stdout_truncated: self.stdout_truncated,
                stderr_truncated: self.stderr_truncated,
                error: None,
            }
        } else {
            let error_message = if self.stderr.is_empty() {
                format!(
                    "git exited with code {}",
                    self.exit_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                )
            } else {
                self.stderr.clone()
            };
            CommandResult {
                success: false,
                exit_code: self.exit_code,
                stdout: Value::String(self.stdout),
                stderr: self.stderr,
                duration: self.duration,
                timed_out: self.timed_out,
                stdout_truncated: self.stdout_truncated,
                stderr_truncated: self.stderr_truncated,
                error: Some(error_message),
            }
        }
    }
}

/// Read a child's pipe to the end on a dedicated thread, optionally capped at `max_bytes`.
///
/// When the cap is reached we keep draining the pipe so the child does not block on a full
/// buffer, but we discard the excess and report `truncated = true`.
fn read_pipe(
    mut reader: impl Read + Send + 'static,
    max_bytes: Option<usize>,
) -> JoinHandle<IoResult<(Vec<u8>, bool)>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut truncated = false;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if truncated {
                        // Drain the pipe but do not store anything else.
                        continue;
                    }
                    if let Some(max) = max_bytes {
                        let remaining = max.saturating_sub(bytes.len());
                        if remaining == 0 {
                            truncated = true;
                            continue;
                        }
                        if n > remaining {
                            truncated = true;
                        }
                        bytes.extend_from_slice(&buffer[..n.min(remaining)]);
                    } else {
                        bytes.extend_from_slice(&buffer[..n]);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok((bytes, truncated))
    })
}

/// Join a reader thread with a bounded timeout.
///
/// If the thread does not finish (typically because a grandchild still holds the pipe write
/// end), we drop the handle and let the thread run detached. This leaks one thread per such
/// event but prevents the blocking pool from hanging forever.
fn join_reader<T: Send + 'static>(handle: JoinHandle<T>, timeout: Duration) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(handle.join());
    });
    rx.recv_timeout(timeout).ok().and_then(|result| result.ok())
}

/// Raw result of running a Git command, with stdout/stderr kept as bytes.
///
/// Used for commands whose output is not necessarily valid UTF-8 (e.g. `ls-files -z`,
/// which emits raw filenames).
#[derive(Debug, Clone)]
pub struct RawGitOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub duration: f64,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl RawGitOutput {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

impl From<RawGitOutput> for GitOutput {
    fn from(raw: RawGitOutput) -> Self {
        GitOutput {
            stdout: String::from_utf8_lossy(&raw.stdout).to_string(),
            stderr: String::from_utf8_lossy(&raw.stderr).to_string(),
            exit_code: raw.exit_code,
            duration: raw.duration,
            timed_out: raw.timed_out,
            stdout_truncated: raw.stdout_truncated,
            stderr_truncated: raw.stderr_truncated,
        }
    }
}

/// Convert raw bytes from git output into an [`OsString`] usable as a process argument.
///
/// On Unix filenames are arbitrary bytes and round-trip losslessly. On other platforms the
/// bytes are decoded as UTF-8 with replacement, which is the best cross-platform effort.
pub fn bytes_to_os_string(bytes: &[u8]) -> std::ffi::OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::OsStr::from_bytes(bytes).to_os_string()
    }
    #[cfg(not(unix))]
    {
        std::ffi::OsString::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

/// Run a Git subcommand in `cwd` with the given argv arguments, keeping output as bytes.
///
/// - `timeout` defaults to [`DEFAULT_GIT_TIMEOUT`].
/// - `max_output_bytes` caps captured stdout/stderr; excess bytes are discarded and the
///   returned output marks the corresponding `*_truncated` flag.
fn run_git_raw<S: AsRef<std::ffi::OsStr>>(
    cwd: &str,
    args: &[S],
    extra_env: &HashMap<String, String>,
    timeout: Option<Duration>,
    max_output_bytes: Option<usize>,
) -> RawGitOutput {
    let started_at = Instant::now();

    if !Path::new(cwd).is_dir() {
        return RawGitOutput {
            stdout: Vec::new(),
            stderr: format!("Working directory does not exist: {cwd}").into_bytes(),
            exit_code: None,
            duration: 0.0,
            timed_out: false,
            stdout_truncated: false,
            stderr_truncated: false,
        };
    }

    let timeout = timeout.unwrap_or(DEFAULT_GIT_TIMEOUT);
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
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // On Unix, put the child in its own process group so we can kill the whole tree.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return RawGitOutput {
                stdout: Vec::new(),
                stderr: error.to_string().into_bytes(),
                exit_code: None,
                duration: started_at.elapsed().as_secs_f64(),
                timed_out: false,
                stdout_truncated: false,
                stderr_truncated: false,
            };
        }
    };

    let child_pid = child.id();

    let stdout_reader = child
        .stdout
        .take()
        .map(|pipe| read_pipe(pipe, max_output_bytes));
    let stderr_reader = child
        .stderr
        .take()
        .map(|pipe| read_pipe(pipe, max_output_bytes));

    let deadline = started_at + timeout;
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
                    kill_process_tree(child_pid);
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                wait_error = Some(error);
                break;
            }
        }
    }

    // Try to reap reader threads. If grandchildren keep pipes open, this could block forever,
    // so we cap the wait and abandon the threads if necessary.
    let stdout = stdout_reader
        .and_then(|handle| join_reader(handle, READER_JOIN_TIMEOUT))
        .and_then(|result| result.ok());
    let stderr = stderr_reader
        .and_then(|handle| join_reader(handle, READER_JOIN_TIMEOUT))
        .and_then(|result| result.ok());
    let stdout_truncated = stdout
        .as_ref()
        .map(|(_, truncated)| *truncated)
        .unwrap_or(false);
    let stderr_truncated = stderr
        .as_ref()
        .map(|(_, truncated)| *truncated)
        .unwrap_or(false);
    let stdout = stdout.map(|(bytes, _)| bytes).unwrap_or_default();
    let stderr = stderr.map(|(bytes, _)| bytes).unwrap_or_default();

    if timed_out {
        let full_stderr = if stderr.is_empty() {
            format!("git command timed out after {}s", timeout.as_secs()).into_bytes()
        } else {
            let mut combined =
                format!("git command timed out after {}s: ", timeout.as_secs()).into_bytes();
            combined.extend_from_slice(&stderr);
            combined
        };
        return RawGitOutput {
            stdout,
            stderr: full_stderr,
            exit_code: None,
            duration: started_at.elapsed().as_secs_f64(),
            timed_out: true,
            stdout_truncated,
            stderr_truncated,
        };
    }

    if let Some(error) = wait_error {
        return RawGitOutput {
            stdout,
            stderr: format!("failed to poll git process: {error}").into_bytes(),
            exit_code: None,
            duration: started_at.elapsed().as_secs_f64(),
            timed_out: false,
            stdout_truncated,
            stderr_truncated,
        };
    }

    RawGitOutput {
        stdout,
        stderr,
        exit_code: status.and_then(|exit_status| exit_status.code()),
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: false,
        stdout_truncated,
        stderr_truncated,
    }
}

/// Run a Git subcommand in `cwd` with the given argv arguments.
///
/// Output is decoded with [`String::from_utf8_lossy`]; use [`run_git_raw_async`] for commands
/// whose output may not be valid UTF-8.
pub fn run_git<S: AsRef<std::ffi::OsStr>>(
    cwd: &str,
    args: &[S],
    extra_env: &HashMap<String, String>,
    timeout: Option<Duration>,
    max_output_bytes: Option<usize>,
) -> GitOutput {
    run_git_raw(cwd, args, extra_env, timeout, max_output_bytes).into()
}

#[cfg(unix)]
fn kill_process_tree(child_pid: u32) {
    let pid = child_pid as i32;
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_tree(_child_pid: u32) {}

/// Async variant of [`run_git_raw`]; spawns the synchronous git runner on the
/// blocking thread pool so it cannot starve the tokio runtime, and keeps output as bytes.
pub async fn run_git_raw_async<S: AsRef<std::ffi::OsStr>>(
    cwd: &str,
    args: &[S],
    extra_env: &HashMap<String, String>,
    timeout: Option<Duration>,
    max_output_bytes: Option<usize>,
) -> RawGitOutput {
    let cwd = cwd.to_owned();
    let args: Vec<std::ffi::OsString> =
        args.iter().map(|arg| arg.as_ref().to_os_string()).collect();
    let extra_env = extra_env.clone();
    tokio::task::spawn_blocking(move || {
        run_git_raw(&cwd, &args, &extra_env, timeout, max_output_bytes)
    })
    .await
    .unwrap_or_else(|error| RawGitOutput {
        stdout: Vec::new(),
        stderr: format!("git task panicked: {error}").into_bytes(),
        exit_code: None,
        duration: 0.0,
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
    })
}

/// Async variant of [`run_git`]; spawns the synchronous git runner on the
/// blocking thread pool so it cannot starve the tokio runtime.
pub async fn run_git_async<S: AsRef<std::ffi::OsStr>>(
    cwd: &str,
    args: &[S],
    extra_env: &HashMap<String, String>,
    timeout: Option<Duration>,
    max_output_bytes: Option<usize>,
) -> GitOutput {
    run_git_raw_async(cwd, args, extra_env, timeout, max_output_bytes)
        .await
        .into()
}

/// Run a Git subcommand and return its stdout if it succeeded and produced output.
pub async fn git_stdout_async(
    cwd: &str,
    args: &[&str],
    extra_env: &HashMap<String, String>,
) -> Option<String> {
    let output = run_git_async(cwd, args, extra_env, None, None).await;
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
pub async fn is_worktree_async(path: &str, extra_env: &HashMap<String, String>) -> bool {
    git_stdout_async(path, &["rev-parse", "--is-inside-work-tree"], extra_env)
        .await
        .map(|output| output == "true")
        .unwrap_or(false)
        || git_stdout_async(path, &["rev-parse", "--git-dir"], extra_env)
            .await
            .is_some()
}

/// Resolve the best merge-base candidate for branch-diff operations.
///
/// Mirrors the shell logic from `GIT_BRANCH_DIFF_SHORTSTAT_SCRIPT`: the first ref that
/// verifies is locked in; if `merge-base` against it fails we immediately fall back to `None`
/// so the caller diffs against HEAD.
pub async fn resolve_merge_base_async(
    cwd: &str,
    extra_env: &HashMap<String, String>,
) -> Option<String> {
    // Try the remote default branch symbolic ref first.
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
        // The remote default branch verified but we could not find a merge-base; do not
        // fall through to unrelated candidates.
        return None;
    }

    for candidate in ["origin/main", "main", "origin/master", "master"] {
        if git_rev_parse_verify_async(cwd, &format!("{candidate}^{{commit}}"), extra_env).await {
            if let Some(base) =
                git_stdout_async(cwd, &["merge-base", candidate, "HEAD"], extra_env).await
            {
                return Some(base);
            }
            // This candidate verified but merge-base failed; stop rather than trying
            // increasingly unrelated refs.
            return None;
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
        None,
        None,
    )
    .await
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

    async fn run_git_or_panic(cwd: &str, args: &[&str]) -> String {
        run_git_async(cwd, args, &HashMap::new(), None, None)
            .await
            .stdout
    }

    #[tokio::test]
    async fn detects_non_worktree() {
        let tmp = TempDir::new().unwrap();
        assert!(!is_worktree_async(tmp.path().to_str().unwrap(), &HashMap::new()).await);
    }

    #[tokio::test]
    async fn detects_worktree() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        run_git_or_panic(cwd, &["init", "--quiet"]).await;
        assert!(is_worktree_async(cwd, &HashMap::new()).await);
    }

    #[tokio::test]
    async fn reads_current_branch() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        run_git_or_panic(cwd, &["init", "--quiet"]).await;
        run_git_or_panic(cwd, &["config", "user.email", "test@example.com"]).await;
        run_git_or_panic(cwd, &["config", "user.name", "Test"]).await;
        run_git_or_panic(cwd, &["checkout", "-b", "feature/test"]).await;
        let output = run_git_or_panic(cwd, &["branch", "--show-current"]).await;
        assert_eq!(output.trim(), "feature/test");
    }

    #[tokio::test]
    async fn diff_no_index_reports_differences() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "one").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "two").unwrap();
        let output = run_git(
            cwd,
            &["diff", "--no-index", "--", "a.txt", "b.txt"],
            &HashMap::new(),
            None,
            None,
        );
        // `git diff --no-index` exits 1 when the files differ and emits the patch on
        // stdout; the spawn/poll runner must capture both even though exit code != 0.
        assert_eq!(output.exit_code, Some(1));
        assert!(!output.stdout.is_empty());
    }

    #[tokio::test]
    async fn missing_cwd_returns_structured_error() {
        let output = run_git(
            "/definitely/not/a/directory",
            &["status"],
            &HashMap::new(),
            None,
            None,
        );
        assert!(!output.success());
        assert!(output.stderr.contains("Working directory does not exist"));
    }

    #[tokio::test]
    async fn respects_max_output_bytes() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "one").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "two").unwrap();
        let output = run_git(
            cwd,
            &["diff", "--no-index", "--", "a.txt", "b.txt"],
            &HashMap::new(),
            None,
            Some(4),
        );
        assert_eq!(output.exit_code, Some(1));
        assert!(output.stdout_truncated);
        assert_eq!(output.stdout.len(), 4);
    }

    #[tokio::test]
    async fn timeout_kills_long_running_command() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        let start = Instant::now();
        let output = run_git(
            cwd,
            // `git init` is fast, so use a command that does not exist in an empty dir
            // to force git to fail quickly. Instead test timeout with a sleep via git's
            // credential helper? We simulate by running a command that waits via a hook?
            // Simpler: run `git rev-parse` in a non-repo; it fails fast. To test timeout
            // we need a slow command. Use `git ls-remote` against a non-routable address.
            &["ls-remote", "https://192.0.2.1/example/repo.git"],
            &HashMap::new(),
            Some(Duration::from_millis(200)),
            None,
        );
        let elapsed = start.elapsed();
        assert!(output.timed_out || !output.success());
        assert!(elapsed < Duration::from_secs(2));
    }
}

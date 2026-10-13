---
sidebar_position: 22
---

# Local Data Directory

Wework stores its local runtime data under `~/.wework` in the user's home
directory. The legacy `~/.wecode/wegent-executor` and `~/.wegent-executor`
locations are no longer used.

## Directory Layout

The default Executor Home is `~/.wework` and contains:

- `codex/`: Wework's isolated Codex home (overridable with `WEGENT_CODEX_HOME`).
- `workspace/projects/` and `workspace/worktrees/`: local projects and managed worktrees.
- `workspace/chats/`: local task conversations.
- `workspace/attachments/draft/`: local attachment drafts.
- `capabilities/bundled-marketplaces/`: bundled plugin marketplace cache.
- `logs/`: Executor logs such as `logs/executor.log`.
- `runtime/`: per-process state such as the bridge identity.
- `device-config.json` and `device_id`: local device identity.

The `WEGENT_EXECUTOR_HOME` environment variable overrides the default Executor
Home. This is useful for isolated sessions, tests, and custom deployments.

## Deciding Whether a Codex Home Can Move

Before moving a legacy Codex Home into the workbench directory, the desktop asks
the executor (`--workbench-codex-migration-check`) for a read-only verdict, so a
move never strands stored credentials. Codex derives keyring accounts from the
canonical Codex Home path, so a new path can no longer decrypt them:

- Only confirmed evidence blocks a move: encrypted credential files under
  `secrets/`, explicitly configured keyring login storage, or `ema-idp:`
  enterprise identities. Such a Home keeps its current path and is not migrated.
- Unset configuration keeps the Codex defaults, which store login credentials in
  a file inside the Home, instead of inferring platform defaults. Windows and
  macOS therefore reach the same verdict.
- Unreadable metadata or configuration is reported as a warning, never as a
  reason to block. The check returns `reasons`, `warnings`, and readable
  `reason`/`warning` texts, and the desktop writes the verdict to the startup log.

A blocked Home does not block startup: `WEGENT_CODEX_HOME` keeps pointing at the
legacy path while the remaining data (executor Home, capabilities, Claude Home,
workspace) still migrates, and the next launch evaluates the Home again.

## Directory Scanning During Home Migration

When moving a legacy Codex Home into the workbench directory, relative symlink
scanning uses the entry types supplied by directory enumeration. It recurses
into directories and validates symlinks without separately reading regular-file
metadata. A background Git operation removing a temporary lock file after
enumeration therefore does not block startup. Unresolvable relative symlinks
still block migration.

## Automatic Cleanup and Retention

Wework runs storage maintenance in the background immediately after launch and
then every 30 minutes. Maintenance only processes temporary data that Wework
explicitly owns. It does not age-delete user projects or managed worktrees that
may still need recovery:

- `app-runtime/wework-<pid>-<timestamp>/`: an isolated Executor instance is
  deleted after 14 days only when it is inactive. An instance holding
  `.instance.lock` is always preserved. For legacy lockless directories, Wework
  also checks the PID embedded in the directory name before deletion. Legacy
  `wework-dev-*` directories follow the same rules.
- Files older than 14 days under `logs/`, and files older than 24 hours in
  feedback staging or the built-in browser temporary directory, are removed in
  batches. Current-process logs and symbolic links are preserved.
- Stale `marketplace-add-*` and `marketplace-upgrade-*` directories older than
  7 days are removed from `codex/.tmp/marketplaces/.staging/`. This covers both
  `~/.wework/codex` and `~/.wework/apps/<namespace>/codex` without deleting
  installed marketplaces.

`workspace/worktrees/` contains task data rather than disposable cache. Its
lifecycle is driven by archived tasks and the Worktree retention settings, with
a Git snapshot saved before deletion. The storage maintenance thread does not
delete these directories directly.

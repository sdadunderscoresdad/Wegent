// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, io, path::Path};

use serde::Serialize;
use toml_edit::DocumentMut;

/// Encrypted credential files that only decrypt through a keyring identity
/// derived from the canonical Codex Home path.
const ENCRYPTED_STORAGE_FILES: [&str; 4] = [
    "local.age",
    "codex_auth.age",
    "mcp_oauth.age",
    "gateway_oauth.age",
];

/// Positive evidence that moving the Home would strand stored credentials.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexHomeMigrationReason {
    MissingHome,
    HomeNotAbsolute,
    EncryptedStorage,
    CliKeyringStorage,
    EnterpriseIdentity,
}

impl CodexHomeMigrationReason {
    fn text(self) -> &'static str {
        match self {
            Self::MissingHome => "Missing Codex Home",
            Self::HomeNotAbsolute => "Codex migration requires an absolute Home",
            Self::EncryptedStorage => {
                "Codex encrypted storage is Home-bound; migrate its keyring identity before moving Home"
            }
            Self::CliKeyringStorage => {
                "Codex login keyring storage is Home-bound; verify login storage before moving Home"
            }
            Self::EnterpriseIdentity => {
                "Codex enterprise OAuth identity is Home-bound; migrate that identity before moving Home"
            }
        }
    }
}

/// An inspection problem that never blocks a move: it is no evidence of
/// Home-bound credentials, and the mover fails loudly when the Home itself
/// cannot be relocated.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexHomeMigrationWarning {
    HomeMetadataUnreadable,
    ConfigUnreadable,
    ConfigInvalid,
    ConfigValueInvalid,
    EncryptedStorageUnreadable,
}

/// Inspection verdict for one Codex Home.
///
/// Callers must keep the Home at its current path when `allowed` is false
/// instead of refusing to start, because the keyring identity of stored
/// credentials is derived from the canonical Home path.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CodexHomeMigrationVerdict {
    pub allowed: bool,
    pub reasons: Vec<CodexHomeMigrationReason>,
    pub warnings: Vec<CodexHomeMigrationWarning>,
    /// Bounded diagnostics for the first reason and warning. Never contains
    /// configuration values or credential contents.
    pub reason: Option<String>,
    pub warning: Option<String>,
}

impl Default for CodexHomeMigrationVerdict {
    fn default() -> Self {
        Self {
            allowed: true,
            reasons: Vec::new(),
            warnings: Vec::new(),
            reason: None,
            warning: None,
        }
    }
}

impl CodexHomeMigrationVerdict {
    pub fn blocked(reason: CodexHomeMigrationReason) -> Self {
        let mut verdict = Self::default();
        verdict.block(reason);
        verdict
    }

    fn block(&mut self, reason: CodexHomeMigrationReason) {
        self.allowed = false;
        if self.reason.is_none() {
            self.reason = Some(reason.text().to_owned());
        }
        if !self.reasons.contains(&reason) {
            self.reasons.push(reason);
        }
    }

    fn warn(&mut self, warning: CodexHomeMigrationWarning, text: String) {
        if self.warning.is_none() {
            self.warning = Some(text);
        }
        if !self.warnings.contains(&warning) {
            self.warnings.push(warning);
        }
    }
}

/// Inspect configuration and file metadata only. Never open credential files.
///
/// Only positive evidence blocks a move. Unreadable metadata is reported as a
/// warning because it says nothing about Home-bound credentials, and treating an
/// I/O failure as a credential verdict strands desktop startup.
pub fn check(home: &Path) -> CodexHomeMigrationVerdict {
    let mut verdict = CodexHomeMigrationVerdict::default();
    if !home.is_absolute() {
        return CodexHomeMigrationVerdict::blocked(CodexHomeMigrationReason::HomeNotAbsolute);
    }
    // A missing Home has no stored credentials or Home-bound identity yet.
    match fs::symlink_metadata(home) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return verdict,
        Err(error) => verdict.warn(
            CodexHomeMigrationWarning::HomeMetadataUnreadable,
            describe_error("Cannot inspect Codex Home metadata", &error),
        ),
    }
    let content = match fs::read_to_string(home.join("config.toml")) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            verdict.warn(
                CodexHomeMigrationWarning::ConfigUnreadable,
                describe_error("Cannot read Codex configuration for migration", &error),
            );
            None
        }
    };
    if let Some(content) = content.as_deref() {
        match content.parse::<DocumentMut>() {
            Ok(config) => check_config(&config, &mut verdict),
            Err(error) => verdict.warn(
                CodexHomeMigrationWarning::ConfigInvalid,
                describe_invalid_config(content, &error),
            ),
        }
    }
    for name in ENCRYPTED_STORAGE_FILES {
        match fs::symlink_metadata(home.join("secrets").join(name)) {
            Ok(_) => verdict.block(CodexHomeMigrationReason::EncryptedStorage),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => verdict.warn(
                CodexHomeMigrationWarning::EncryptedStorageUnreadable,
                describe_error("Cannot inspect Codex encrypted storage metadata", &error),
            ),
        }
    }
    verdict
}

/// Blocks only on credential settings that Codex resolves through the canonical
/// Home path. Unset keys keep the Codex defaults, which store CLI authentication
/// in a file inside the Home, while the encrypted store is judged by the files it
/// would have created. Malformed values are reported without exposing them.
fn check_config(config: &DocumentMut, verdict: &mut CodexHomeMigrationVerdict) {
    if let Some(value) = config.get("cli_auth_credentials_store") {
        match value.as_str() {
            Some("file" | "ephemeral") => {}
            Some(_) => verdict.block(CodexHomeMigrationReason::CliKeyringStorage),
            None => verdict.warn(
                CodexHomeMigrationWarning::ConfigValueInvalid,
                "Invalid Codex login credential storage setting; migration continues".to_owned(),
            ),
        }
    }
    if let Some(value) = config.get("mcp_oauth_credentials_store") {
        if !matches!(value.as_str(), Some("file" | "auto" | "keyring")) {
            verdict.warn(
                CodexHomeMigrationWarning::ConfigValueInvalid,
                "Invalid Codex MCP credential storage mode; migration continues".to_owned(),
            );
        }
    }
    if let Some(value) = config
        .get("features")
        .and_then(|item| item.get("secret_auth_storage"))
    {
        if value.as_bool().is_none() {
            verdict.warn(
                CodexHomeMigrationWarning::ConfigValueInvalid,
                "Invalid Codex encrypted storage setting; migration continues".to_owned(),
            );
        }
    }
    // Direct MCP OAuth keys use server name and URL. Enterprise identity keys
    // embed the canonical Home, even when MCP OAuth storage is a file.
    let has_enterprise_identity = config
        .get("mcp_servers")
        .and_then(|item| item.as_table_like())
        .is_some_and(|servers| servers.iter().any(|(name, _)| name.starts_with("ema-idp:")));
    if has_enterprise_identity {
        verdict.block(CodexHomeMigrationReason::EnterpriseIdentity);
    }
}

fn describe_error(context: &str, error: &io::Error) -> String {
    match error.raw_os_error() {
        Some(code) => format!("{context} ({:?}, os error {code})", error.kind()),
        None => format!("{context} ({:?})", error.kind()),
    }
}

fn describe_invalid_config(content: &str, error: &toml_edit::TomlError) -> String {
    match error.span() {
        Some(span) => {
            let offset = span.start.min(content.len());
            let line = content.as_bytes()[..offset]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count()
                + 1;
            format!(
                "Invalid Codex configuration at line {line}; migration continues without configuration checks"
            )
        }
        None => "Invalid Codex configuration; migration continues without configuration checks"
            .to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict_for(content: &str) -> CodexHomeMigrationVerdict {
        let mut verdict = CodexHomeMigrationVerdict::default();
        check_config(&content.parse().unwrap(), &mut verdict);
        verdict
    }

    #[test]
    fn unset_storage_settings_follow_codex_defaults_instead_of_platform_defaults() {
        for config in [
            "",
            "[features]\nsecret_auth_storage = true",
            "cli_auth_credentials_store = 'file'",
            "cli_auth_credentials_store = 'ephemeral'",
            "mcp_oauth_credentials_store = 'file'",
            "mcp_oauth_credentials_store = 'auto'",
            "mcp_oauth_credentials_store = 'keyring'",
            "mcp_oauth_credentials_store = 'file'\n[mcp_servers.test]\nurl = 'https://example.invalid/mcp'",
        ] {
            let verdict = verdict_for(config);
            assert!(verdict.allowed, "{config}");
            assert!(verdict.reasons.is_empty(), "{config}");
        }
    }

    #[test]
    fn blocks_login_storage_that_codex_keys_by_home_path() {
        for config in [
            "cli_auth_credentials_store = 'keyring'",
            "cli_auth_credentials_store = 'auto'",
            // An unknown string is not file storage: keep the Home in place.
            "cli_auth_credentials_store = 'synthetic-sensitive-value'",
        ] {
            let verdict = verdict_for(config);
            assert!(!verdict.allowed, "{config}");
            assert_eq!(
                verdict.reasons,
                vec![CodexHomeMigrationReason::CliKeyringStorage]
            );
            let reason = verdict.reason.unwrap();
            assert!(!reason.contains("synthetic-sensitive-value"), "{config}");
        }
    }

    #[test]
    fn blocks_enterprise_identity_even_with_file_storage() {
        let verdict = verdict_for(
            "mcp_oauth_credentials_store = 'file'\n[mcp_servers.'ema-idp:example']\nurl = 'https://example.invalid/mcp'",
        );
        assert!(!verdict.allowed);
        assert_eq!(
            verdict.reasons,
            vec![CodexHomeMigrationReason::EnterpriseIdentity]
        );
    }

    #[test]
    fn reports_malformed_storage_settings_without_exposing_values() {
        for config in [
            "cli_auth_credentials_store = 42",
            "mcp_oauth_credentials_store = 'synthetic-sensitive-value'",
            "[features]\nsecret_auth_storage = 'synthetic-sensitive-value'",
        ] {
            let verdict = verdict_for(config);
            assert!(verdict.allowed, "{config}");
            assert_eq!(
                verdict.warnings,
                vec![CodexHomeMigrationWarning::ConfigValueInvalid]
            );
            assert!(!verdict
                .warning
                .unwrap_or_default()
                .contains("synthetic-sensitive-value"));
        }
    }

    #[test]
    fn blocks_encrypted_storage_without_opening_credential_files() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("secrets")).unwrap();
        for name in ENCRYPTED_STORAGE_FILES {
            // A directory proves the verdict only inspects metadata.
            let file = root.path().join("secrets").join(name);
            fs::create_dir(&file).unwrap();
            let verdict = check(root.path());
            assert!(!verdict.allowed, "{name}");
            assert_eq!(
                verdict.reasons,
                vec![CodexHomeMigrationReason::EncryptedStorage]
            );
            fs::remove_dir(file).unwrap();
        }
        assert!(check(root.path()).allowed);
    }

    #[test]
    fn moves_a_home_without_home_bound_credential_evidence() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        fs::create_dir_all(home.join("sessions")).unwrap();
        fs::write(home.join("auth.json"), "{}\n").unwrap();
        fs::write(
            home.join("config.toml"),
            "model = 'example'\n[features]\nsecret_auth_storage = true",
        )
        .unwrap();
        let entries = fs::read_dir(&home).unwrap().count();
        let verdict = check(&home);
        assert!(verdict.allowed);
        assert!(verdict.reasons.is_empty());
        assert!(verdict.warnings.is_empty());
        assert_eq!(fs::read_dir(&home).unwrap().count(), entries);
        assert!(!home.join("secrets").exists());
    }

    #[test]
    fn handles_a_missing_or_uninitialized_home() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("missing");
        assert!(check(&home).allowed);
        fs::create_dir(&home).unwrap();
        let verdict = check(&home);
        assert!(verdict.allowed);
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    }

    #[test]
    fn rejects_a_relative_home() {
        let verdict = check(Path::new("codex"));
        assert!(!verdict.allowed);
        assert_eq!(
            verdict.reasons,
            vec![CodexHomeMigrationReason::HomeNotAbsolute]
        );
    }

    #[test]
    fn reports_invalid_configuration_without_exposing_it() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        fs::create_dir(&home).unwrap();
        fs::write(
            home.join("config.toml"),
            "model = 1\nbroken = [ synthetic-sensitive-value",
        )
        .unwrap();
        let verdict = check(&home);
        assert!(verdict.allowed);
        assert_eq!(
            verdict.warnings,
            vec![CodexHomeMigrationWarning::ConfigInvalid]
        );
        let warning = verdict.warning.unwrap();
        assert!(warning.contains("line "), "{warning}");
        assert!(!warning.contains("synthetic-sensitive-value"));
    }

    #[cfg(unix)]
    #[test]
    fn reports_unreadable_metadata_without_blocking_the_move() {
        use std::os::unix::fs::PermissionsExt;

        // A Home below a regular file cannot be inspected on Unix.
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("config.toml");
        fs::write(&file, "model = 'example'\n").unwrap();
        let verdict = check(&file.join("codex"));
        assert!(verdict.allowed);
        assert!(verdict
            .warnings
            .contains(&CodexHomeMigrationWarning::HomeMetadataUnreadable));

        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = check(&home);
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        // Root ignores directory permissions, so only assert when the probe failed.
        if !unreadable.warnings.is_empty() {
            assert!(unreadable.allowed);
            assert!(unreadable
                .warnings
                .contains(&CodexHomeMigrationWarning::ConfigUnreadable));
        }
    }

    #[test]
    fn reads_only_configuration_and_leaves_home_untouched() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        fs::create_dir(&home).unwrap();
        fs::create_dir(home.join("auth.json")).unwrap();
        let entries = fs::read_dir(&home).unwrap().count();
        assert!(check(&home).allowed);
        assert_eq!(fs::read_dir(&home).unwrap().count(), entries);
        assert!(!home.join("config.toml").exists());
    }
}

//! Where the viewer's files live.
//!
//! The viewer is plain ES modules served straight off disk — there is no build
//! step to have forgotten, so "does this directory hold the viewer" is a
//! question about one file.

use std::path::{Path, PathBuf};

use anyhow::Result;

/// The viewer directory: the one given, or the one shipped with this crate.
pub fn dir(explicit: Option<PathBuf>) -> Result<PathBuf> {
    let dir = explicit.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ui"));
    anyhow::ensure!(
        dir.join("index.html").is_file(),
        "no index.html in {} — is that the viewer directory?",
        dir.display(),
    );
    Ok(dir)
}

/// The crate root, checked, so a typo fails before anything is written.
pub fn crate_root(given: &Path) -> Result<PathBuf> {
    let root = given
        .canonicalize()
        .map_err(|e| anyhow::anyhow!("no such directory: {} ({e})", given.display()))?;
    anyhow::ensure!(
        root.join("src").is_dir(),
        "no src/ under {} — that is not a crate root",
        root.display(),
    );
    Ok(root)
}

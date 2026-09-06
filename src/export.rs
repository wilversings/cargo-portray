//! Writing the viewer out as a static site.
//!
//! Everything the page needs is already static except the model, which it
//! normally fetches from `/api/graph`. Write that model to a file beside the
//! page and rewrite one `<meta>` tag, and the directory can be dropped on
//! GitHub Pages, or any static host, with no server of ours behind it. All
//! the filtering happens in the browser either way, so the hosted diagram is
//! as interactive as the local one — it just cannot notice a source file
//! changing.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// The `<meta>` content `ui/index.html` carries, and what it becomes.
///
/// Rewriting the tag rather than templating the page keeps the served and
/// exported viewers byte-identical everywhere else, so a bug can never be in
/// only one of them.
const LIVE_SOURCE: &str = "content=\"api/graph\"";
const STATIC_SOURCE: &str = "content=\"graph.json\"";

pub fn run(crate_root: &Path, out: &Path, ui_dir: Option<PathBuf>) -> Result<()> {
    let crate_root = crate::ui::crate_root(crate_root)?;
    let ui_dir = crate::ui::dir(ui_dir)?;
    prepare(out)?;

    let graph = crate::extract::extract(&crate_root)?;
    let nodes = graph.nodes.len();
    let edges = graph.edges.len();
    std::fs::write(out.join("graph.json"), serde_json::to_vec(&graph)?)
        .with_context(|| format!("writing {}", out.join("graph.json").display()))?;

    let copied = copy_tree(&ui_dir, out)?;
    write_index(&ui_dir.join("index.html"), &out.join("index.html"))?;

    // GitHub Pages runs the output through Jekyll unless this file is there,
    // and Jekyll silently drops anything whose name starts with an underscore.
    // Nothing here is named that way today; the file costs nothing and means a
    // future addition cannot vanish in transit.
    std::fs::write(out.join(".nojekyll"), b"").context("writing .nojekyll")?;

    eprintln!(
        "wrote {}: {nodes} nodes, {edges} edges, {copied} viewer files",
        out.display()
    );
    eprintln!("serve it with any static file server, or push the directory to GitHub Pages");
    Ok(())
}

/// Makes sure `out` is somewhere we may write a whole site into.
///
/// Deliberately never deletes: exporting over a directory that holds something
/// else is a mistake worth stopping for, not one worth resolving by guessing
/// which files were ours.
fn prepare(out: &Path) -> Result<()> {
    if !out.exists() {
        return std::fs::create_dir_all(out).with_context(|| format!("creating {}", out.display()));
    }
    anyhow::ensure!(out.is_dir(), "{} is a file, not a directory", out.display());

    let empty = std::fs::read_dir(out)
        .with_context(|| format!("reading {}", out.display()))?
        .next()
        .is_none();
    let previous_export = out.join("index.html").is_file() && out.join("graph.json").is_file();
    anyhow::ensure!(
        empty || previous_export,
        "{} already holds something that is not a previous export — \
         give the site a directory of its own",
        out.display(),
    );
    Ok(())
}

/// Copies `from` into `to`, recursively, returning how many files were written.
fn copy_tree(from: &Path, to: &Path) -> Result<usize> {
    let mut count = 0;
    for entry in std::fs::read_dir(from).with_context(|| format!("reading {}", from.display()))? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&target)
                .with_context(|| format!("creating {}", target.display()))?;
            count += copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)
                .with_context(|| format!("writing {}", target.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

/// Copies the page over its plain copy, pointed at the model file.
fn write_index(source: &Path, target: &Path) -> Result<()> {
    let html =
        std::fs::read_to_string(source).with_context(|| format!("reading {}", source.display()))?;
    anyhow::ensure!(
        html.contains(LIVE_SOURCE),
        "{} no longer contains {LIVE_SOURCE}, so an export would have no way to tell \
         the page where its model is",
        source.display(),
    );
    std::fs::write(target, html.replace(LIVE_SOURCE, STATIC_SOURCE))
        .with_context(|| format!("writing {}", target.display()))
}

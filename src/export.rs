//! Writing the viewer out as a static site.
//!
//! Everything the page needs is already static except the model, which it
//! normally fetches from `/api/graph`. Write that model to a file beside the
//! page and rewrite one `<meta>` tag, and the directory can be dropped on
//! GitHub Pages, or any static host, with no server of ours behind it. All
//! the filtering happens in the browser either way, so the hosted diagram is
//! as interactive as the local one — it just cannot notice a source file
//! changing.
//!
//! Where `-o` names an `.html` file rather than a directory, the same viewer
//! is folded into that one file instead; `src/inline.rs` says how, and why a
//! directory is still what a host wants.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// The `<meta>` content `ui/index.html` carries, and what it becomes.
///
/// Rewriting the tag rather than templating the page keeps the served and
/// exported viewers byte-identical everywhere else, so a bug can never be in
/// only one of them.
pub(crate) const LIVE_SOURCE: &str = "content=\"api/graph\"";
const STATIC_SOURCE: &str = "content=\"graph.json\"";

pub fn run(
    crate_root: &Path,
    out: &Path,
    scope: &crate::extract::Scope,
    ui_dir: Option<PathBuf>,
) -> Result<()> {
    let crate_root = crate::ui::crate_root(crate_root)?;
    let ui_dir = crate::ui::dir(ui_dir)?;
    if one_file(out) {
        return single(&crate_root, out, scope, &ui_dir);
    }
    prepare(out)?;

    let graph = crate::extract::extract(&crate_root, scope)?;
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

/// Whether `-o` asked for a page rather than a directory.
///
/// The extension is the whole of the question: a site is a directory and a
/// page is a file, so `-o site` and `-o portray.html` already say which is
/// wanted and a flag would only be a second way to say it.
fn one_file(out: &Path) -> bool {
    out.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
}

/// Writes the viewer, its model and everything it loads into one page.
fn single(
    crate_root: &Path,
    out: &Path,
    scope: &crate::extract::Scope,
    ui_dir: &Path,
) -> Result<()> {
    prepare_page(out)?;
    let graph = crate::extract::extract(crate_root, scope)?;
    let nodes = graph.nodes.len();
    let edges = graph.edges.len();

    let page = crate::inline::page(&ui_dir.join("index.html"))?;
    let html = replace_once(&page.html, LIVE_SOURCE, INLINE_SOURCE)?;
    // A module script is deferred, so the model can go last and still be there
    // before a line of the viewer runs.
    let html = replace_once(
        &html,
        "</body>",
        &format!(
            "{}\n  </body>",
            model_script(&serde_json::to_string(&graph)?)
        ),
    )?;
    std::fs::write(out, &html).with_context(|| format!("writing {}", out.display()))?;

    eprintln!(
        "wrote {}: {nodes} nodes, {edges} edges, {} viewer modules, {}",
        out.display(),
        page.modules,
        size(html.len()),
    );
    eprintln!("it needs nothing beside it: open it from disk, or send it to someone");
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

/// The same care as `prepare`, for a path that is one file rather than a tree.
///
/// A page is easier to aim at something that matters than a directory is —
/// `-o index.html` in the wrong terminal — so an existing file is written over
/// only when it is one of ours. The `<meta>` the export writes is the mark,
/// and it stands in the first few hundred bytes of the page.
fn prepare_page(out: &Path) -> Result<()> {
    if let Some(parent) = out.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    if !out.exists() {
        return Ok(());
    }
    // A directory with that name is almost always the site an older export
    // wrote there, so say which mistake it is rather than only that it is one.
    anyhow::ensure!(
        out.is_file(),
        "{} is a directory — a site was exported there once. Remove it, or give \
         the page a name of its own",
        out.display(),
    );
    let existing = std::fs::read_to_string(out).unwrap_or_default();
    anyhow::ensure!(
        existing
            .get(..4096)
            .unwrap_or(&existing)
            .contains(INLINE_SOURCE_MARK),
        "{} is not a previous export — give the page a name of its own",
        out.display(),
    );
    Ok(())
}

/// What the `<meta>` becomes when the model is in the page itself, and what
/// `prepare_page` recognises a page of ours by.
const INLINE_SOURCE: &str = "content=\"inline\"";
const INLINE_SOURCE_MARK: &str = "name=\"portray-source\" content=\"inline\"";

/// The model, written where the page can read it instead of fetching it.
///
/// `<` only ever appears inside a JSON string — a doc comment full of generics
/// is exactly where it comes from — so escaping every one of them is both safe
/// and enough to keep the model from ending the script it sits in.
fn model_script(model: &str) -> String {
    format!(
        "<script type=\"application/json\" id=\"portray-model\">{}</script>",
        model.replace('<', "\\u003c"),
    )
}

/// Rewrites the one occurrence of `needle`, or says why it could not.
///
/// Both edits below are the same bargain the directory export makes: the page
/// is taken as it stands and one thing about it is changed, so an edit to
/// `index.html` that moves either one stops the export rather than producing a
/// page that loads and then has nothing to draw.
fn replace_once(html: &str, needle: &str, with: &str) -> Result<String> {
    anyhow::ensure!(
        html.matches(needle).count() == 1,
        "the viewer's index.html no longer holds exactly one `{needle}`, which a \
         one-file export needs to find",
    );
    Ok(html.replacen(needle, with, 1))
}

/// A byte count, in the unit a person would say it in.
fn size(bytes: usize) -> String {
    if bytes >= 1_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    } else {
        format!("{} kB", bytes / 1000)
    }
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

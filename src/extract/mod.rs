//! Driving the two passes over a crate's sources.

pub mod calls;
pub mod types;
pub mod visitor;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Barrier, Mutex, OnceLock};
use std::time::Instant;

use anyhow::Result;
use syn::visit::{self, Visit};

use crate::extract::calls::{MethodOwner, PendingCall};
use crate::model::{Edge, Graph, Node, NodeKind};
use crate::resolve::{collect_use_maps, Index, Resolver, UseMap};
use visitor::{is_test_mod, Collector};

/// Which modules a run reads at all.
///
/// This is not a filter. Every filter in this tool lives in the viewer, where
/// changing one is a click; a scope is the opposite thing — it says which
/// source files are opened, so a crate too big to parse, ship as JSON and lay
/// out in a browser can be read a module at a time. Within a scope the tool
/// behaves as though the rest of the crate were another crate entirely: names
/// defined outside it do not resolve, exactly as a `serde` type does not, and
/// so no edge points at them.
#[derive(Debug, Default, Clone)]
pub struct Scope {
    /// Module paths, split into segments. Empty means the whole crate.
    entries: Vec<Vec<String>>,
}

impl Scope {
    /// Accepts either spelling of a module path — `actions::power` as Rust
    /// writes it, or `actions/power` as the shell completes it.
    pub fn new(paths: &[String]) -> Result<Self> {
        let mut entries = Vec::new();
        for path in paths {
            let mut segments: Vec<String> = path
                .replace('/', "::")
                .split("::")
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect();
            // `crate::actions` and `actions` name the same module; anywhere
            // else `crate` is an ordinary segment and stays.
            if segments.first().is_some_and(|first| first == "crate") {
                segments.remove(0);
            }
            anyhow::ensure!(
                !segments.is_empty(),
                "`{path}` does not name a module; write it as `actions` or `actions::power`"
            );
            entries.push(segments);
        }
        Ok(Scope { entries })
    }

    pub fn is_everything(&self) -> bool {
        self.entries.is_empty()
    }

    /// True when items written in `module` are inside the scope.
    fn contains(&self, module: &[String]) -> bool {
        self.entries.is_empty()
            || self
                .entries
                .iter()
                .any(|entry| module.starts_with(entry.as_slice()))
    }

    /// True when `module` is in scope *or* an ancestor of something in it —
    /// which is the question a file and a `mod` block ask, since `src/lib.rs`
    /// is where `mod actions` is written and an inline `mod` is where the
    /// scoped items live.
    fn may_contain(&self, module: &[String]) -> bool {
        self.contains(module) || self.entries.iter().any(|entry| entry.starts_with(module))
    }

    /// Fails when a scope entry names no module, with the siblings it could
    /// have meant. `seen` is every module actually walked; `declared` is every
    /// module the file layout has, which is where the suggestion comes from
    /// because `seen` has been narrowed by this very scope.
    fn check_matched(&self, seen: &BTreeSet<String>, declared: &BTreeSet<String>) -> Result<()> {
        for entry in &self.entries {
            let wanted = entry.join("::");
            let matched = seen
                .iter()
                .any(|module| module == &wanted || module.starts_with(&format!("{wanted}::")));
            if matched {
                continue;
            }
            let parent = match wanted.rfind("::") {
                Some(idx) => &wanted[..idx],
                None => "",
            };
            let mut siblings: Vec<&str> = declared
                .iter()
                .filter(|module| {
                    let module_parent = match module.rfind("::") {
                        Some(idx) => &module[..idx],
                        None => "",
                    };
                    module_parent == parent
                })
                .map(String::as_str)
                .collect();
            if siblings.is_empty() {
                siblings = declared.iter().map(String::as_str).collect();
            }
            anyhow::bail!(
                "no module `{wanted}` in this crate{}",
                if siblings.is_empty() {
                    String::new()
                } else {
                    format!(" — try one of: {}", siblings.join(", "))
                }
            );
        }
        Ok(())
    }

    /// The scope in one phrase, for the line the server prints on startup.
    pub fn describe(&self) -> String {
        self.display().join(", ")
    }

    /// The scope as the model carries it, `::`-joined.
    fn display(&self) -> Vec<String> {
        self.entries.iter().map(|entry| entry.join("::")).collect()
    }
}

/// Phase timings, printed when `PORTRAY_TIMING` is set.
///
/// Extraction is one straight line of passes, so knowing which pass owns the
/// wall clock is the whole story; anything finer belongs in a profiler.
struct Timing {
    on: bool,
    start: Instant,
    last: Instant,
}

impl Timing {
    fn start() -> Self {
        let now = Instant::now();
        Timing {
            on: std::env::var_os("PORTRAY_TIMING").is_some(),
            start: now,
            last: now,
        }
    }

    fn mark(&mut self, label: &str) {
        let now = Instant::now();
        if self.on {
            eprintln!(
                "  {label:<14} {:>8.1} ms",
                now.duration_since(self.last).as_secs_f64() * 1000.0
            );
        }
        self.last = now;
    }

    fn total(&self) {
        if self.on {
            eprintln!(
                "  {:<14} {:>8.1} ms",
                "TOTAL",
                self.start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
}

/// Walks a crate's `src` tree and builds the graph.
///
/// The work is split by file across the machine's cores. That split is not
/// free to arrange, because a parsed `syn::File` is not `Send` — proc-macro2
/// pins its spans to one thread — so a file cannot be parsed here and walked
/// there. Each worker therefore keeps the files it parsed for the whole run
/// and both passes happen on that thread, with one rendezvous in the middle
/// where the crate-wide index every worker needs for pass 2 is merged.
pub fn extract(crate_root: &Path, scope: &Scope) -> Result<Graph> {
    let mut timing = Timing::start();
    let src_root = crate_root.join("src");
    anyhow::ensure!(
        src_root.is_dir(),
        "{} has no src/ directory",
        crate_root.display()
    );

    let mut files = Vec::new();
    collect_rust_files(&src_root, &mut files);

    // Every module the file layout declares, kept before the scope narrows
    // things down so that a scope naming a module that is not there can be
    // answered with the ones that are.
    let declared: BTreeSet<String> = files
        .iter()
        .map(|path| module_prefix_for(path, &src_root).join("::"))
        .filter(|module| !module.is_empty())
        .collect();

    // Files outside the scope are never opened. That is the whole point of a
    // scope: on a crate with ten thousand files, not parsing the nine
    // thousand you are not reading is the difference that makes it usable.
    files.retain(|path| scope.may_contain(&module_prefix_for(path, &src_root)));
    timing.mark("walk");

    let shares = share_out(&files);
    let workers = worker_count(shares.len());
    let first: Vec<Mutex<Pass1>> = shares.iter().map(|_| Mutex::default()).collect();
    let second: Vec<Mutex<Pass2>> = shares.iter().map(|_| Mutex::default()).collect();
    let next = AtomicUsize::new(0);
    // Set once pass 1 has been merged, and the signal that pass 2 may start.
    // Left empty when the scope check fails, which is how the workers learn
    // there is nothing more to do.
    let merged: OnceLock<(Index, BTreeMap<String, UseMap>)> = OnceLock::new();
    let rendezvous = Barrier::new(workers + 1);

    let mut outcome: Result<()> = Ok(());
    std::thread::scope(|threads| {
        for _ in 0..workers {
            let (shares, first, second) = (&shares, &first, &second);
            let (merged, rendezvous, next) = (&merged, &rendezvous, &next);
            let (crate_root, src_root) = (crate_root, &src_root);
            threads.spawn(move || {
                // Shares are claimed rather than dealt out. One source file
                // can be a hundred times the size of another — the `windows`
                // crate has a 3.5 MB one — so a fixed deal leaves most of the
                // machine waiting on whichever worker drew the big files.
                let mut mine = Vec::new();
                loop {
                    let taken = next.fetch_add(1, Ordering::Relaxed);
                    let Some(share) = shares.get(taken) else {
                        break;
                    };
                    let parsed = parse_share(share, crate_root, src_root);
                    if let Some(slot) = first.get(taken) {
                        store(slot, index_share(&parsed, scope));
                    }
                    mine.push((taken, parsed));
                }

                // Everything below needs the whole crate's index, so this is
                // where a worker waits for the others to catch up. The second
                // wait is the main thread handing back the merged result.
                rendezvous.wait();
                rendezvous.wait();
                let Some((index, use_maps)) = merged.get() else {
                    return;
                };
                for (taken, parsed) in &mine {
                    if let Some(slot) = second.get(*taken) {
                        store(slot, collect_share(parsed, index, use_maps, scope));
                    }
                }
            });
        }

        rendezvous.wait();
        timing.mark("parse+index");

        let (index, use_maps, seen) = merge_first(&first);
        // A module can be a file or an inline `mod` block, so whether the
        // scope named a real one is only knowable once pass 1 has walked
        // both. Saying so beats handing back an empty diagram for a typo.
        match scope.check_matched(&seen, &declared) {
            Ok(()) => {
                let _ = merged.set((index, use_maps));
            }
            Err(error) => outcome = Err(error),
        }
        // Unconditional: the workers are parked on it, and a failed scope
        // check must release them rather than hang the program.
        rendezvous.wait();
    });
    outcome?;

    timing.mark("collect");

    let Some((index, use_maps)) = merged.get() else {
        // Only reachable when the scope check failed, which `outcome?` above
        // has already returned.
        anyhow::bail!("extraction produced nothing");
    };
    let resolver = Resolver { index };
    let graph = finish(
        merge_second(&second),
        &resolver,
        use_maps,
        crate_name(crate_root),
        scope.display(),
    );
    timing.mark("calls");
    timing.total();
    Ok(graph)
}

/// What one worker produces in pass 1.
#[derive(Default)]
struct Pass1 {
    index: Index,
    use_maps: BTreeMap<String, UseMap>,
    seen: BTreeSet<String>,
}

/// What one worker produces in pass 2 — the same four things a single
/// `Collector` used to hold, for its share of the files.
#[derive(Default)]
struct Pass2 {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    pending_calls: Vec<PendingCall>,
    method_owners: Vec<MethodOwner>,
}

/// Splits the files into contiguous shares, several per core.
///
/// This one cannot go through `par::map_chunks`, because a worker has to hold
/// on to what it parsed across the rendezvous in the middle of `extract`.
fn share_out(files: &[PathBuf]) -> Vec<&[PathBuf]> {
    crate::par::chunks(files, crate::par::cores() * 8)
}

fn worker_count(shares: usize) -> usize {
    crate::par::cores().min(shares).max(1)
}

/// A poisoned lock means a worker panicked, and there is nothing useful to
/// merge from it; the rest of the run still stands.
fn store<T>(slot: &Mutex<T>, value: T) {
    if let Ok(mut held) = slot.lock() {
        *held = value;
    }
}

fn parse_share(share: &[PathBuf], crate_root: &Path, src_root: &Path) -> Vec<ParsedFile> {
    share
        .iter()
        .filter_map(|path| {
            let content = fs::read_to_string(path).ok()?;
            let file = syn::parse_file(&content).ok()?;
            let display = path
                .strip_prefix(crate_root)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();
            Some(ParsedFile {
                module: module_prefix_for(path, src_root),
                display,
                file,
            })
        })
        .collect()
}

/// Pass 1 over one share: what these files define, and what each of their
/// modules imports.
fn index_share(parsed: &[ParsedFile], scope: &Scope) -> Pass1 {
    let mut out = Pass1::default();
    for parsed in parsed {
        let module = parsed.module.join("::");
        out.seen.insert(module.clone());
        IndexCollector {
            index: &mut out.index,
            mod_stack: parsed.module.clone(),
            scope,
            seen: &mut out.seen,
        }
        .visit_file(&parsed.file);
        collect_use_maps(&parsed.file, &module, &mut out.use_maps);
    }
    out
}

/// Pass 2 over one share: nodes and edges, with every name resolved against
/// the whole crate's pass 1.
fn collect_share(
    parsed: &[ParsedFile],
    index: &Index,
    use_maps: &BTreeMap<String, UseMap>,
    scope: &Scope,
) -> Pass2 {
    let resolver = Resolver { index };
    let mut collector = Collector::new(&resolver, use_maps, scope);
    for parsed in parsed {
        collector.run(&parsed.file, &parsed.display, &parsed.module);
    }
    // Sorted here, on the worker, rather than once at the end on the whole
    // crate. The merge below then has runs to work with instead of a shuffled
    // pile, and this is the only part of the ordering work that parallelises.
    let mut nodes = collector.nodes;
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    nodes.dedup_by(|a, b| a.id == b.id);
    let mut edges = collector.edges;
    edges.sort_unstable();
    edges.dedup();

    Pass2 {
        nodes,
        edges,
        pending_calls: collector.pending_calls,
        method_owners: collector.method_owners,
    }
}

fn merge_first(shares: &[Mutex<Pass1>]) -> (Index, BTreeMap<String, UseMap>, BTreeSet<String>) {
    let mut index = Index::default();
    let mut use_maps: BTreeMap<String, UseMap> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for share in shares {
        let Ok(mut share) = share.lock() else {
            continue;
        };
        let share = std::mem::take(&mut *share);
        index.absorb(share.index);
        for (module, uses) in share.use_maps {
            use_maps.entry(module).or_default().absorb(uses);
        }
        seen.extend(share.seen);
    }
    (index, use_maps, seen)
}

fn merge_second(shares: &[Mutex<Pass2>]) -> Pass2 {
    let mut out = Pass2::default();
    for share in shares {
        let Ok(mut share) = share.lock() else {
            continue;
        };
        let share = std::mem::take(&mut *share);
        out.nodes.extend(share.nodes);
        out.edges.extend(share.edges);
        out.pending_calls.extend(share.pending_calls);
        out.method_owners.extend(share.method_owners);
    }
    out
}

/// Resolves the call sites gathered during the pass and hands back the graph.
///
/// Calls cannot be resolved as they are found: a function routinely calls one
/// defined three files later, so the target node id does not exist yet. This
/// runs once, when it does.
fn finish(
    collected: Pass2,
    resolver: &Resolver,
    use_maps: &BTreeMap<String, UseMap>,
    krate: String,
    scope: Vec<String>,
) -> Graph {
    let mut nodes = collected.nodes;
    // Stable, so that when two files define the same id the earlier file's
    // node is the one kept — which is what a single walk did with
    // `or_insert`, and what keeps the output independent of the thread
    // scheduling that produced it.
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    nodes.dedup_by(|a, b| a.id == b.id);

    let mut edges = collected.edges;
    edges.extend(calls::resolve_calls(
        &collected.pending_calls,
        &collected.method_owners,
        &nodes,
        resolver,
        use_maps,
    ));
    // Stable rather than unstable, even though equal edges are
    // interchangeable: the shares arrive already sorted, and a stable sort is
    // the one that notices and merges the runs instead of re-sorting them.
    edges.sort();
    edges.dedup();

    Graph {
        krate,
        root: "src".to_string(),
        scope,
        nodes,
        edges,
    }
}

struct ParsedFile {
    module: Vec<String>,
    display: String,
    file: syn::File,
}

/// Reads `name = "..."` out of the `[package]` table without pulling in a
/// TOML parser for one field.
fn crate_name(crate_root: &Path) -> String {
    let fallback = || {
        crate_root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "crate".to_string())
    };
    let Ok(manifest) = fs::read_to_string(crate_root.join("Cargo.toml")) else {
        return fallback();
    };
    let mut in_package = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if in_package {
            if let Some(value) = line.strip_prefix("name") {
                if let Some(quoted) = value.split('"').nth(1) {
                    return quoted.to_string();
                }
            }
        }
    }
    fallback()
}

fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect_rust_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// Maps a source file path to the module path it defines, assuming the
/// standard `foo.rs` / `foo/mod.rs` layout. `#[path]` attributes are not
/// honoured.
pub fn module_prefix_for(path: &Path, src_root: &Path) -> Vec<String> {
    let rel = path.strip_prefix(src_root).unwrap_or(path);
    let mut comps: Vec<String> = rel
        .with_extension("")
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if comps.last().map(|s| s == "mod").unwrap_or(false) {
        comps.pop();
    }
    if comps.len() == 1 && (comps[0] == "lib" || comps[0] == "main") {
        comps.clear();
    }
    comps
}

/// Pass 1: record every type-like item so pass 2 can tell a local name from a
/// foreign one, and tell two same-named locals apart.
struct IndexCollector<'a> {
    index: &'a mut Index,
    mod_stack: Vec<String>,
    scope: &'a Scope,
    /// Every module walked, inline `mod` blocks included, so that a scope can
    /// be told it named nothing.
    seen: &'a mut BTreeSet<String>,
}

impl<'a> IndexCollector<'a> {
    fn module(&self) -> String {
        self.mod_stack.join("::")
    }

    /// A name outside the scope is not indexed, so nothing resolves to it and
    /// no edge can point at it — the same treatment another crate's types get.
    fn in_scope(&self) -> bool {
        self.scope.contains(&self.mod_stack)
    }
}

impl<'ast, 'a> Visit<'ast> for IndexCollector<'a> {
    fn visit_item_mod(&mut self, i: &'ast syn::ItemMod) {
        if is_test_mod(i) {
            return;
        }
        self.mod_stack.push(i.ident.to_string());
        if self.scope.may_contain(&self.mod_stack) {
            self.seen.insert(self.module());
            visit::visit_item_mod(self, i);
        }
        self.mod_stack.pop();
    }

    fn visit_item_struct(&mut self, i: &'ast syn::ItemStruct) {
        if !self.in_scope() {
            return;
        }
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::Struct);
        visit::visit_item_struct(self, i);
    }

    fn visit_item_enum(&mut self, i: &'ast syn::ItemEnum) {
        if !self.in_scope() {
            return;
        }
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::Enum);
        visit::visit_item_enum(self, i);
    }

    fn visit_item_trait(&mut self, i: &'ast syn::ItemTrait) {
        if !self.in_scope() {
            return;
        }
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::Trait);
        visit::visit_item_trait(self, i);
    }

    fn visit_item_type(&mut self, i: &'ast syn::ItemType) {
        if !self.in_scope() {
            return;
        }
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::TypeAlias);
    }
}

/// Runs both passes over source text held in memory, one entry per module.
/// Used by the tests, which need fixtures small enough to reason about.
#[cfg(test)]
pub fn extract_sources(sources: &[(&str, &str)]) -> Result<Graph> {
    extract_sources_in(sources, &Scope::default())
}

#[cfg(test)]
pub fn extract_sources_in(sources: &[(&str, &str)], scope: &Scope) -> Result<Graph> {
    use anyhow::Context;

    let declared: BTreeSet<String> = sources
        .iter()
        .map(|(module, _)| module.to_string())
        .filter(|module| !module.is_empty())
        .collect();

    let parsed: Vec<ParsedFile> = sources
        .iter()
        .filter(|(module, _)| {
            let segments: Vec<String> = if module.is_empty() {
                Vec::new()
            } else {
                module.split("::").map(String::from).collect()
            };
            scope.may_contain(&segments)
        })
        .map(|(module, src)| {
            let file = syn::parse_file(src)
                .with_context(|| format!("failed to parse fixture module `{module}`"))?;
            let segments: Vec<String> = if module.is_empty() {
                Vec::new()
            } else {
                module.split("::").map(String::from).collect()
            };
            let display = if segments.is_empty() {
                "src/lib.rs".to_string()
            } else {
                format!("src/{}.rs", segments.join("/"))
            };
            Ok(ParsedFile {
                module: segments,
                display,
                file,
            })
        })
        .collect::<Result<_>>()?;

    // One share, so the fixture goes through the same two passes a real run
    // does without the threads in between.
    let first = index_share(&parsed, scope);
    scope.check_matched(&first.seen, &declared)?;

    let resolver = Resolver {
        index: &first.index,
    };
    let collected = collect_share(&parsed, &first.index, &first.use_maps, scope);

    Ok(finish(
        collected,
        &resolver,
        &first.use_maps,
        "fixture".to_string(),
        scope.display(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Edge, Rel, Via};

    fn graph(sources: &[(&str, &str)]) -> Graph {
        extract_sources(sources).expect("fixture should parse")
    }

    /// Every edge between two ids, ignoring ports.
    fn edges_between<'a>(g: &'a Graph, from: &str, to: &str) -> Vec<&'a Edge> {
        g.edges
            .iter()
            .filter(|e| e.from == from && e.to == to)
            .collect()
    }

    fn node_kind(g: &Graph, id: &str) -> Option<NodeKind> {
        g.nodes.iter().find(|n| n.id == id).map(|n| n.kind)
    }

    #[test]
    fn generic_arguments_are_distinguished_from_direct_uses() {
        let g = graph(&[(
            "",
            r#"
            pub struct Foo;
            pub fn direct() -> Foo { Foo }
            pub fn wrapped() -> Vec<Foo> { Vec::new() }
            "#,
        )]);

        let direct = edges_between(&g, "direct", "Foo");
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].rel, Rel::Return);
        assert_eq!(direct[0].via, Via::Direct);

        let wrapped = edges_between(&g, "wrapped", "Foo");
        assert_eq!(wrapped.len(), 1);
        assert_eq!(wrapped[0].rel, Rel::Return);
        assert_eq!(wrapped[0].via, Via::Generic);
    }

    #[test]
    fn a_reference_is_still_a_direct_use() {
        let g = graph(&[(
            "",
            r#"
            pub struct Foo;
            pub fn borrow(f: &Foo) {}
            "#,
        )]);
        let edges = edges_between(&g, "borrow", "Foo");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].via, Via::Direct);
        assert_eq!(edges[0].rel, Rel::Param);
    }

    #[test]
    fn trait_objects_are_marked_dyn() {
        let g = graph(&[(
            "",
            r#"
            pub trait Action {}
            pub fn run(a: Box<dyn Action>) {}
            "#,
        )]);
        let edges = edges_between(&g, "run", "Action");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].via, Via::Dyn);
    }

    #[test]
    fn generic_parameters_do_not_become_nodes() {
        let g = graph(&[(
            "",
            r#"
            pub struct T;
            pub fn generic<T>(t: T) {}
            "#,
        )]);
        // `T` in the signature is the parameter, not the struct next to it.
        assert!(edges_between(&g, "generic", "T").is_empty());
    }

    #[test]
    fn a_use_statement_picks_between_same_named_types() {
        let g = graph(&[
            ("a", "pub struct Error;"),
            ("b", "pub struct Error;"),
            (
                "c",
                r#"
                use crate::a::Error;
                pub fn fails() -> Error { Error }
                "#,
            ),
        ]);
        assert_eq!(edges_between(&g, "c::fails", "a::Error").len(), 1);
        assert!(edges_between(&g, "c::fails", "b::Error").is_empty());
    }

    #[test]
    fn an_unimportable_name_is_flagged_ambiguous() {
        let g = graph(&[
            ("a", "pub struct Error;"),
            ("b", "pub struct Error;"),
            ("c", "pub fn fails() -> Error { todo!() }"),
        ]);
        let edges: Vec<_> = g.edges.iter().filter(|e| e.from == "c::fails").collect();
        assert_eq!(edges.len(), 1);
        assert!(edges[0].ambiguous, "a name with two definitions is a guess");
    }

    #[test]
    fn a_type_defined_in_the_same_module_wins_over_an_import() {
        let g = graph(&[
            ("a", "pub struct Error;"),
            (
                "b",
                r#"
                use crate::a::Error as Imported;
                pub struct Error;
                pub fn fails() -> Error { Error }
                "#,
            ),
        ]);
        assert_eq!(edges_between(&g, "b::fails", "b::Error").len(), 1);
    }

    #[test]
    fn impl_blocks_produce_an_impls_edge_and_owned_methods() {
        let g = graph(&[(
            "actions",
            r#"
            pub trait Action { fn apply(&self); }
            pub struct PowerProfile;
            impl PowerProfile { pub fn new() -> Self { PowerProfile } }
            impl Action for PowerProfile { fn apply(&self) {} }
            "#,
        )]);

        let impls = edges_between(&g, "actions::PowerProfile", "actions::Action");
        assert_eq!(impls.len(), 1);
        assert_eq!(impls[0].rel, Rel::Impls);

        assert_eq!(
            node_kind(&g, "actions::PowerProfile::new"),
            Some(NodeKind::InherentMethod)
        );
        assert_eq!(
            node_kind(&g, "actions::<PowerProfile as Action>::apply"),
            Some(NodeKind::ImplMethod)
        );
        assert_eq!(
            node_kind(&g, "actions::Action::apply"),
            Some(NodeKind::TraitMethod)
        );
    }

    #[test]
    fn self_in_a_signature_resolves_to_the_impl_type() {
        let g = graph(&[
            ("other", "pub struct Bar;"),
            (
                "actions",
                r#"
                pub struct Foo;
                pub struct Bar;
                impl Bar { pub fn of(f: Foo) -> Self { Bar } }
                "#,
            ),
        ]);
        // `-> Self` is a real return edge, and it must land on *this* Bar
        // rather than on the identically named one next door.
        let returns = edges_between(&g, "actions::Bar::of", "actions::Bar");
        assert_eq!(returns.len(), 1);
        assert_eq!(returns[0].rel, Rel::Return);
        assert!(edges_between(&g, "actions::Bar::of", "other::Bar").is_empty());

        assert_eq!(
            edges_between(&g, "actions::Bar::of", "actions::Foo").len(),
            1
        );
    }

    #[test]
    fn supertraits_and_bounds_are_edges() {
        let g = graph(&[(
            "",
            r#"
            pub trait Base {}
            pub trait Extended: Base {}
            pub struct Holder;
            pub fn constrained<T: Base>(t: T) {}
            "#,
        )]);
        let supertrait = edges_between(&g, "Extended", "Base");
        assert_eq!(supertrait.len(), 1);
        assert_eq!(supertrait[0].rel, Rel::Supertrait);

        let bound = edges_between(&g, "constrained", "Base");
        assert_eq!(bound.len(), 1);
        assert_eq!(bound[0].rel, Rel::Bound);
    }

    #[test]
    fn fields_carry_the_port_they_leave_from() {
        let g = graph(&[(
            "",
            r#"
            pub struct Key;
            pub struct Held {
                pub name: String,
                pub key: Key,
            }
            "#,
        )]);
        let edges = edges_between(&g, "Held", "Key");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].rel, Rel::Field);
        assert_eq!(edges[0].from_port.as_deref(), Some("f1"));

        let held = g.nodes.iter().find(|n| n.id == "Held").unwrap();
        assert_eq!(held.members[1].label, "key: Key");
    }

    #[test]
    fn enum_variants_are_members_with_their_own_ports() {
        let g = graph(&[(
            "",
            r#"
            pub struct ResourceKey;
            pub enum Undo {
                Nothing,
                Restore { resource: ResourceKey },
            }
            "#,
        )]);
        let edges = edges_between(&g, "Undo", "ResourceKey");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].from_port.as_deref(), Some("v1"));

        let undo = g.nodes.iter().find(|n| n.id == "Undo").unwrap();
        assert_eq!(undo.members[1].label, "Restore { resource: ResourceKey }");
    }

    #[test]
    fn test_code_is_skipped() {
        let g = graph(&[(
            "",
            r#"
            pub struct Foo;
            #[test]
            fn a_test() -> Foo { Foo }
            #[tokio::test]
            async fn an_async_test() -> Foo { Foo }
            #[cfg(test)]
            mod tests {
                use super::*;
                pub struct Helper { pub foo: Foo }
            }
            "#,
        )]);
        assert!(g.nodes.iter().all(|n| n.name != "a_test"));
        assert!(g.nodes.iter().all(|n| n.name != "an_async_test"));
        assert!(g.nodes.iter().all(|n| n.name != "Helper"));
    }

    #[test]
    fn a_cfg_that_only_holds_under_test_is_skipped() {
        let g = graph(&[(
            "",
            r#"
            #[cfg(all(test, not(loom)))]
            mod harness {
                pub struct Rig;
            }
            "#,
        )]);
        assert!(g.nodes.iter().all(|n| n.name != "Rig"));
    }

    #[test]
    fn a_feature_merely_named_after_testing_is_ordinary_code() {
        let g = graph(&[(
            "",
            r#"
            #[cfg(feature = "test-util")]
            mod util {
                pub struct Clock;
            }
            "#,
        )]);
        assert!(g.nodes.iter().any(|n| n.name == "Clock"));
    }

    #[test]
    fn a_module_compiled_everywhere_but_under_test_is_kept() {
        let g = graph(&[(
            "",
            r#"
            #[cfg(not(test))]
            mod real {
                pub struct Live;
            }
            "#,
        )]);
        assert!(g.nodes.iter().any(|n| n.name == "Live"));
    }

    #[test]
    fn a_module_that_survives_without_test_is_kept() {
        let g = graph(&[(
            "",
            r#"
            #[cfg(any(test, unix))]
            mod either {
                pub struct Both;
            }
            "#,
        )]);
        assert!(g.nodes.iter().any(|n| n.name == "Both"));
    }

    #[test]
    fn a_call_is_an_edge_from_the_function_that_makes_it() {
        let g = graph(&[(
            "",
            r#"
            pub fn helper() {}
            pub fn caller() { helper(); }
            "#,
        )]);
        let calls = edges_between(&g, "caller", "helper");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].rel, Rel::Call);
        assert_eq!(calls[0].via, Via::Direct);
        assert!(!calls[0].ambiguous);
    }

    #[test]
    fn an_associated_call_resolves_through_the_type_it_is_written_on() {
        let g = graph(&[
            (
                "a",
                "pub struct Store; impl Store { pub fn new() -> Self { Store } }",
            ),
            (
                "b",
                "pub struct Cache; impl Cache { pub fn new() -> Self { Cache } }",
            ),
            (
                "c",
                r#"
                use crate::a::Store;
                pub fn build() { let _ = Store::new(); }
                "#,
            ),
        ]);
        // Two `new`s in the crate; the written type says which one this is.
        assert_eq!(edges_between(&g, "c::build", "a::Store::new").len(), 1);
        assert!(edges_between(&g, "c::build", "b::Cache::new").is_empty());
    }

    #[test]
    fn a_method_call_resolves_by_name_when_only_one_type_defines_it() {
        let g = graph(&[(
            "",
            r#"
            pub struct Engine;
            impl Engine { pub fn spin(&self) {} }
            pub fn drive(e: &Engine) { e.spin(); }
            "#,
        )]);
        let calls = edges_between(&g, "drive", "Engine::spin");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].rel, Rel::Call);
        assert!(
            !calls[0].ambiguous,
            "one definition of the name is not a guess"
        );
    }

    #[test]
    fn a_method_call_that_could_be_either_is_flagged_rather_than_picked() {
        let g = graph(&[(
            "",
            r#"
            pub struct A;
            pub struct B;
            impl A { pub fn run(&self) {} }
            impl B { pub fn run(&self) {} }
            pub fn drive(a: &A) { a.run(); }
            "#,
        )]);
        // A receiver's type is not knowable from syntax, so both candidates
        // are drawn as guesses rather than one of them as a fact.
        for target in ["A::run", "B::run"] {
            let calls = edges_between(&g, "drive", target);
            assert_eq!(calls.len(), 1, "expected a guess at {target}");
            assert!(calls[0].ambiguous);
        }
    }

    #[test]
    fn self_calls_resolve_to_the_enclosing_impl() {
        let g = graph(&[
            ("other", "pub struct Foo; impl Foo { pub fn help() {} }"),
            (
                "here",
                r#"
                pub struct Foo;
                impl Foo {
                    pub fn help() {}
                    pub fn work() { Self::help(); }
                }
                "#,
            ),
        ]);
        assert_eq!(
            edges_between(&g, "here::Foo::work", "here::Foo::help").len(),
            1
        );
        assert!(edges_between(&g, "here::Foo::work", "other::Foo::help").is_empty());
    }

    #[test]
    fn a_call_into_another_crate_is_not_invented() {
        let g = graph(&[(
            "",
            r#"
            pub fn wait() { let _ = std::time::Duration::from_secs(1); }
            pub struct Timer;
            impl Timer { pub fn from_secs(n: u64) {} }
            "#,
        )]);
        // The name matches something local, but the path says it is not this.
        assert!(edges_between(&g, "wait", "Timer::from_secs").is_empty());
    }

    #[test]
    fn calls_made_by_test_code_are_skipped_with_it() {
        let g = graph(&[(
            "",
            r#"
            pub fn helper() {}
            #[test]
            fn a_test() { helper(); }
            "#,
        )]);
        assert!(g.edges.iter().all(|e| e.rel != Rel::Call));
    }

    #[test]
    fn signatures_keep_their_arrows() {
        let g = graph(&[(
            "",
            r#"
            pub struct Foo;
            pub fn make(count: usize) -> Vec<Foo> { Vec::new() }
            "#,
        )]);
        let make = g.nodes.iter().find(|n| n.id == "make").unwrap();
        assert_eq!(
            make.signature.as_deref(),
            Some("fn make(count: usize) -> Vec<Foo>")
        );
    }

    #[test]
    fn doc_comments_ride_along_with_the_item_and_its_members() {
        let g = graph(&[(
            "",
            r#"
            /// What a `Foo` is for.
            ///
            /// A second paragraph.
            pub struct Foo {
                /// How many.
                pub count: usize,
                pub untold: bool,
            }
            "#,
        )]);
        let foo = g.nodes.iter().find(|n| n.id == "Foo").unwrap();
        assert_eq!(
            foo.docs.as_deref(),
            Some("What a `Foo` is for.\n\nA second paragraph.")
        );
        assert_eq!(foo.members[0].docs.as_deref(), Some("How many."));
        assert_eq!(foo.members[1].docs, None);
    }

    #[test]
    fn a_block_doc_comment_keeps_its_relative_indentation() {
        let g = graph(&[(
            "",
            r#"
            /**
             * Runs it.
             *
             *     indented code
             */
            pub fn run() {}
            "#,
        )]);
        let run = g.nodes.iter().find(|n| n.id == "run").unwrap();
        // The common indent goes, the four spaces that mark code stay.
        assert_eq!(
            run.docs.as_deref(),
            Some("* Runs it.\n*\n*     indented code")
        );
    }

    #[test]
    fn an_undocumented_item_carries_no_docs() {
        let g = graph(&[("", "pub enum State { On, Off }")]);
        let state = g.nodes.iter().find(|n| n.id == "State").unwrap();
        assert_eq!(state.docs, None);
        assert!(state.members.iter().all(|m| m.docs.is_none()));
    }

    #[test]
    fn a_scope_reads_one_module_and_treats_the_rest_as_foreign() {
        let sources: &[(&str, &str)] = &[
            ("a", "pub struct Kept;"),
            ("a::inner", "use crate::b::Gone; pub fn takes(g: Gone) {}"),
            ("b", "pub struct Gone;"),
        ];
        let scope = Scope::new(&["a".to_string()]).unwrap();
        let g = extract_sources_in(sources, &scope).unwrap();

        let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"a::Kept"));
        assert!(ids.contains(&"a::inner::takes"));
        // Outside the scope is outside the crate, as far as this run is
        // concerned: no node, and so no edge either.
        assert!(!ids.contains(&"b::Gone"));
        assert!(g.edges.iter().all(|e| e.to != "b::Gone"));
        assert_eq!(g.scope, vec!["a".to_string()]);
    }

    #[test]
    fn a_scope_reaches_a_module_written_inline_in_its_parent() {
        let sources: &[(&str, &str)] = &[(
            "",
            r#"
            pub struct AtTheRoot;
            pub mod actions {
                pub struct Wanted;
            }
            "#,
        )];
        let scope = Scope::new(&["actions".to_string()]).unwrap();
        let g = extract_sources_in(sources, &scope).unwrap();

        let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["actions::Wanted"]);
    }

    #[test]
    fn a_scope_written_with_slashes_means_the_same_module() {
        let a = Scope::new(&["actions/power".to_string()]).unwrap();
        let b = Scope::new(&["actions::power".to_string()]).unwrap();
        assert_eq!(a.display(), b.display());
        assert_eq!(a.display(), vec!["actions::power".to_string()]);
    }

    #[test]
    fn no_scope_at_all_reads_the_whole_crate() {
        let g = graph(&[("a", "pub struct One;"), ("b", "pub struct Two;")]);
        assert_eq!(g.nodes.len(), 2);
        assert!(g.scope.is_empty());
    }

    #[test]
    fn a_scope_that_names_nothing_says_so_instead_of_drawing_nothing() {
        let sources: &[(&str, &str)] = &[("a", "pub struct One;"), ("b", "pub struct Two;")];
        let scope = Scope::new(&["c".to_string()]).unwrap();
        let err = extract_sources_in(sources, &scope).unwrap_err().to_string();
        assert!(err.contains("no module `c`"), "{err}");
        assert!(err.contains("a, b"), "{err}");
    }
}

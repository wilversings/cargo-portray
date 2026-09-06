//! Driving the two passes over a crate's sources.

pub mod calls;
pub mod types;
pub mod visitor;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use syn::visit::{self, Visit};

use crate::model::{Graph, NodeKind};
use crate::resolve::{collect_use_maps, Index, Resolver, UseMap};
use visitor::{is_test_mod, Collector};

/// Walks a crate's `src` tree and builds the graph.
pub fn extract(crate_root: &Path) -> Result<Graph> {
    let src_root = crate_root.join("src");
    anyhow::ensure!(
        src_root.is_dir(),
        "{} has no src/ directory",
        crate_root.display()
    );

    let mut files = Vec::new();
    collect_rust_files(&src_root, &mut files);

    let parsed: Vec<ParsedFile> = files
        .into_iter()
        .filter_map(|path| {
            let content = fs::read_to_string(&path).ok()?;
            let file = syn::parse_file(&content).ok()?;
            let display = path
                .strip_prefix(crate_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            Some(ParsedFile {
                module: module_prefix_for(&path, &src_root),
                display,
                file,
            })
        })
        .collect();

    // Pass 1: what this crate defines, and what each module imports.
    let mut index = Index::default();
    let mut use_maps: BTreeMap<String, UseMap> = BTreeMap::new();
    for parsed in &parsed {
        let module = parsed.module.join("::");
        IndexCollector {
            index: &mut index,
            mod_stack: parsed.module.clone(),
        }
        .visit_file(&parsed.file);
        collect_use_maps(&parsed.file, &module, &mut use_maps);
    }

    // Pass 2: nodes and edges, with every name resolved against pass 1.
    let resolver = Resolver { index: &index };
    let mut collector = Collector::new(&resolver, &use_maps);
    for parsed in &parsed {
        collector.run(&parsed.file, &parsed.display, &parsed.module);
    }

    Ok(finish(
        collector,
        &resolver,
        &use_maps,
        crate_name(crate_root),
    ))
}

/// Resolves the call sites gathered during the pass and hands back the graph.
///
/// Calls cannot be resolved as they are found: a function routinely calls one
/// defined three files later, so the target node id does not exist yet. This
/// runs once, when it does.
fn finish(
    collector: Collector,
    resolver: &Resolver,
    use_maps: &BTreeMap<String, UseMap>,
    krate: String,
) -> Graph {
    let mut edges = collector.edges;
    edges.extend(calls::resolve_calls(
        &collector.pending_calls,
        &collector.method_owners,
        &collector.nodes,
        resolver,
        use_maps,
    ));

    Graph {
        krate,
        root: "src".to_string(),
        nodes: collector.nodes.into_values().collect(),
        edges: edges.into_iter().collect(),
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
}

impl<'a> IndexCollector<'a> {
    fn module(&self) -> String {
        self.mod_stack.join("::")
    }
}

impl<'ast, 'a> Visit<'ast> for IndexCollector<'a> {
    fn visit_item_mod(&mut self, i: &'ast syn::ItemMod) {
        if is_test_mod(i) {
            return;
        }
        self.mod_stack.push(i.ident.to_string());
        visit::visit_item_mod(self, i);
        self.mod_stack.pop();
    }

    fn visit_item_struct(&mut self, i: &'ast syn::ItemStruct) {
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::Struct);
        visit::visit_item_struct(self, i);
    }

    fn visit_item_enum(&mut self, i: &'ast syn::ItemEnum) {
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::Enum);
        visit::visit_item_enum(self, i);
    }

    fn visit_item_trait(&mut self, i: &'ast syn::ItemTrait) {
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::Trait);
        visit::visit_item_trait(self, i);
    }

    fn visit_item_type(&mut self, i: &'ast syn::ItemType) {
        let module = self.module();
        self.index
            .insert(&module, &i.ident.to_string(), NodeKind::TypeAlias);
    }
}

/// Runs both passes over source text held in memory, one entry per module.
/// Used by the tests, which need fixtures small enough to reason about.
#[cfg(test)]
pub fn extract_sources(sources: &[(&str, &str)]) -> Result<Graph> {
    use anyhow::Context;

    let parsed: Vec<ParsedFile> = sources
        .iter()
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

    let mut index = Index::default();
    let mut use_maps: BTreeMap<String, UseMap> = BTreeMap::new();
    for parsed in &parsed {
        IndexCollector {
            index: &mut index,
            mod_stack: parsed.module.clone(),
        }
        .visit_file(&parsed.file);
        collect_use_maps(&parsed.file, &parsed.module.join("::"), &mut use_maps);
    }

    let resolver = Resolver { index: &index };
    let mut collector = Collector::new(&resolver, &use_maps);
    for parsed in &parsed {
        collector.run(&parsed.file, &parsed.display, &parsed.module);
    }

    Ok(finish(
        collector,
        &resolver,
        &use_maps,
        "fixture".to_string(),
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
}

//! Turning a name as written into the definition it refers to.
//!
//! Without this, `Error` written in three modules collapses into one node and
//! the graph lies. There is no type resolution available to a syntax-only
//! tool, so this approximates it the way a reader does: check the current
//! module, then the file's `use` statements, then the crate-wide index of
//! defined names. When more than one definition could match, the edge is
//! still emitted but flagged `ambiguous`.

use std::collections::BTreeMap;

use crate::model::NodeKind;

/// Every type-like item the crate defines.
#[derive(Debug, Default)]
pub struct Index {
    /// Fully qualified path -> what kind of item it is.
    defined: BTreeMap<String, NodeKind>,
    /// Short name -> every fully qualified path defining that name.
    by_name: BTreeMap<String, Vec<String>>,
}

impl Index {
    pub fn insert(&mut self, module: &str, name: &str, kind: NodeKind) {
        let full = join(module, name);
        self.by_name
            .entry(name.to_string())
            .or_default()
            .push(full.clone());
        self.defined.insert(full, kind);
    }

    pub fn contains(&self, full_path: &str) -> bool {
        self.defined.contains_key(full_path)
    }

    /// Folds another index into this one, as though its files had been walked
    /// straight after this one's. Absorbing shares in file order is what makes
    /// a parallel walk agree with a sequential one: `by_name` keeps candidates
    /// in the order they were defined, and the first is the one a lone
    /// definition-by-name resolves to.
    pub fn absorb(&mut self, other: Index) {
        for (name, paths) in other.by_name {
            self.by_name.entry(name).or_default().extend(paths);
        }
        self.defined.extend(other.defined);
    }
}

/// What one module's `use` statements bring into scope.
///
/// Keyed per module rather than per file because Rust scoping is per module:
/// a `use` at the top of a file does not reach into an inline `mod` block in
/// that same file.
#[derive(Debug, Default, Clone)]
pub struct UseMap {
    /// Name in scope -> the path it stands for, crate-relative.
    pub names: BTreeMap<String, String>,
    /// Module prefixes brought in by `use foo::*`.
    pub globs: Vec<String>,
}

impl UseMap {
    /// Merges another module's-worth of imports in, later ones winning, which
    /// is what a single walk reaching them second would have done.
    pub fn absorb(&mut self, other: UseMap) {
        self.names.extend(other.names);
        self.globs.extend(other.globs);
    }
}

/// A name that was successfully pinned to a definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub id: String,
    pub ambiguous: bool,
}

pub fn join(module: &str, name: &str) -> String {
    if module.is_empty() {
        name.to_string()
    } else {
        format!("{module}::{name}")
    }
}

fn parent_of(module: &str) -> String {
    match module.rfind("::") {
        Some(idx) => module[..idx].to_string(),
        None => String::new(),
    }
}

/// Rewrites `crate::`, `self::` and `super::` prefixes into a plain
/// crate-relative path. Everything else is left alone.
pub fn normalize(path: &[String], module: &str) -> Vec<String> {
    let mut rest = path;
    let mut prefix: Vec<String> = Vec::new();

    match rest.first().map(String::as_str) {
        Some("crate") => {
            rest = &rest[1..];
        }
        Some("self") => {
            prefix = split(module);
            rest = &rest[1..];
        }
        Some("super") => {
            let mut current = module.to_string();
            while rest.first().map(String::as_str) == Some("super") {
                current = parent_of(&current);
                rest = &rest[1..];
            }
            prefix = split(&current);
        }
        _ => {}
    }

    prefix.extend_from_slice(rest);
    prefix
}

fn split(module: &str) -> Vec<String> {
    if module.is_empty() {
        Vec::new()
    } else {
        module.split("::").map(String::from).collect()
    }
}

pub struct Resolver<'a> {
    pub index: &'a Index,
}

impl<'a> Resolver<'a> {
    /// Resolves a path as written in `module`, under that module's `uses`.
    /// Returns `None` for anything not defined in this crate — a `String`, a
    /// `tokio::sync::Mutex`, a generic parameter — which is exactly the set
    /// of names that should not become nodes.
    pub fn resolve(&self, path: &[String], module: &str, uses: &UseMap) -> Option<Resolved> {
        if path.is_empty() {
            return None;
        }
        let segs = normalize(path, module);
        if segs.is_empty() {
            return None;
        }

        if segs.len() == 1 {
            self.resolve_bare(&segs[0], module, uses)
        } else {
            self.resolve_qualified(&segs, uses)
        }
    }

    fn resolve_bare(&self, name: &str, module: &str, uses: &UseMap) -> Option<Resolved> {
        // Declared right here: the closest possible definition wins.
        let local = join(module, name);
        if self.index.contains(&local) {
            return Some(exact(local));
        }

        // Brought in by name: `use crate::types::ResourceKey;`
        if let Some(full) = uses.names.get(name) {
            if self.index.contains(full) {
                return Some(exact(full.clone()));
            }
        }

        // Brought in by glob: `use crate::types::*;`
        for prefix in &uses.globs {
            let candidate = join(prefix, name);
            if self.index.contains(&candidate) {
                return Some(exact(candidate));
            }
        }

        // Nothing said where it came from. If exactly one definition in the
        // crate has this name, that is certainly it; if several do, say so.
        self.guess_by_name(name)
    }

    fn resolve_qualified(&self, segs: &[String], uses: &UseMap) -> Option<Resolved> {
        let full = segs.join("::");
        if self.index.contains(&full) {
            return Some(exact(full));
        }

        // `use crate::config;` then `config::Rule` — the head segment is the
        // part that was imported.
        if let Some(prefix) = uses.names.get(&segs[0]) {
            let candidate = join(prefix, &segs[1..].join("::"));
            if self.index.contains(&candidate) {
                return Some(exact(candidate));
            }
        }

        for prefix in &uses.globs {
            let candidate = join(prefix, &full);
            if self.index.contains(&candidate) {
                return Some(exact(candidate));
            }
        }

        // A qualified path that still does not match anything defined here is
        // usually an external crate. Only claim it if the trailing name is
        // unique locally, and even then flag it.
        let last = segs.last()?;
        let guess = self.guess_by_name(last)?;
        Some(Resolved {
            id: guess.id,
            ambiguous: true,
        })
    }

    fn guess_by_name(&self, name: &str) -> Option<Resolved> {
        let candidates = self.index.by_name.get(name)?;
        match candidates.len() {
            0 => None,
            1 => Some(exact(candidates[0].clone())),
            _ => Some(Resolved {
                id: candidates[0].clone(),
                ambiguous: true,
            }),
        }
    }
}

fn exact(id: String) -> Resolved {
    Resolved {
        id,
        ambiguous: false,
    }
}

/// Collects the `use` statements of every module in one parsed file.
pub fn collect_use_maps(file: &syn::File, file_module: &str, out: &mut BTreeMap<String, UseMap>) {
    collect_in_items(&file.items, file_module, out);
}

fn collect_in_items(items: &[syn::Item], module: &str, out: &mut BTreeMap<String, UseMap>) {
    for item in items {
        match item {
            syn::Item::Use(item_use) => {
                let entry = out.entry(module.to_string()).or_default();
                let mut prefix = Vec::new();
                walk_use_tree(&item_use.tree, &mut prefix, module, entry);
            }
            syn::Item::Mod(item_mod) => {
                if let Some((_, items)) = &item_mod.content {
                    let child = join(module, &item_mod.ident.to_string());
                    collect_in_items(items, &child, out);
                }
            }
            _ => {}
        }
    }
}

fn walk_use_tree(tree: &syn::UseTree, prefix: &mut Vec<String>, module: &str, out: &mut UseMap) {
    match tree {
        syn::UseTree::Path(path) => {
            prefix.push(path.ident.to_string());
            walk_use_tree(&path.tree, prefix, module, out);
            prefix.pop();
        }
        syn::UseTree::Name(name) => {
            let ident = name.ident.to_string();
            // `use foo::{self, Bar}` imports the module `foo` under its own
            // name, not a child item called `self`.
            let (imported, path) = if ident == "self" {
                match prefix.last() {
                    Some(last) => (last.clone(), prefix.clone()),
                    None => return,
                }
            } else {
                let mut path = prefix.clone();
                path.push(ident.clone());
                (ident, path)
            };
            out.names
                .insert(imported, normalize(&path, module).join("::"));
        }
        syn::UseTree::Rename(rename) => {
            let mut path = prefix.clone();
            path.push(rename.ident.to_string());
            out.names.insert(
                rename.rename.to_string(),
                normalize(&path, module).join("::"),
            );
        }
        syn::UseTree::Glob(_) => {
            out.globs.push(normalize(prefix, module).join("::"));
        }
        syn::UseTree::Group(group) => {
            for tree in &group.items {
                walk_use_tree(tree, prefix, module, out);
            }
        }
    }
}

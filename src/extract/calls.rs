//! Call edges: which function runs which.
//!
//! Every other edge comes from a type written in a signature, where the name
//! to resolve is right there. A call is not like that. `x.run()` names the
//! method and nothing else, and there is no type checker here to say what `x`
//! is, so the two things syntax does hand over are used instead: the qualified
//! path when a call site has one, and the set of methods this crate defines
//! under that name when it does not. Anything that stays uncertain is flagged
//! `ambiguous` — the same contract the type resolver keeps — so a call
//! hierarchy can be read either as drawn or with the guesses switched off.
//!
//! Resolution has to wait until the whole crate has been walked: a function
//! routinely calls one that is defined three files later, so call sites are
//! collected during the pass and turned into edges once every node id exists.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{Edge, Node, NodeKind, Rel, Via};
use crate::resolve::{join, normalize, Resolver, UseMap};

/// What a call site named.
pub enum Callee {
    /// `foo(..)`, `Foo::new(..)`, `helpers::run(..)` — a path as written.
    Path(Vec<String>),
    /// `receiver.foo(..)` — the method name is all that survives.
    Method(String),
}

/// One call site, kept until resolution can see the whole crate.
pub struct PendingCall {
    /// Node id of the function the call sits inside.
    pub from: String,
    /// Module the call was written in, for its `use` statements.
    pub module: String,
    /// The `Self` type of the enclosing `impl`, for substituting `Self::`.
    pub self_path: Vec<String>,
    pub callee: Callee,
}

/// The type a method hangs off, recorded where the node id is built so that
/// `<Foo as Action>::apply` never has to be parsed back apart here.
pub struct MethodOwner {
    /// Node id of the method.
    pub node: String,
    pub module: String,
    /// The `Self` type as written, or the trait name for a trait body.
    pub type_path: Vec<String>,
    pub name: String,
}

/// Turns the call sites gathered during the pass into edges.
pub fn resolve_calls(
    pending: &[PendingCall],
    owners: &[MethodOwner],
    nodes: &BTreeMap<String, Node>,
    resolver: &Resolver,
    use_maps: &BTreeMap<String, UseMap>,
) -> BTreeSet<Edge> {
    let index = CallIndex::build(nodes, owners, resolver, use_maps);
    let fallback = UseMap::default();
    let mut edges = BTreeSet::new();

    for call in pending {
        let uses = use_maps.get(&call.module).unwrap_or(&fallback);
        let targets = match &call.callee {
            Callee::Path(path) => index.by_path(path, call, resolver, uses),
            Callee::Method(name) => candidates(&index.methods_by_name, name),
        };
        for (to, ambiguous) in targets {
            // A function calling itself would draw a loop onto its own box,
            // which says less than the missing edge does.
            if to == call.from {
                continue;
            }
            edges.insert(Edge {
                from: call.from.clone(),
                from_port: None,
                to,
                rel: Rel::Call,
                // A call has no nesting to record: it either happened or it
                // did not. `Via` stays orthogonal by staying `Direct`.
                via: Via::Direct,
                ambiguous,
            });
        }
    }
    edges
}

/// Everything in the crate that can be on the receiving end of a call.
struct CallIndex {
    /// Free-function node ids. A free function's id *is* its path, so
    /// membership is the whole lookup.
    fns: BTreeSet<String>,
    fns_by_name: BTreeMap<String, Vec<String>>,
    /// (type node id, method name) -> the methods defined on that type,
    /// however many `impl` blocks they are spread over.
    methods: BTreeMap<(String, String), Vec<String>>,
    methods_by_name: BTreeMap<String, Vec<String>>,
}

impl CallIndex {
    fn build(
        nodes: &BTreeMap<String, Node>,
        owners: &[MethodOwner],
        resolver: &Resolver,
        use_maps: &BTreeMap<String, UseMap>,
    ) -> Self {
        let mut fns = BTreeSet::new();
        let mut fns_by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for node in nodes.values() {
            if node.kind == NodeKind::Fn {
                fns.insert(node.id.clone());
                fns_by_name
                    .entry(node.name.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }

        let fallback = UseMap::default();
        let mut methods: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
        let mut methods_by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for owner in owners {
            methods_by_name
                .entry(owner.name.clone())
                .or_default()
                .push(owner.node.clone());
            let uses = use_maps.get(&owner.module).unwrap_or(&fallback);
            if let Some(ty) = resolver.resolve(&owner.type_path, &owner.module, uses) {
                methods
                    .entry((ty.id, owner.name.clone()))
                    .or_default()
                    .push(owner.node.clone());
            }
        }

        for list in methods.values_mut().chain(methods_by_name.values_mut()) {
            list.sort();
            list.dedup();
        }
        CallIndex {
            fns,
            fns_by_name,
            methods,
            methods_by_name,
        }
    }

    fn by_path(
        &self,
        path: &[String],
        call: &PendingCall,
        resolver: &Resolver,
        uses: &UseMap,
    ) -> Vec<(String, bool)> {
        let Some(path) = substitute_self(path, &call.self_path) else {
            return Vec::new();
        };
        let Some((name, prefix)) = path.split_last() else {
            return Vec::new();
        };

        if prefix.is_empty() {
            return self.bare_fn(name, &call.module, uses);
        }

        // `helpers::run()` — the prefix names a module.
        for module in module_candidates(prefix, &call.module, uses) {
            let full = join(&module, name);
            if self.fns.contains(&full) {
                return vec![(full, false)];
            }
        }

        // `Foo::new()`, `<Foo as Action>::apply()` — the prefix names a type,
        // which the ordinary type resolver already knows how to pin down.
        if let Some(ty) = resolver.resolve(prefix, &call.module, uses) {
            if let Some(ids) = self.methods.get(&(ty.id, name.clone())) {
                let ambiguous = ty.ambiguous || ids.len() > 1;
                return ids.iter().map(|id| (id.clone(), ambiguous)).collect();
            }
        }

        // A qualified path that matched neither is `Duration::from_secs` or
        // some other foreign call. Guessing at a local method with the same
        // trailing name would invent an edge, so it does not.
        Vec::new()
    }

    fn bare_fn(&self, name: &str, module: &str, uses: &UseMap) -> Vec<(String, bool)> {
        let local = join(module, name);
        if self.fns.contains(&local) {
            return vec![(local, false)];
        }
        if let Some(full) = uses.names.get(name) {
            if self.fns.contains(full) {
                return vec![(full.clone(), false)];
            }
        }
        for prefix in &uses.globs {
            let candidate = join(prefix, name);
            if self.fns.contains(&candidate) {
                return vec![(candidate, false)];
            }
        }
        candidates(&self.fns_by_name, name)
    }
}

/// Every definition of a name, flagged as a guess when there is more than one.
///
/// Emitting all of them rather than picking one keeps the choice where it
/// belongs: `ambiguous` is a checkbox in the viewer, and five candidate
/// `new`s drawn as five dotted guesses is honest in a way that one confident
/// arrow to an arbitrary one of them is not.
fn candidates(map: &BTreeMap<String, Vec<String>>, name: &str) -> Vec<(String, bool)> {
    match map.get(name) {
        None => Vec::new(),
        Some(ids) => {
            let ambiguous = ids.len() > 1;
            ids.iter().map(|id| (id.clone(), ambiguous)).collect()
        }
    }
}

/// Rewrites a leading `Self` into the type of the enclosing `impl`.
fn substitute_self(path: &[String], self_path: &[String]) -> Option<Vec<String>> {
    if path.first().map(String::as_str) != Some("Self") {
        return Some(path.to_vec());
    }
    if self_path.is_empty() {
        return None;
    }
    let mut out = self_path.to_vec();
    out.extend_from_slice(&path[1..]);
    Some(out)
}

/// Module paths a call's prefix might stand for, most specific first.
fn module_candidates(prefix: &[String], module: &str, uses: &UseMap) -> Vec<String> {
    let mut out = vec![normalize(prefix, module).join("::")];
    if let Some(imported) = uses.names.get(&prefix[0]) {
        // `use crate::config;` then `config::load()`: the head segment is the
        // part that was imported, and on its own it is already the module.
        out.push(match prefix.len() {
            1 => imported.clone(),
            _ => join(imported, &prefix[1..].join("::")),
        });
    }
    out.push(join(module, &prefix.join("::")));
    for glob in &uses.globs {
        out.push(join(glob, &prefix.join("::")));
    }
    out
}

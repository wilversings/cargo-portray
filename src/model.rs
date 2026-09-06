//! The JSON graph model.
//!
//! This is the only contract between the Rust extractor and the TypeScript
//! viewer: the extractor emits it, the viewer filters it and turns what
//! survives into DOT. Nothing here knows about Graphviz.

use serde::Serialize;

/// What kind of code artifact a node is. The viewer offers one checkbox per
/// variant, so the split is by what a reader would want to filter on, not by
/// what `syn` happens to call things.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Struct,
    Enum,
    Trait,
    TypeAlias,
    /// A free function, not attached to any type.
    Fn,
    /// A method in an inherent `impl Foo` block.
    InherentMethod,
    /// A method declared in a `trait Foo` body.
    TraitMethod,
    /// A method in an `impl Trait for Foo` block.
    ImplMethod,
    /// A module-level `const` or `static`.
    Const,
}

/// How one artifact depends on another: the syntactic position the reference
/// appeared in.
///
/// Orthogonal to [`Via`] on purpose. `fn f() -> Vec<Foo>` is
/// `rel = Return, via = Generic`; a single flat enum could not say both, and
/// the viewer needs both axes as separate checkbox groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Rel {
    /// A struct field, an enum variant payload, or a const's type.
    Field,
    /// A function or method parameter.
    Param,
    /// A function or method return type.
    Return,
    /// `impl Trait for Foo` — from `Foo` to `Trait`.
    Impls,
    /// `trait A: B` — from `A` to `B`.
    Supertrait,
    /// A generic bound or `where` predicate.
    Bound,
    /// One function runs another. Unlike every other variant this comes from
    /// a body rather than a signature, so it is the one place the graph
    /// describes what the crate *does* instead of how it is shaped.
    Call,
}

/// How deeply the reference was nested at that position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// Named outright: `Foo`, `&Foo`, `&mut Foo`.
    Direct,
    /// A template argument: the `Foo` in `Vec<Foo>`, `Arc<Mutex<Foo>>`,
    /// `Result<Foo, E>`, `(Foo, u8)`, `[Foo]`.
    Generic,
    /// Behind a trait object or `impl Trait`: `dyn Foo`, `Box<dyn Foo>`.
    Dyn,
}

/// One row inside a type node: a struct field, or an enum variant.
#[derive(Debug, Clone, Serialize)]
pub struct Member {
    /// Graphviz port id, so an edge can leave from this exact row.
    pub port: String,
    pub label: String,
    /// The row's own doc comment, as written. `None` when it has none.
    pub docs: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// Fully qualified and unique, e.g. `actions::power::PowerProfile` or
    /// `actions::power::<PowerProfile as Action>::apply`.
    pub id: String,
    pub kind: NodeKind,
    /// Short name, which is what the graph draws.
    pub name: String,
    /// `::`-joined module path; empty at the crate root.
    pub module: String,
    /// `impl Foo` / `impl Trait for Foo` / `trait Foo`; `None` for free items.
    pub owner: Option<String>,
    pub file: String,
    pub line: usize,
    /// `pub`, `pub(crate)`, or empty for private.
    pub visibility: String,
    /// Fields or variants; empty for everything that is not a struct or enum.
    pub members: Vec<Member>,
    pub signature: Option<String>,
    /// The item's doc comment, markdown and all, with the `///` markers and
    /// the one space after them removed. Carried raw: rendering it is the
    /// viewer's business, and an extractor that formatted markdown would be
    /// deciding what the reader sees.
    pub docs: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: String,
    /// The [`Member::port`] the edge leaves from, when it is a field edge.
    pub from_port: Option<String>,
    pub to: String,
    pub rel: Rel,
    pub via: Via,
    /// The name could not be pinned to one definition; the target is a best
    /// guess. Surfaced in the viewer so a wrong edge reads as a guess rather
    /// than as fact.
    pub ambiguous: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    #[serde(rename = "crate")]
    pub krate: String,
    pub root: String,
    /// The modules this run was restricted to, `::`-joined; empty when the
    /// whole crate was read. Not a filter — it is what was *parsed*, so the
    /// viewer can say so rather than let a partial crate read as a whole one.
    pub scope: Vec<String>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

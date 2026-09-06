//! The `syn::Visit` pass that turns parsed files into nodes and edges.

use std::collections::{BTreeMap, BTreeSet};

use quote::ToTokens;
use syn::visit::{self, Visit};
use syn::{
    Expr, ExprCall, ExprMethodCall, ExprPath, FnArg, ImplItemFn, ItemConst, ItemEnum, ItemFn,
    ItemImpl, ItemMod, ItemStatic, ItemStruct, ItemTrait, ItemType, ReturnType, TraitItemFn, Type,
};

use crate::extract::calls::{Callee, MethodOwner, PendingCall};
use crate::extract::types::{
    generic_param_names, walk_bounds, walk_generic_bounds, walk_type, TypeRef,
};
use crate::model::{Edge, Member, Node, NodeKind, Rel, Via};
use crate::resolve::{join, Resolver, UseMap};

/// `quote!` renders every token space-separated. Squeeze it back into
/// something that reads like source.
pub fn squeeze(s: &str) -> String {
    // The generic-bracket rules below would eat the space in `-> Foo`, so the
    // arrows are parked out of reach first.
    const ARROWS: &[(&str, &str)] = &[("->", "\u{1}"), ("=>", "\u{2}")];
    const RULES: &[(&str, &str)] = &[
        (" :: ", "::"),
        (":: ", "::"),
        (" ::", "::"),
        (" (", "("),
        ("( ", "("),
        (" )", ")"),
        (" [", "["),
        ("[ ", "["),
        (" ]", "]"),
        (" < ", "<"),
        ("< ", "<"),
        (" <", "<"),
        (" > ", ">"),
        ("> ", ">"),
        (" >", ">"),
        (" ,", ","),
        ("& ", "&"),
        (" '", "'"),
        (" ;", ";"),
        (" :", ":"),
    ];
    let mut out = s.to_string();
    for (arrow, parked) in ARROWS {
        out = out.replace(arrow, parked);
    }
    for (from, to) in RULES {
        out = out.replace(from, to);
    }
    for (arrow, parked) in ARROWS {
        out = out.replace(parked, arrow);
    }
    out.trim().to_string()
}

fn render<T: ToTokens>(node: &T) -> String {
    squeeze(&node.to_token_stream().to_string())
}

fn has_test_attr(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        attr.path()
            .segments
            .last()
            .map(|seg| seg.ident == "test")
            .unwrap_or(false)
    })
}

pub fn is_test_mod(i: &ItemMod) -> bool {
    if i.ident == "tests" || i.ident == "test" {
        return true;
    }
    i.attrs.iter().any(|attr| {
        attr.path().is_ident("cfg") && attr.to_token_stream().to_string().contains("test")
    })
}

/// Innermost path segment of a type, used to name the `Self` type of an
/// `impl` block (`impl Trait for &mut Foo` -> "Foo").
fn type_head_name(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(p) => p.path.segments.last().map(|s| s.ident.to_string()),
        Type::Reference(r) => type_head_name(&r.elem),
        Type::Group(g) => type_head_name(&g.elem),
        Type::Paren(p) => type_head_name(&p.elem),
        _ => None,
    }
}

fn type_head_path(ty: &Type) -> Vec<String> {
    match ty {
        Type::Path(p) => p
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect(),
        Type::Reference(r) => type_head_path(&r.elem),
        Type::Group(g) => type_head_path(&g.elem),
        Type::Paren(p) => type_head_path(&p.elem),
        _ => Vec::new(),
    }
}

/// The `impl` block or `trait` body a method currently sits in.
struct OwnerCtx {
    /// Cluster label, e.g. `impl Action for PowerProfile`.
    label: String,
    /// Path of the `Self` type as written, for substituting `Self`.
    self_path: Vec<String>,
    /// Segment that makes a method id unique: `PowerProfile`, or
    /// `<PowerProfile as Action>` when the same method name also exists on an
    /// inherent impl.
    id_segment: String,
    /// What kind of node the methods inside are.
    method_kind: NodeKind,
}

/// The function whose body is being walked, and what `Self` means inside it.
///
/// The `Self` type is copied in here rather than read back off `owners`,
/// because a body is walked with the `impl` context set aside — items nested
/// in a function belong to the module, not to the block around it.
struct FnCtx {
    id: String,
    self_path: Vec<String>,
}

pub struct Collector<'a> {
    resolver: &'a Resolver<'a>,
    use_maps: &'a BTreeMap<String, UseMap>,
    fallback_uses: UseMap,
    file: String,
    mod_stack: Vec<String>,
    generics: Vec<Vec<String>>,
    owners: Vec<OwnerCtx>,
    fns: Vec<FnCtx>,
    pub nodes: BTreeMap<String, Node>,
    pub edges: BTreeSet<Edge>,
    /// Call sites, resolved once the whole crate has been walked.
    pub pending_calls: Vec<PendingCall>,
    pub method_owners: Vec<MethodOwner>,
}

impl<'a> Collector<'a> {
    pub fn new(resolver: &'a Resolver<'a>, use_maps: &'a BTreeMap<String, UseMap>) -> Self {
        Collector {
            resolver,
            use_maps,
            fallback_uses: UseMap::default(),
            file: String::new(),
            mod_stack: Vec::new(),
            generics: Vec::new(),
            owners: Vec::new(),
            fns: Vec::new(),
            nodes: BTreeMap::new(),
            edges: BTreeSet::new(),
            pending_calls: Vec::new(),
            method_owners: Vec::new(),
        }
    }

    /// Runs the pass over one parsed file, whose top-level module is `module`.
    pub fn run(&mut self, file: &syn::File, path: &str, module: &[String]) {
        self.file = path.to_string();
        self.mod_stack = module.to_vec();
        self.generics.clear();
        self.owners.clear();
        self.fns.clear();
        self.visit_file(file);
    }

    fn module(&self) -> String {
        self.mod_stack.join("::")
    }

    fn uses(&self) -> &UseMap {
        self.use_maps
            .get(&self.module())
            .unwrap_or(&self.fallback_uses)
    }

    fn in_scope_generic(&self, name: &str) -> bool {
        self.generics.iter().flatten().any(|g| g == name)
    }

    /// Resolves one reference, substituting `Self` and dropping anything that
    /// is a generic parameter in scope.
    fn target_of(&self, reference: &TypeRef) -> Option<crate::resolve::Resolved> {
        let path = if reference.path.first().map(String::as_str) == Some("Self") {
            let owner = self.owners.last()?;
            if owner.self_path.is_empty() {
                return None;
            }
            // `Self::Assoc` is an associated item, not the Self type itself.
            if reference.path.len() > 1 {
                return None;
            }
            owner.self_path.clone()
        } else {
            reference.path.clone()
        };

        if path.len() == 1 && self.in_scope_generic(&path[0]) {
            return None;
        }
        self.resolver.resolve(&path, &self.module(), self.uses())
    }

    fn emit(&mut self, from: &str, port: Option<&str>, refs: &[TypeRef], rel: Rel) {
        for reference in refs {
            let Some(target) = self.target_of(reference) else {
                continue;
            };
            if target.id == from {
                continue;
            }
            self.edges.insert(Edge {
                from: from.to_string(),
                from_port: port.map(str::to_string),
                to: target.id,
                rel,
                via: reference.via,
                ambiguous: target.ambiguous,
            });
        }
    }

    fn add_node(&mut self, node: Node) {
        self.nodes.entry(node.id.clone()).or_insert(node);
    }

    /// Bound edges from `<T: Action>` and `where` clauses.
    fn emit_generic_bounds(&mut self, from: &str, generics: &syn::Generics) {
        let mut refs = Vec::new();
        walk_generic_bounds(generics, &mut refs);
        self.emit(from, None, &refs, Rel::Bound);
    }

    fn emit_signature(&mut self, from: &str, sig: &syn::Signature) {
        for input in &sig.inputs {
            if let FnArg::Typed(pat_type) = input {
                let mut refs = Vec::new();
                walk_type(&pat_type.ty, Via::Direct, &mut refs);
                self.emit(from, None, &refs, Rel::Param);
            }
        }
        if let ReturnType::Type(_, ty) = &sig.output {
            let mut refs = Vec::new();
            walk_type(ty, Via::Direct, &mut refs);
            self.emit(from, None, &refs, Rel::Return);
        }
        self.emit_generic_bounds(from, &sig.generics);
    }

    /// Records a function-like node and its signature edges, and returns the
    /// context its body should be walked under.
    fn record_fn(
        &mut self,
        sig: &syn::Signature,
        vis: String,
        kind: NodeKind,
        attrs_line: usize,
    ) -> FnCtx {
        let name = sig.ident.to_string();
        let (id, owner, self_path) = match self.owners.last() {
            Some(ctx) => (
                join(&self.module(), &format!("{}::{name}", ctx.id_segment)),
                Some(ctx.label.clone()),
                ctx.self_path.clone(),
            ),
            None => (join(&self.module(), &name), None, Vec::new()),
        };

        // Which type this method hangs off, captured where the id is built so
        // that call resolution never has to parse `<Foo as Action>` back out.
        if let Some(ctx) = self.owners.last() {
            let type_path = if ctx.self_path.is_empty() {
                vec![ctx.id_segment.clone()]
            } else {
                ctx.self_path.clone()
            };
            self.method_owners.push(MethodOwner {
                node: id.clone(),
                module: self.module(),
                type_path,
                name: name.clone(),
            });
        }

        self.generics.push(generic_param_names(&sig.generics));
        self.add_node(Node {
            id: id.clone(),
            kind,
            name,
            module: self.module(),
            owner,
            file: self.file.clone(),
            line: attrs_line,
            visibility: vis,
            members: Vec::new(),
            signature: Some(render(sig)),
        });
        self.emit_signature(&id, sig);
        self.generics.pop();
        FnCtx { id, self_path }
    }

    /// Walks a function body for the calls it makes, with the surrounding
    /// `impl` block set aside: an item nested in a body belongs to the module,
    /// not to the block it happens to sit in.
    fn walk_body(&mut self, ctx: FnCtx, body: impl FnOnce(&mut Self)) {
        let owners = std::mem::take(&mut self.owners);
        self.fns.push(ctx);
        body(self);
        self.fns.pop();
        self.owners = owners;
    }

    fn record_call(&mut self, callee: Callee) {
        let Some(ctx) = self.fns.last() else {
            return;
        };
        self.pending_calls.push(PendingCall {
            from: ctx.id.clone(),
            module: self.mod_stack.join("::"),
            self_path: ctx.self_path.clone(),
            callee,
        });
    }

    /// A path in expression position, which is a call target when it names one.
    ///
    /// `<Foo as Action>::apply` splits its type across `qself`, so the type is
    /// put back in front of the method name before anything tries to resolve
    /// it.
    fn record_call_path(&mut self, path: &ExprPath) {
        let mut segments: Vec<String> = path
            .path
            .segments
            .iter()
            .map(|seg| seg.ident.to_string())
            .collect();
        if let Some(qself) = &path.qself {
            let name = match segments.pop() {
                Some(name) => name,
                None => return,
            };
            segments = type_head_path(&qself.ty);
            segments.push(name);
        }
        if segments.len() < 2 {
            return;
        }
        self.record_call(Callee::Path(segments));
    }
}

impl<'ast, 'a> Visit<'ast> for Collector<'a> {
    fn visit_item_mod(&mut self, i: &'ast ItemMod) {
        if is_test_mod(i) {
            return;
        }
        self.mod_stack.push(i.ident.to_string());
        visit::visit_item_mod(self, i);
        self.mod_stack.pop();
    }

    fn visit_item_struct(&mut self, i: &'ast ItemStruct) {
        let name = i.ident.to_string();
        let id = join(&self.module(), &name);
        self.generics.push(generic_param_names(&i.generics));

        let mut members = Vec::new();
        let mut field_refs = Vec::new();
        for (idx, field) in i.fields.iter().enumerate() {
            let port = format!("f{idx}");
            let rendered = render(&field.ty);
            let label = match &field.ident {
                Some(ident) => format!("{ident}: {rendered}"),
                None => format!(".{idx}: {rendered}"),
            };
            let mut refs = Vec::new();
            walk_type(&field.ty, Via::Direct, &mut refs);
            field_refs.push((port.clone(), refs));
            members.push(Member { port, label });
        }

        self.add_node(Node {
            id: id.clone(),
            kind: NodeKind::Struct,
            name,
            module: self.module(),
            owner: None,
            file: self.file.clone(),
            line: i.ident.span().start().line,
            visibility: render(&i.vis),
            members,
            signature: None,
        });
        for (port, refs) in &field_refs {
            self.emit(&id, Some(port), refs, Rel::Field);
        }
        self.emit_generic_bounds(&id, &i.generics);

        visit::visit_item_struct(self, i);
        self.generics.pop();
    }

    fn visit_item_enum(&mut self, i: &'ast ItemEnum) {
        let name = i.ident.to_string();
        let id = join(&self.module(), &name);
        self.generics.push(generic_param_names(&i.generics));

        let mut members = Vec::new();
        let mut variant_refs = Vec::new();
        for (idx, variant) in i.variants.iter().enumerate() {
            let port = format!("v{idx}");
            let payload: Vec<String> = variant
                .fields
                .iter()
                .map(|field| match &field.ident {
                    Some(ident) => format!("{ident}: {}", render(&field.ty)),
                    None => render(&field.ty),
                })
                .collect();
            let label = match &variant.fields {
                syn::Fields::Unit => variant.ident.to_string(),
                syn::Fields::Unnamed(_) => format!("{}({})", variant.ident, payload.join(", ")),
                syn::Fields::Named(_) => format!("{} {{ {} }}", variant.ident, payload.join(", ")),
            };
            let mut refs = Vec::new();
            for field in variant.fields.iter() {
                walk_type(&field.ty, Via::Direct, &mut refs);
            }
            variant_refs.push((port.clone(), refs));
            members.push(Member { port, label });
        }

        self.add_node(Node {
            id: id.clone(),
            kind: NodeKind::Enum,
            name,
            module: self.module(),
            owner: None,
            file: self.file.clone(),
            line: i.ident.span().start().line,
            visibility: render(&i.vis),
            members,
            signature: None,
        });
        for (port, refs) in &variant_refs {
            self.emit(&id, Some(port), refs, Rel::Field);
        }
        self.emit_generic_bounds(&id, &i.generics);

        visit::visit_item_enum(self, i);
        self.generics.pop();
    }

    fn visit_item_type(&mut self, i: &'ast ItemType) {
        let name = i.ident.to_string();
        let id = join(&self.module(), &name);
        self.generics.push(generic_param_names(&i.generics));

        self.add_node(Node {
            id: id.clone(),
            kind: NodeKind::TypeAlias,
            name,
            module: self.module(),
            owner: None,
            file: self.file.clone(),
            line: i.ident.span().start().line,
            visibility: render(&i.vis),
            members: Vec::new(),
            signature: Some(render(&i.ty)),
        });
        let mut refs = Vec::new();
        walk_type(&i.ty, Via::Direct, &mut refs);
        self.emit(&id, None, &refs, Rel::Field);

        self.generics.pop();
    }

    fn visit_item_trait(&mut self, i: &'ast ItemTrait) {
        let name = i.ident.to_string();
        let id = join(&self.module(), &name);
        self.generics.push(generic_param_names(&i.generics));

        self.add_node(Node {
            id: id.clone(),
            kind: NodeKind::Trait,
            name: name.clone(),
            module: self.module(),
            owner: None,
            file: self.file.clone(),
            line: i.ident.span().start().line,
            visibility: render(&i.vis),
            members: Vec::new(),
            signature: None,
        });

        let mut supertraits = Vec::new();
        walk_bounds(&i.supertraits, Via::Direct, &mut supertraits);
        self.emit(&id, None, &supertraits, Rel::Supertrait);
        self.emit_generic_bounds(&id, &i.generics);

        self.owners.push(OwnerCtx {
            label: format!("trait {name}"),
            self_path: Vec::new(),
            id_segment: name,
            method_kind: NodeKind::TraitMethod,
        });
        visit::visit_item_trait(self, i);
        self.owners.pop();
        self.generics.pop();
    }

    fn visit_item_impl(&mut self, i: &'ast ItemImpl) {
        let self_name = type_head_name(&i.self_ty).unwrap_or_else(|| "?".to_string());
        let self_path = type_head_path(&i.self_ty);
        self.generics.push(generic_param_names(&i.generics));

        let ctx = match &i.trait_ {
            Some((_, path, _)) => {
                let trait_name = path
                    .segments
                    .last()
                    .map(|s| s.ident.to_string())
                    .unwrap_or_else(|| "?".to_string());

                // `impl Trait for Foo` is a dependency of Foo on Trait.
                if let (Some(from), Some(to)) = (
                    self.resolver
                        .resolve(&self_path, &self.module(), self.uses()),
                    self.resolver.resolve(
                        &path
                            .segments
                            .iter()
                            .map(|s| s.ident.to_string())
                            .collect::<Vec<_>>(),
                        &self.module(),
                        self.uses(),
                    ),
                ) {
                    if from.id != to.id {
                        self.edges.insert(Edge {
                            from: from.id,
                            from_port: None,
                            to: to.id,
                            rel: Rel::Impls,
                            via: Via::Direct,
                            ambiguous: from.ambiguous || to.ambiguous,
                        });
                    }
                }

                OwnerCtx {
                    label: format!("impl {trait_name} for {self_name}"),
                    self_path,
                    id_segment: format!("<{self_name} as {trait_name}>"),
                    method_kind: NodeKind::ImplMethod,
                }
            }
            None => OwnerCtx {
                label: format!("impl {self_name}"),
                self_path,
                id_segment: self_name,
                method_kind: NodeKind::InherentMethod,
            },
        };

        self.owners.push(ctx);
        visit::visit_item_impl(self, i);
        self.owners.pop();
        self.generics.pop();
    }

    fn visit_item_fn(&mut self, i: &'ast ItemFn) {
        if has_test_attr(&i.attrs) {
            return;
        }
        let ctx = self.record_fn(
            &i.sig,
            render(&i.vis),
            NodeKind::Fn,
            i.sig.ident.span().start().line,
        );
        self.walk_body(ctx, |me| visit::visit_item_fn(me, i));
    }

    fn visit_impl_item_fn(&mut self, i: &'ast ImplItemFn) {
        if has_test_attr(&i.attrs) {
            return;
        }
        let kind = self
            .owners
            .last()
            .map(|ctx| ctx.method_kind)
            .unwrap_or(NodeKind::Fn);
        let ctx = self.record_fn(
            &i.sig,
            render(&i.vis),
            kind,
            i.sig.ident.span().start().line,
        );
        self.walk_body(ctx, |me| me.visit_block(&i.block));
    }

    fn visit_trait_item_fn(&mut self, i: &'ast TraitItemFn) {
        if has_test_attr(&i.attrs) {
            return;
        }
        let ctx = self.record_fn(
            &i.sig,
            String::new(),
            NodeKind::TraitMethod,
            i.sig.ident.span().start().line,
        );
        // A trait method may carry a default body, and what that body calls is
        // as real a dependency as anything an impl writes.
        if let Some(block) = &i.default {
            self.walk_body(ctx, |me| me.visit_block(block));
        }
    }

    fn visit_expr_call(&mut self, i: &'ast ExprCall) {
        // Only the bare `foo()` shape is claimed here; anything qualified is
        // caught by `visit_expr_path` below, whether or not it is called.
        if let Expr::Path(path) = &*i.func {
            if path.qself.is_none() && path.path.segments.len() == 1 {
                let name = path.path.segments[0].ident.to_string();
                self.record_call(Callee::Path(vec![name]));
            }
        }
        visit::visit_expr_call(self, i);
    }

    fn visit_expr_method_call(&mut self, i: &'ast ExprMethodCall) {
        self.record_call(Callee::Method(i.method.to_string()));
        visit::visit_expr_method_call(self, i);
    }

    fn visit_expr_path(&mut self, i: &'ast ExprPath) {
        // `map(Type::from)` hands a function over without calling it, which is
        // the same dependency. A bare one-segment path is skipped instead:
        // most of them are local variables, and matching those against
        // function names by coincidence would invent edges.
        self.record_call_path(i);
        visit::visit_expr_path(self, i);
    }

    fn visit_item_const(&mut self, i: &'ast ItemConst) {
        let name = i.ident.to_string();
        let id = join(&self.module(), &name);
        self.add_node(Node {
            id: id.clone(),
            kind: NodeKind::Const,
            name,
            module: self.module(),
            owner: None,
            file: self.file.clone(),
            line: i.ident.span().start().line,
            visibility: render(&i.vis),
            members: Vec::new(),
            signature: Some(render(&i.ty)),
        });
        let mut refs = Vec::new();
        walk_type(&i.ty, Via::Direct, &mut refs);
        self.emit(&id, None, &refs, Rel::Field);
    }

    fn visit_item_static(&mut self, i: &'ast ItemStatic) {
        let name = i.ident.to_string();
        let id = join(&self.module(), &name);
        self.add_node(Node {
            id: id.clone(),
            kind: NodeKind::Const,
            name,
            module: self.module(),
            owner: None,
            file: self.file.clone(),
            line: i.ident.span().start().line,
            visibility: render(&i.vis),
            members: Vec::new(),
            signature: Some(render(&i.ty)),
        });
        let mut refs = Vec::new();
        walk_type(&i.ty, Via::Direct, &mut refs);
        self.emit(&id, None, &refs, Rel::Field);
    }
}

//! Position-aware walking of `syn::Type`.
//!
//! The point of walking the tree rather than scanning tokens is that a type's
//! *position* survives: `Vec<Foo>` records `Foo` as a template argument,
//! `Box<dyn Foo>` records it as a trait object, and `&Foo` records it as a
//! plain direct use. That distinction is what the viewer's "via" filter is.

use syn::punctuated::Punctuated;
use syn::{GenericArgument, Path, PathArguments, ReturnType, Type, TypeParamBound, WherePredicate};

use crate::model::Via;

/// A type name exactly as it was written at a use site, plus the position it
/// appeared in. Resolution to a definition happens later, in `resolve`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeRef {
    /// Path segments as written: `["crate", "types", "ResourceKey"]`.
    pub path: Vec<String>,
    pub via: Via,
}

fn path_segments(path: &Path) -> Vec<String> {
    path.segments
        .iter()
        .map(|seg| seg.ident.to_string())
        .collect()
}

/// Recurses into a path's own generic arguments (`Vec<Foo>`, `Fn(Foo) -> Bar`).
fn walk_path_args(path: &Path, out: &mut Vec<TypeRef>) {
    for seg in &path.segments {
        match &seg.arguments {
            PathArguments::None => {}
            PathArguments::AngleBracketed(args) => {
                for arg in &args.args {
                    match arg {
                        GenericArgument::Type(ty) => walk_type(ty, Via::Generic, out),
                        GenericArgument::AssocType(assoc) => {
                            walk_type(&assoc.ty, Via::Generic, out)
                        }
                        GenericArgument::Constraint(c) => walk_bounds(&c.bounds, Via::Dyn, out),
                        _ => {}
                    }
                }
            }
            PathArguments::Parenthesized(args) => {
                for ty in &args.inputs {
                    walk_type(ty, Via::Generic, out);
                }
                if let ReturnType::Type(_, ty) = &args.output {
                    walk_type(ty, Via::Generic, out);
                }
            }
        }
    }
}

/// Collects every type name mentioned in `ty`, tagged with how it was reached.
pub fn walk_type(ty: &Type, via: Via, out: &mut Vec<TypeRef>) {
    match ty {
        Type::Path(p) => {
            if let Some(qself) = &p.qself {
                walk_type(&qself.ty, via, out);
            }
            out.push(TypeRef {
                path: path_segments(&p.path),
                via,
            });
            walk_path_args(&p.path, out);
        }

        // A reference or raw pointer to `Foo` is still a direct use of `Foo`.
        Type::Reference(r) => walk_type(&r.elem, via, out),
        Type::Ptr(p) => walk_type(&p.elem, via, out),
        Type::Paren(p) => walk_type(&p.elem, via, out),
        Type::Group(g) => walk_type(&g.elem, via, out),

        Type::TraitObject(t) => walk_bounds(&t.bounds, Via::Dyn, out),
        Type::ImplTrait(t) => walk_bounds(&t.bounds, Via::Dyn, out),

        // Containers: whatever is inside was reached as a template argument.
        Type::Tuple(t) => {
            for elem in &t.elems {
                walk_type(elem, Via::Generic, out);
            }
        }
        Type::Slice(s) => walk_type(&s.elem, Via::Generic, out),
        Type::Array(a) => walk_type(&a.elem, Via::Generic, out),
        Type::BareFn(f) => {
            for input in &f.inputs {
                walk_type(&input.ty, Via::Generic, out);
            }
            if let ReturnType::Type(_, ty) = &f.output {
                walk_type(ty, Via::Generic, out);
            }
        }

        _ => {}
    }
}

/// Collects the trait names in a bound list (`T: Action + Send`, `dyn Foo`).
pub fn walk_bounds(
    bounds: &Punctuated<TypeParamBound, syn::Token![+]>,
    via: Via,
    out: &mut Vec<TypeRef>,
) {
    for bound in bounds {
        if let TypeParamBound::Trait(t) = bound {
            out.push(TypeRef {
                path: path_segments(&t.path),
                via,
            });
            walk_path_args(&t.path, out);
        }
    }
}

/// Collects the trait names a set of generics constrains, from both the
/// inline bounds (`<T: Action>`) and the `where` clause.
pub fn walk_generic_bounds(generics: &syn::Generics, out: &mut Vec<TypeRef>) {
    for param in &generics.params {
        if let syn::GenericParam::Type(t) = param {
            walk_bounds(&t.bounds, Via::Direct, out);
        }
    }
    let Some(where_clause) = &generics.where_clause else {
        return;
    };
    for predicate in &where_clause.predicates {
        if let WherePredicate::Type(t) = predicate {
            walk_bounds(&t.bounds, Via::Direct, out);
        }
    }
}

/// The type parameters a set of generics introduces, so `fn f<T>(t: T)` does
/// not draw an edge to some unrelated type named `T`.
pub fn generic_param_names(generics: &syn::Generics) -> Vec<String> {
    generics
        .params
        .iter()
        .filter_map(|param| match param {
            syn::GenericParam::Type(t) => Some(t.ident.to_string()),
            _ => None,
        })
        .collect()
}

# cargo-portray

An interactive map of the dependencies between a Rust crate's own code
artifacts: which function takes which struct, which struct holds which enum,
which type implements which trait, and which function calls which.

Nothing in here is specific to konductord. It reads a crate root, so it works
on any Rust crate laid out the normal way.

```sh
cargo install cargo-portray
cargo portray                            # then open the URL it prints
```

The crate is `cargo-portray` because that is how cargo dispatches: `cargo
portray` looks for an executable of that name on your PATH. You never type the
hyphenated form. `serve` is the default subcommand, so `cargo portray` and
`cargo portray serve .` do the same thing.

From a checkout of this repository instead:

```sh
cd tools/cargo-portray && cargo run -- ../..
```

There the `--` matters: it is what tells cargo that the rest of the line is
for this program rather than for cargo.

That is the whole setup. **Rust is the only toolchain involved** — no npm, no
node, no bundler, at build time or at run time. The viewer is plain ES modules
served straight off disk, and Graphviz rides along as a self-contained
WebAssembly module in `ui/vendor/graphviz.js`. Published as a crate, the `ui`
directory gets embedded in the binary and `cargo install` is all a user needs.

## Why a web page and not an SVG

The static generator this replaces produced one image of the whole crate:
2106 × 16368 points, about five and a half metres tall. Every question —
"what does `actions` touch?", "who holds a `ResourceKey`?" — meant editing CLI
flags and re-rendering. Filtering belongs where the reading happens, so it
moved into the browser. Graphviz still does the drawing; it just runs on the
page, re-laying out whenever a filter changes.

## What you can filter

- **One module at a time.** Study `actions` on its own and the things it
  depends on are drawn with it, inside their own module's box, so a
  cross-module dependency stays visible instead of being cut off. Switching a
  module off switches off everything inside it, and a parent whose children
  are only partly off shows the third checkbox state rather than claiming to
  be fully on. A crate with more modules than fit on a screen has a search box
  over the tree: type any part of a path — `extract`, or `extract::c` — and
  the list narrows to what holds it, shown with the modules it sits in and
  with the matched text marked. It shortens the list, never the diagram, so it
  stays out of the link you share.
- **Edge type**, along two independent axes: what the relationship *is*
  (struct member, method argument, return type, implements, supertrait,
  generic bound, calls) and how the type was *reached* (named directly, as a
  template argument like the `Foo` in `Vec<Foo>`, or behind `dyn`). Turning
  every edge type off leaves the artifacts on the page, unconnected — it is a
  way to see what is there, not a way to empty the window.
- **Artifact type**: struct, enum, trait, type alias, const, free function,
  inherent method, trait method, impl method.
- **Individual artifacts**, hidden by click or by regex — `Error$` takes out a
  whole family of noise at once.

Collapsing a module into a single box, with edge weights counting what runs
underneath, is the way to read a crate this size: zoom out to modules, expand
only what you are reading.

The panels themselves fold away — every one of them, by its heading — and the
sidebar is dragged wider by the seam it shares with the diagram, because a
crate whose module paths run four deep needs more than three hundred pixels
and one whose filters are already set needs none of it. The width is kept in
this browser, like the colours.

Two switches float over the top-right of the diagram, and draw their own
state. The **padlock** pins the view: shut, the wheel and a stray drag stop
moving a diagram you have already framed, and it stays pinned across the
re-layouts that follow. The **corner arrows** take the panels and the toolbar
away and leave the drawing, with the status line under it; Escape — or the
switch again — brings them back. Clicking still selects either way, and neither
switch is part of the view: they change what is around the diagram, not what is
in it, so they stay out of the link you share.

## The documentation is in the sidebar

Click an artifact and its doc comment is rendered under it — headings, lists,
`code`, fenced examples with the `#` setup lines hidden the way rustdoc hides
them — with every documented field or variant listed below. The diagram stays
a diagram: nothing is written into it that the reader has to click past, and
the one selected artifact is the one being read about.

The extractor carries the comment exactly as written and the viewer decides
what it looks like — the markdown it understands is the subset doc comments
actually use, rendered into elements rather than into a string of HTML, so a
doc comment full of angle brackets is text and not markup.

## Two diagrams

Under **Diagram** there are two buttons, because which artifacts and which
edges you want always move together.

**types** is the default: structs, enums and traits, joined by what holds,
implements and extends what. The shape of the crate.

**calls** is the call hierarchy: functions and methods only, joined by what
runs what. It is a separate button rather than one more checkbox because a
call graph drawn over structs has nothing joining it, and a type graph with
every call in it is unreadable.

Calls are the only edge read out of a function body rather than its signature,
and the only one syntax cannot settle on its own. A written path is resolved
like any other name, so `Store::new()` finds the `new` on *that* `Store` even
when three types have one. A plain `x.run()` cannot be: nothing here knows
what `x` is. So every `run` the crate defines is drawn, marked as a guess, and
the preset starts with **unresolved guesses** switched off — a first look at
what calls what shows only what is certain, and the checkbox brings the rest
back. A path that matches nothing local, like `Duration::from_secs`, is left
out rather than re-guessed against a local method with the same name.

Calls made inside a macro are invisible, because `syn` does not parse macro
bodies; so are the ones the language inserts for you, like the `From::from`
behind a `?`.

Colours and line styles are yours to set, under **Appearance**: a colour per
artifact type, and a colour plus arrowhead per edge type, with the line style
attached to how the type was reached. Those live in the browser's local
storage, deliberately outside the shareable link — a colour scheme is a
standing preference, not part of the view you are sharing.

The current view *is* in the URL, so a diagram is a link you can paste, and
the back button undoes a filter change. The hash reads as what it does —
`#kinds=struct,enum&rels=field,impls&depth=2` — so a link can be skimmed, and
edited by hand when that is quicker than clicking. A link outlives the crate it was
written for — the server always defaults to the same port, so a view saved
against one project will happily reopen against another — so on load anything
it names that this crate does not have is dropped, and the status line says
what was dropped. A filter for a crate you are not looking at should not leave
you staring at a blank page.

## Commands

```sh
cargo portray <crate-root>            # the viewer, with live reload on save
cargo portray serve  <crate-root> --port 7878
cargo portray emit   <crate-root> -o graph.json --pretty
cargo portray export <crate-root> -o site
cargo portray serve  <crate-root> -m actions -m resource
```

`serve` watches the crate's `src` and bumps a counter the page polls; saving a
`.rs` file redraws the diagram within about a second. It only counts real
edits — serving the model reads every source file, and treating that as a
change would make the page reload forever.

## Crates too big to read at once

`--module` (or `-m`, repeatable) narrows what the tool *reads*: with
`-m actions`, only `src/actions.rs`, `src/actions/**` and any inline
`mod actions` are opened at all. Nothing else is parsed, indexed or emitted,
so a crate of ten thousand files costs what its one interesting module costs,
and the browser is handed a model it can lay out.

It takes a module path in either spelling — `actions::power` or
`actions/power` — and the page says which one it is looking at, beside the
crate name.

This is not one of the filters above, and it is the only setting of its kind:
a filter lives in the browser because changing it should be a click, while a
scope decides what gets opened, which is a decision that has to be made before
anything is read. The trade is that within a scope the rest of the crate is as
invisible as another crate: a type defined outside it does not resolve, and no
edge points at it. If you want the whole picture with less of it drawn, read
the whole crate and switch modules off in the sidebar; use `--module` when the
whole crate is more than you want to parse.

## Hosting it

`export` writes a directory that needs no server of ours: the model goes in
beside the page as `graph.json`, and one `<meta>` tag in `index.html` is
rewritten to point at it. Everything else is copied byte for byte, so the
hosted viewer and the local one are the same program — every filter, the
module tree, the colour pickers and the DOT/SVG/PNG buttons all work, because
all of that always ran in the browser. The one thing it cannot do is notice a
source file changing.

About a megabyte all in, most of it the Graphviz WebAssembly module. Open it
through any static file server — `python3 -m http.server --directory site` —
rather than `file://`, which browsers refuse to let a page read JSON from.

For GitHub Pages, with **Settings → Pages → Source** set to *GitHub Actions*:

```yaml
# .github/workflows/pages.yml
name: pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo install cargo-portray && cargo portray export . -o site
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Every link the page emits is relative, so it works from a project page at
`user.github.io/repo/` as well as from a domain root, or from a subdirectory
of one. The export drops a `.nojekyll` file in as well, so Pages serves the
directory as-is.

One thing the snippet above hides: **a repository has exactly one Pages site.**
If something else already deploys Pages there — a documentation build, a
package repository — a second job calling `deploy-pages` replaces the whole
site rather than adding to it. Export into a subdirectory of the tree that job
already uploads instead, which is what konductord's `release.yml` does to put
the map at `/deps/` beside its apt and yum repositories.

## How it decides what depends on what

Syntax only — there is no type checker here. Two things make that trustworthy
enough to act on:

**Names are resolved, not matched.** A short name is looked up in the module
that wrote it, then in that module's `use` statements, then in a crate-wide
index. Two modules can both define `Error` without collapsing into one node.
When a name genuinely cannot be pinned down, the edge is still drawn but
flagged as a guess, and the viewer can hide those.

**Positions are kept.** `Vec<Foo>` records `Foo` as a template argument,
`Box<dyn Foo>` records it as a trait object, `&Foo` as a plain direct use.
That is what makes "template argument" a filter rather than something you have
to squint for.

Known limits: `#[path = "..."]` attributes are not honoured, macro-generated
items are invisible, and only the current crate is indexed, so types from
dependencies do not appear. Under `--module`, "the crate" means the modules
named: a short name whose real definition is outside the scope resolves to
nothing, or — if some unrelated type inside the scope happens to share the
name — to that one. Test code (`#[test]`, `#[tokio::test]`,
`mod tests`, `#[cfg(test)]`) is skipped on purpose.

## Layout

| Path | What it holds |
| --- | --- |
| `src/model.rs` | the JSON graph model — the only contract between the two halves |
| `src/extract/types.rs` | position-aware walking of `syn::Type` |
| `src/extract/calls.rs` | call sites, resolved once the whole crate is known |
| `src/resolve.rs` | `use`-map and index resolution of names to definitions |
| `src/extract/visitor.rs` | the `syn::Visit` pass that produces nodes and edges |
| `src/serve.rs` | the local server and file watcher |
| `src/export.rs` | the static-site writer |
| `ui/src/filter.js` | filter state applied to the model |
| `ui/src/dot.js` | the surviving subgraph rendered as DOT |
| `ui/src/render.js` | Graphviz-WASM layout and click handling |
| `ui/src/panzoom.js` | viewBox pan and zoom, in place of a package |
| `ui/vendor/graphviz.js` | vendored Graphviz WebAssembly build |

One thing worth knowing before editing `ui/src/dot.js`: the WebAssembly build
of Graphviz has no fontconfig and no system fonts, so its idea of how wide a
piece of text is comes from a crude built-in table and is too small for
`sans-serif`. Left alone it sizes cells narrower than their contents and long
member names spill out of the box. `dot.js` therefore measures each label on
a canvas, in the same font and size the page will draw it in, and hands
Graphviz an explicit cell width. For the same reason a node header is one
text run rather than `<b>struct</b> Name` — Graphviz positions each run from
those same wrong metrics, which is what ran the keyword into the type name.

The browser code is plain ES modules with JSDoc types, so a TypeScript-aware
editor still checks it while nobody needs a package manager to run it. To
refresh the vendored Graphviz:

```sh
curl -Lo ui/vendor/graphviz.js https://unpkg.com/@hpcc-js/wasm-graphviz/dist/index.js
```

then re-add the comment header at the top of that file.

This crate is deliberately outside konductord's workspace — it has its own
`Cargo.lock` and its own `target/`, so it never touches the daemon's
dependency tree, its clippy gate, or its musl release build.

# AGENTS.md

Instructions for AI agents and new contributors working in this repository.
Read this before editing. `README.md` explains what the tool does and how to
run it; this file states what you must not break.

## What this is

`cargo-portray` draws the dependencies between a Rust crate's own code
artifacts — which function takes which struct, which struct holds which enum,
which type implements which trait, which function calls which — as a diagram
you can filter in a browser.

It is a cargo subcommand, which is why the crate is `cargo-portray` and the
binary must keep that exact name: `cargo portray` works by finding an
executable called `cargo-portray` on PATH. Cargo then echoes the subcommand
back, so the program is run as `cargo-portray portray …` and `argv()` in
`src/main.rs` drops the repeat. Rename either half and `cargo portray` stops
resolving.

It has two halves and one seam:

```
src/            Rust: parse the crate, resolve names, emit a JSON model
ui/             browser: filter that model, lay it out, draw it
```

The organising idea is that **filtering belongs where the reading happens.**
The Rust side answers "what depends on what" once and completely; it never
decides what is worth showing. Everything a user can switch on or off happens
in the page, against a model that already holds the whole crate. Most of the
invariants below exist to keep that seam clean.

## Build and test

```sh
cargo test                                  # 29 tests, all must pass
cargo clippy --all-targets -- -D warnings
cargo fmt --all
cargo run -- serve .                        # the viewer, on 127.0.0.1:7878
cargo run -- export . -o site               # the same viewer, as a static site
cargo run -- serve . -m extract             # one module of it, and nothing else
```

**Before declaring any change done:** `cargo fmt --all`, then clippy with
`-D warnings`, then the tests. If you touched anything under `ui/`, also load
the page and look at it — see *Checking the viewer* below.

## Hard constraints

1. **Rust is the only toolchain.** No npm, no node, no bundler, no TypeScript
   compiler — not as a build dependency, not as a runtime one, not as a
   convenience. `cargo run` is the whole setup and must stay that way. That is
   why the browser code is plain ES modules with JSDoc types, why pan and zoom
   is sixty lines of viewBox arithmetic instead of a package, and why Graphviz
   is vendored as a self-contained WebAssembly build in `ui/vendor/`. That
   build is also the whole answer to "should we minify the export": it is
   already minified and it is 91% of what a visitor downloads, so minifying
   the hand-written code would move about 1% and cost the rule that a served
   file and an exported file are the same bytes. Every
   vendored file carries the command that refreshes it in a header comment.
   (Running node to *check* something during development is fine. Requiring it
   is not.)
2. **The JSON model is the only contract between the two halves.** It is
   declared in `src/model.rs` and mirrored in `ui/src/model.js`. Change one and
   you change the other in the same commit. Nothing else may cross: the page
   must not re-parse Rust, and the extractor must not know what a colour is.
3. **The extractor emits everything it finds; the viewer decides what to
   show.** No `--exclude` flags, no "skip private items" switches, no
   pre-filtering to keep the output small. A filter that lives in Rust is a
   filter the user has to restart the program to change.

   `--module` is the one thing that narrows the Rust side, and it is not a
   filter: it is a **scope**, and it says which files are opened at all. That
   is a decision that cannot be made in the browser, because by the time the
   browser has the model the parsing has already happened — which on a crate
   too large to parse, ship and lay out is the whole problem. Within a scope
   the tool behaves as though the rest of the crate were a different crate:
   out-of-scope modules are not indexed, so nothing resolves to them and no
   edge points at them. Keep it that way. A second knob that trimmed the
   *output* while still reading everything would be a filter in Rust, and
   belongs in `ui/` instead.
4. **The served page and the exported page are the same files.** `export`
   copies `ui/` byte for byte and rewrites exactly one `<meta>` tag, so a bug
   can never exist in only one of them. Do not add a second entry point, a
   template, or a build-time substitution.
5. **No `unwrap()` or `expect()` outside `#[cfg(test)]`.** A tool pointed at an
   unfamiliar crate meets malformed files, missing directories and syntax it
   has never seen; it should say so in a sentence, not print a backtrace. Use
   `?` with `anyhow::Context` that names the path involved.
6. **Test code is invisible on purpose.** `#[test]`, `#[tokio::test]`,
   `mod tests` and `#[cfg(test)]` items produce no nodes and no edges. Nobody
   reading an architecture diagram wants the fixtures in it.

## Architecture invariants

### Extraction

- **`rel` and `via` are orthogonal, and must stay that way.** What a
  relationship *is* (`field`, `param`, `return`, `impls`, `supertrait`,
  `bound`) is one axis; how the type was *reached* (`direct`, `generic`, `dyn`)
  is another. `fn f() -> Vec<Foo>` is a return *and* a template argument. A
  flat enum cannot say that, which is why "template argument" can be a filter
  at all. Never collapse the two.
- **Names are resolved, not matched.** `src/resolve.rs` looks a short name up
  in the module that wrote it, then in that module's `use` statements, then in
  glob prefixes, then in a crate-wide index — and only marks an edge
  `ambiguous` when several definitions genuinely fit. Two modules that both
  define `Error` must stay two nodes. Do not add a bare-name fallback; that is
  the defect this file was written to replace.
- **Every `syn::Type` arm decides its `Via` explicitly.** `src/extract/types.rs`
  walks types positionally: a path emits at the current via and recurses its
  arguments as `Generic`, a reference keeps the via it had, a trait object
  becomes `Dyn`. When you add an arm, say which it is; do not let a new syntax
  fall through to a default and quietly lose its position.
- **Generic parameters are not artifacts.** `T` in `fn f<T>(t: T)` is dropped;
  only named definitions in this crate become nodes.
- **Calls are the one edge that comes from a body, and the one that cannot be
  resolved on sight.** `x.run()` names the method and nothing else, so
  `src/extract/calls.rs` collects call sites during the pass and resolves them
  afterwards, when every node id exists: a written path resolves through the
  ordinary type resolver, a bare method name resolves against the methods this
  crate defines under it. Two rules hold that together and must not be traded
  for a fuller-looking graph. A qualified path that matches nothing local is
  **dropped**, never re-guessed by its trailing name — `Duration::from_secs`
  is not your `Timer::from_secs`. A bare name with several definitions emits
  **all** of them flagged `ambiguous`, never one of them silently; the
  `ambiguous` checkbox is what makes a call graph readable either way.
- **Doc comments are carried, never rendered.** `docs_of` in
  `src/extract/visitor.rs` joins the `#[doc = "..."]` attributes back into the
  markdown the author wrote, strips the space after the marker and the common
  indent, and stops. What a heading looks like is the viewer's business; an
  extractor that emitted HTML would be deciding what the reader sees, and the
  model would stop being a model. Members carry their own: a field's doc
  belongs to the row, not to the struct.
- **Node ids are structural, not display strings.** `module::Type`,
  `module::Type::method`, `module::<Type as Trait>::method`. They are the
  handle a click maps back through and the key edges join on, so they must be
  stable across runs and unique across the crate.

### The viewer

- **Graphviz compiled to WebAssembly has no fontconfig and no system fonts**,
  so its idea of how wide text is comes from a crude built-in table and is too
  small for `sans-serif`. `ui/src/dot.js` therefore measures every label on a
  canvas, in the font and size the page will actually draw it in, and hands
  Graphviz an explicit cell width. For the same reason a node header is a
  single text run — `<b>struct Foo</b>`, never `<b>struct</b> Foo`, because
  Graphviz positions the second run using those same wrong metrics and lands it
  on top of the first. This is the single most-regressed thing in the project:
  if labels start spilling out of their boxes or the keyword runs into the type
  name, this is why.
- **Documentation is read in the sidebar, never in the diagram.** The doc
  comments reach the page in the model and `panels/details.js` renders the
  selected artifact's, its documented fields under it. The diagram carried a
  clickable marker per comment once — a lettered ring in the node, and a
  window that opened over the drawing — and it cost a column in every table,
  a fake `href` scheme through Graphviz, and a pass in `render.js` that
  re-placed a glyph Graphviz had put down from guessed font metrics. All of it
  told the reader something the panel beside it already said. Do not put it
  back: what a node is worth drawing is its name, its members and its edges.
- **The pan captures the pointer only once the pointer moves.** A captured
  pointer delivers its `pointerup` — and the `click` synthesised from it — to
  whoever holds the capture, so capturing on `pointerdown`, which `panzoom.js`
  used to do, quietly ate every click in the diagram: selecting a node stopped
  working. Capture belongs after the pointer has travelled `DRAG_SLOP`, which
  is the point where a press is a drag and no longer a click.
- **`markdown.js` renders into elements, never into HTML.** Doc comments are
  someone else's text: built as DOM nodes, a comment full of angle brackets is
  a comment full of angle brackets, and there is no escaping to get wrong. Its
  inline pattern is built per call — one shared `/g` regex, recursed into by a
  link label, resets `lastIndex` under the outer walk and loops forever.
- **A crowded channel is read by dimming, not by re-laying out.** `dot` routes
  every edge that crosses a rank boundary through the same corridor, so a
  dense view arrives as a bundle of parallel lines that are individually
  correct and collectively unreadable. `bindTrace` in `ui/src/render.js`
  answers that without touching the layout: hovering a node lights it, its
  edges and their far ends; hovering a line lights just that line and the two
  things it joins; one class on the `<svg>` dims the rest, so the cost of a
  hover does not grow with the drawing. The wide transparent copy of each
  edge is what makes a hairline hittable, and "one colour per edge" in the
  appearance panel is the same problem answered with hue. None of it removes
  anything from the view.
- **Edges are joined to the SVG by position, not by name.** Graphviz writes an
  edge's `<title>` as `tail->head` with the port dropped and the compass point
  kept, and a Rust node id is full of colons — that string cannot be split
  back into two ids. So `dot.js` stamps `id="edge_<i>"` on every edge, `i`
  being its index in `view.edges`, and `render.js` looks the endpoints up in
  the same array. Reorder the edges between the two and the highlighting joins
  the wrong things.
- **Filter state lives in the URL hash; appearance lives in localStorage.** A
  view is something you share, so it belongs in the link — and only what
  differs from the defaults goes in, so a plain view has a plain link. A colour
  scheme is a standing preference, so it does not. Do not move either.
- **A link outlives the crate it was written for.** The server always defaults
  to the same port, so a view saved against one project will be reoffered
  against another. `reconcile` in `ui/src/state.js` drops anything the loaded
  crate does not have and the status line says what it dropped. A filter for a
  crate you are not looking at must never leave a blank page.
- **A blank canvas must explain itself.** `buildView` returns an `emptyReason`
  naming the filter that emptied the view. The sidebar still lists every
  artifact when nothing is drawn, so silence reads as a bug.
- **Turning every edge type off shows the artifacts, unconnected.** It is a
  request to see what is there, not to see nothing; orphan pruning is skipped
  when there are no edges at all.
- **Artifact kinds and edge kinds are one choice, not two.** A call graph drawn
  over structs has nothing joining it; a type graph with every call in it is
  unreadable. That is what the presets in `panels/filters.js` exist for, and
  why a new diagram worth reading should arrive as a preset rather than as
  instructions to tick six boxes.
- **Panels are rebuilt, not mutated.** A panel function takes state and returns
  a fresh subtree. Build all of it — a `<details>` that fills itself in only
  when already open renders empty on the click that opens it, which is exactly
  the bug `section` in `dom.js` is written to avoid.
- **What is folded is not part of the view.** Every panel is a `<details>`, and
  which ones are shut — like which module rows are shut, and how wide the
  sidebar is — says nothing about what is drawn. None of it belongs in the URL:
  panel folding lives in `dom.js`, module folding in a set `main.js` owns, and
  the sidebar's width in localStorage beside the colours.
- **The module tree's guide lines are computed, not decorative.** A guide
  column is drawn only where the subtree it stands for has rows below the one
  being drawn, and the row's own column turns into a tee or an elbow depending
  on whether more siblings follow — that is what `guideColumns` in
  `panels/modules.js` works out in one pass from the bottom. The rows carry no
  vertical padding for the same reason: a line broken every twenty-four pixels
  reads as a list of dashes, not as a tree.

### Serving and exporting

- **The file watcher counts only `Create`, `Modify` and `Remove`.** Reads are
  events too, and serving the model reads every source file — count those and
  the page reloads forever.
- **`export` never deletes.** It writes into an empty directory or over a
  previous export, and refuses anything else. Working out which files in a
  stranger's directory were probably ours is not a guess worth making.

## Conventions

- Comments explain *why*, not *what*. The existing code is dense with
  rationale; match that density. Do not add comments restating the code.
- Module-level docs (`//!` in Rust, a header comment in each `.js`) carry the
  contract for that file. Keep them current when behaviour changes.
- Browser code is typed with JSDoc, so a TypeScript-aware editor checks it
  while nobody needs a package manager to run it. Keep the annotations honest.
- User-facing strings — status line, tooltips, errors — are sentences, and say
  what to do next where there is something to do.

## Testing

- **Extraction tests live beside the code**, in `src/extract/mod.rs`, because
  the fixtures *are* the test: each one is a few lines of inline Rust source
  handed to `extract_sources`, asserted against the model that comes back. A
  new edge kind, a new `Via` rule or a new resolution case needs one.
- Cover the shape, not the crate: "`Vec<Foo>` in a return position is
  `rel=return, via=generic`", "two modules both defining `Error` stay two
  nodes", "`#[cfg(test)] mod tests` produces nothing".

### Checking the viewer

There is no test runner for the browser half, and it is the half that breaks
visibly. Two things work:

```sh
# The modules are plain ESM, so filtering and DOT generation run under node.
node --input-type=module -e 'import { buildView } from "./ui/src/filter.js"; …'

# And a headless Chromium renders the real page, DOM and all.
chromium --headless=new --disable-gpu --virtual-time-budget=25000 \
  --dump-dom http://127.0.0.1:7878/
chromium --headless=new --disable-gpu --window-size=1600,1000 \
  --virtual-time-budget=25000 --screenshot=shot.png http://127.0.0.1:7878/
```

`--virtual-time-budget` is what lets the fetch, the WebAssembly load and the
layout finish before the dump. **Look at the screenshot.** Every layout bug
this project has had — text outside its box, a keyword welded to a type name,
an empty panel — was invisible to an assertion on the generated DOT and
obvious in a picture.

## Where to add things

| Task | Files |
|---|---|
| New edge kind | `Rel` in `src/model.rs` + `ui/src/model.js` (`RELS`, `REL_LABELS`), a default colour in `ui/src/appearance.js`, emit it in `src/extract/visitor.rs`, a fixture test |
| New artifact kind | `NodeKind` in `src/model.rs` + `ui/src/model.js`, a default colour, and a decision in `dot.js` about whether it draws as a table or a plain node |
| New type position | an arm in `src/extract/types.rs` with its `Via` stated |
| New call shape | a `visit_expr_*` hook in `src/extract/visitor.rs` feeding `Callee`, and a resolution rule in `src/extract/calls.rs` |
| New preset | `presetPanel` in `ui/src/panels/filters.js`, setting kinds and rels together |
| New markdown syntax | a block rule in `renderMarkdown` or an arm in `inline`, both in `ui/src/markdown.js`, plus a style under `.prose` in `style.css` |
| New filter | a field on `FilterState` in `ui/src/state.js` (defaults included, so the URL stays short), the rule in `ui/src/filter.js`, a control in `ui/src/panels/` |
| New panel | `ui/src/panels/<name>.js`, mounted in `renderSidebar` in `ui/src/main.js` |
| New subcommand | a variant in `src/main.rs` plus its own module (and a `--module` scope, like the others) |

## Known limits

Deliberate, and worth knowing before you chase one as a bug: `#[path = "..."]`
attributes are not honoured, macro-generated items are invisible, only the
current crate is indexed so types from dependencies do not appear, and roots
are inferred from the file layout rather than read from `cargo metadata`.

`--module` narrows "the current crate" to the modules named, which costs
resolution accuracy in one specific way: a short name whose definition lives
outside the scope resolves to nothing, or — when something inside the scope
happens to share the name — to the wrong one. That is the price of not parsing
the rest, and it is why the scope is never the default.

Calls have two more. `syn` does not parse macro bodies, so a call made inside
`write!`, `bail!` or any other macro is not seen; and calls the language
inserts rather than the author writing them — `?` reaching for `From::from`,
an operator reaching for `Add::add` — are not there to find.

If resolution accuracy ever becomes the limiting factor, the escape hatch is a
second extraction backend behind the same JSON model:
`cargo +nightly rustdoc --output-format json` yields fully resolved item ids
and would retire `src/resolve.rs` entirely. It is not the default because it
is nightly-only and the format churns between releases — but the model is
shaped so it could plug in without the viewer noticing.

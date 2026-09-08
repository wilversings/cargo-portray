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
- **Filter state lives in the URL hash; appearance lives in localStorage.** A
  view is something you share, so it belongs in the link — and only what
  differs from the defaults goes in, so a plain view has a plain link. A colour
  scheme is a standing preference, so it does not. Do not move either.
- **The hash is `key=value&key=value`, written to be read.** A link is quoted
  in prose and edited by hand, so `#kinds=struct,enum&depth=2` beats encoded
  JSON: lists are comma-separated, flags are `true`/`false` (a bare key is on),
  and `encodePart` in `ui/src/state.js` escapes only what would break that
  shape, leaving the colons in a module path alone. Anything the grammar does
  not know — an unknown key, a kind that is not a kind, a `depth` that is not a
  number — is dropped rather than believed, and links written before this
  format still open through `parseLegacy`.
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
  the sidebar's width in localStorage beside the colours. The module tree's
  search box is the same kind of thing: it narrows which rows are *listed* and
  never which artifacts are *drawn*, so it lives beside the folds in `main.js`
  rather than in `FilterState`, and a search left in the box changes nothing
  about the link you share. It overrides folding while it is on, because a
  match counted in the line under the box and then left shut inside a folded
  ancestor reads as a lie.
- **The toolbar is sidebar furniture; the canvas switches are not.** Search,
  fit, reset and export act on the view as a whole, which is the errand the
  panels under them are for — deciding what is drawn — so they sit in a row
  below the crate name and above the first panel, not over the drawing. What
  floats over the canvas is only what acts on the canvas: the lock and full
  screen, which move what is already drawn and never choose it. Anything new
  that belongs to the view as a whole goes in the toolbar; anything that only
  moves the drawing goes in the switches. A strip across the top of the window
  is still not on offer — that was what the drawer this row replaced was
  avoiding, and the sidebar already had the width to spend.
- **The three file formats are one control, not three.** DOT, SVG and PNG are
  the same errand branching at the last step, so `exportControl` in `main.js`
  spends one icon on them and asks which format only once the reader has said
  they want a file — three words in the row would have been three decisions
  taken before there was a question. The menu is plain DOM with its own local
  state rather than another display-only flag: it belongs to the toolbar it is
  built with, and a rebuilt toolbar shutting it is the right answer anyway.
  What has to be remembered outside it is only how to close it — `closeExport`
  — because a menu open behind a hidden sidebar, or left holding its
  outside-click listener after a rebuild, is a menu nobody can reach.
  `#toolbar .menu-items[hidden]` needs `display: none` spelled out, because
  `display: flex` outranks what the `hidden` attribute asks for.
- **Full screen and the lock are display-only too, and not even remembered.**
  The two switches floating over the diagram — one hides the sidebar, one pins
  the view so the wheel and a drag stop moving it — change
  what is around the diagram and never what is in it, so like the folds they
  stay out of the URL. Unlike the sidebar's width they stay out of
  localStorage as well: a reader who cleared the chrome to look at one diagram
  should not find it gone the next time the page opens, and Escape is the way
  back for anyone who took a switch for a one-way door — innermost first, so it
  shuts an open export menu before it brings the panels back, and one press
  undoes one thing. Going full screen takes the toolbar with the sidebar it is
  in, which is also why full screen itself cannot live in there: a control that
  removes the surface it stands on has to stand somewhere else. The status line
  is not chrome — it is where a
  view with nothing in it says why — so it stays.
  The lock itself lives in `render.js` rather than in `panzoom.js` because
  every redraw builds a new SVG and a new pan, and a lock the reader switched
  on must survive the next filter click; it stops the gestures only, so a click
  still selects and `fit` still fits. The switches are icons, drawn by `icon`
  in `dom.js` as paths on a 24-unit grid, because an icon set is a dependency
  and a handful of outlines are a few dozen path commands — and because a
  button with no text in it has nothing for a screen reader to read, `toggle`
  promotes the tooltip to the accessible name whenever the label is not a
  string. The box they sit in is shrink-wrapped to the two of them, so the
  diagram beside it keeps every pointer that lands there.
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
| New filter | a field on `FilterState` in `ui/src/state.js` (defaults included, so the URL stays short; list- and flag-valued fields go in `LIST_KEYS` or `FLAG_KEYS` so the hash round-trips), the rule in `ui/src/filter.js`, a control in `ui/src/panels/` |
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

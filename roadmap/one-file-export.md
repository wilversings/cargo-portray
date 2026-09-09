# The one-file export: what it survives, and what it does not

`src/inline.rs` folds `ui/` into a single `.html`. It works today — the bundled
modules produce byte-identical DOT and byte-identical Graphviz SVG against the
served viewer, 21 modules, 1.1 MB. That is not the question. The question is
whether it still works after the viewer changes, and **nothing in the build
tells you when it stops.**

This file is the list of ways it stops.

## The bargain, and where it leaks

The design is: read the ES module syntax a hand-written page is written in, and
refuse anything else with a sentence naming the line. A refusal is a good
outcome — it is an export that did not happen, next to a `serve` that still
works, and someone reads the message.

The leak is that "refuse anything else" is only true for syntax the reader
*recognises as syntax*. Everything it does not recognise is copied through
verbatim, and lands in one of two places:

| Outcome | Where you find out | How bad |
|---|---|---|
| Refused, nothing written | the terminal, immediately | fine — this is the design working |
| Copied through, invalid JS | the browser console, blank page | bad: `export` said "wrote … 1.1 MB" |
| Copied through, valid but wrong | never, until behaviour is subtly off | worst |

Every entry below was reproduced against the current code with a throwaway
viewer directory and `--ui`. None of them is theoretical.

## What it correctly refuses

| Change | Message |
|---|---|
| `import x from "some-package"` | *"a page folded into one file has no package manager"* |
| `export let` / `export var` | *"cannot fold this export into one file"* — an importer reads the binding once, so a stale copy is worse than no export |
| An import cycle | *"import cycle: src/a.js → src/b.js → src/a.js"*, and no file is written |
| `</script` inside anything inlined | *"would end it early"* |
| `index.html` losing `content="api/graph"`, or growing a second one | *"no longer holds exactly one …"* (`src/export.rs`) |
| `index.html` losing `</body>` | same |
| An import/export it cannot parse | the statement, quoted, with the file name |

That is a decent net. The rest of this file is what goes through it.

## What goes through — verified

### 1. Top-level `await` — the worst one

```js
const model = await fetch(...);   // in any module
```

The export **succeeds and prints its usual line.** Each module body is wrapped
in `(() => { … })()`, a non-async arrow, so the emitted script is:

```js
__modules["src/main.js"] = (() => {
const lazy = await import("./lazy.js");
```

`node --check` on that: `SyntaxError: Unexpected reserved word`. In a browser
the whole inline module script fails to parse, so the page is blank, with one
console line. The served viewer is unaffected, so this is exactly the
bundled-only divergence the design set out to avoid.

Why it matters: top-level `await` is the natural way to initialise WebAssembly,
and `ui/src/render.js` is one refactor away from wanting it. Today `main.js`
ends in `void main();` and dodges it by accident, not by rule.

Fix is small — wrap in `(async () => { … })()` — but then every module becomes
a promise and `__modules[…]` is no longer the exports object. The honest fix is
to detect it and refuse.

### 2. Dynamic `import()`

```js
const heavy = await import("./graphviz-wrapper.js");
```

Copied through untouched. The scanner only looks at statements that *begin* a
line with the `import` keyword, and this one begins with `const`. The specifier
stays a relative URL, resolves against the page's own `file://` URL, and the
fetch is blocked by the opaque origin — the exact failure the one-file export
exists to avoid. The module is also never visited, so it is not in the bundle
at all.

Code-splitting to shrink the 819 kB of Graphviz is an obvious future move. It
would break this export silently.

### 3. A vendored file whose minifier omits the trailing semicolon

`take_export_clause` finds `export{a as Thing};` welded to the end of a
minified line. It requires the `;`. Given `const a=1;export{a as Thing}` it
matches nothing, copies the line into the closure, and produces:

```js
__modules["vendor/lib.js"] = (() => {
const a=1;export{a as Thing}
return {  };
})();
```

— an `export` inside a function, another `SyntaxError`, and an empty exports
object besides. The export reported success.

This is not a hypothetical either: `README.md` documents re-vendoring Graphviz
with a bare `curl` from unpkg. Upstream changing minifier, or shipping a build
with two export clauses, or an `export default`, silently poisons the one-file
export while `serve` keeps working.

**A module that ends up with zero exports is the tell**, and the bundler
already knows the count.

### 4. Two `<script type="module">` entry points

Each becomes its own inline module script with its own `const __modules = {}`.
Verified: a `state.js` imported by both is emitted twice and **evaluated
twice**, so a store that is one object in the browser is two objects in the
page. No error, no warning, wrong behaviour.

The registry would have to be shared across entry points — one `<script>` for
the graph, one per entry after it — or the export should refuse a second one.

### 5. References the tag scanner does not follow

`FOLLOWED` is `["link", "script", "img"]`, and only `href`/`src` on those.
Verified left pointing at files that no longer exist beside the page:

- `srcset` on an `<img>` (the `src` is inlined; the `srcset` is not, so a
  2× display loads nothing)
- `url()` inside an **inline** `<style>` block — only external stylesheets are
  scanned
- anything on `<video>`, `<audio>`, `<source>`, `<object>`, `<embed>`
- `<use href="sprite.svg#icon">` in inline SVG — the likely shape of an icon
  set, and a plausible next step for this viewer
- `@font-face` in an inline style; a webfont is also the thing most likely to
  push the page past a comfortable size, since base64 costs 4/3

### 6. `<link rel="modulepreload">`

Falls through to the generic link branch and becomes a `data:text/javascript`
URI holding **the unbundled source of that module**, relative imports and all.
So the page carries a second copy of the file, and the browser fetches, parses
and fails it. Harmless today, wasteful, and it will look inexplicable to
whoever hits it.

## So: will it survive a drastic change?

| Change to `ui/` | Survives? |
|---|---|
| More modules, renamed files, new subdirectories | **Yes.** Nothing is hardcoded; the module count went 19 → 21 with no code change |
| Splitting a big module, moving a directory | Yes |
| A new hand-written vendored library | Probably — depends on how it was minified (#3) |
| Lazy-loading Graphviz | **No, silently** (#2) |
| Top-level `await` anywhere | **No — page is blank** (#1) |
| A web worker | No: `new Worker(new URL(…))` cannot be a data URI without rewriting it into a blob |
| A second entry point | **No, silently** (#4) |
| An icon sprite, a webfont, a `<video>` | Partly (#5) |
| Moving the stylesheet inline | Partly (#5) |
| `import.meta.url` | No — it becomes the page's URL, not the module's. Nothing uses it today, including the vendored Graphviz |
| TypeScript, JSX, a bundler | Out of scope: `AGENTS.md` forbids the toolchain, which is what keeps the input to this an ES subset |
| A much larger crate | Works, but the model is inlined, so the page grows with the graph and nothing is cached between opens |

The pattern is clear enough to state as a rule: **the inliner is robust to the
viewer growing and fragile to the viewer getting cleverer.** Every silent
failure above is a modern-JS feature, and every one of them is something you
would reach for to make the *served* viewer faster.

## Nothing catches any of this

- **No workflow runs `cargo test`.** `.github/workflows/` holds `deploy-pages`
  and `publish-crate`; neither runs the test suite. `publish-crate` runs
  `cargo publish` and nothing else.
- `deploy-pages` runs `cargo run -- export . -o site` — the **directory** path.
  The one-file path has no CI coverage at all.
- `the_viewer_folds_into_one_page` is the one test that reads the real `ui/`,
  and it only asserts that no `src="src/…"` survives and that a `<style>` and a
  data URI are present. It would pass on every failure in this document.

## What to do about it, cheapest first

1. **A post-bundle sanity check, in Rust, before the page is written.** Scan
   each emitted module body for what must not be in it any more:
   `import` / `export` as statement-leading keywords, `import(`, `import.meta`,
   and `await` at a top-level position in the body. Refuse with the file and
   line. This alone converts #1, #2 and #3 from *page is blank* into *export
   refused*, which is the principle `src/inline.rs` already argues for, applied
   to its own output. Perhaps forty lines.
2. **Refuse a module that exports nothing** unless it is only imported for its
   side effects — the other half of #3, and free once you have the count.
3. **Refuse a second `<script type="module">`** (#4) until the registry is
   shared. One `ensure!`.
4. **Run `cargo test` in CI.** Nothing here is expensive; the suite is 50 tests
   and reads only the working tree.
5. **Widen `FOLLOWED`** to `source`/`video`/`audio`/`use`, add `srcset`, and
   scan inline `<style>` bodies with the same `css_urls` already written (#5).
   Skip `modulepreload` rather than data-URI it (#6).
6. **Keep the differential.** Real-vs-bundled DOT and SVG comparison under
   node caught nothing that the assertions above would not, but it is the only
   check that tests *behaviour* rather than shape. Node is a dev-only
   dependency here — it never reaches a user, so this does not violate the
   no-npm rule — but it does mean the check cannot run in the same breath as
   `cargo test`. Worth a script in `scripts/`, not worth blocking on.

Items 1–3 are the ones that matter. They cost an afternoon and turn every
verified silent failure in this document into a sentence in the terminal.

## Adjacent, not the inliner

`src/ui.rs` resolves `ui/` through `env!("CARGO_MANIFEST_DIR")` at runtime, for
both export modes. So an installed binary reads the crate's registry source
directory, and a binary installed with `cargo install --path .` reads the live
checkout — which is why an old installed `cargo-portray` can print an old
message while reading today's `ui/`. It is a documented trade (`Cargo.toml`
says so), but it means "which viewer did that export fold?" has a
less obvious answer than it looks.

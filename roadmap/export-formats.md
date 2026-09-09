# Export formats

Where the text exports stand, and what a Mermaid one would cost.

Today the export menu offers DOT, PlantUML, SVG and PNG. DOT is the source the
drawing is laid out from, so it loses nothing. PlantUML is a second drawing of
the same view, and it loses the things below.

## PlantUML: known issues

`ui/src/plantuml.js`. Rendering checked against PlantUML 1.2026.8.

### Lost on purpose

The format cannot hold these. Each one is a deliberate trade, not a bug.

| What | What happens instead |
|---|---|
| Edges from a field row | PlantUML has no ports, so the arrow leaves the whole struct and carries the field's name as its label. Two fields pointing at the same type give two arrows off the same box. |
| One arrowhead per relation | Every arrow is drawn alike. The relation is the colour plus a word (`calls`, `param`, `returns`, …). |
| Enum struct-variant braces | `Restore { resource: Key }` is drawn as `Restore (resource: Key)`. A `}` inside a class body can end the body early. |
| Item docs | Not exported, same as the drawing. They live in the sidebar. |

The first two are worth revisiting:

- **UML arrowheads.** `..|>` for `impls`, `--|>` for `supertrait`, `*--` for
  `field` would make the export read as UML instead of as a coloured graph.
  Needs the combined form (`-[#color,dashed]-|>`) checked against a real
  PlantUML before shipping; that is why it is not in yet.
- **A legend.** Colour with nothing explaining it is decoration. A few `note`
  lines, or a legend block, would make a standalone `.puml` readable.

### Rough edges

- **Long package labels.** Impl groups are labelled `extract::calls::impl
  CallIndex`, not `impl CallIndex`. PlantUML packages have no alias, and the
  label is the identity — two modules that both define `Error` would otherwise
  share one box. Fix: only qualify when the short label is taken.
- **Long aliases.** Up to ~64 characters, e.g.
  `n_extract__visitor___Collector_as_Visit___visit_expr_method_call`. Readable,
  but the arrow list at the bottom of the file is wide. Fix: shorter aliases,
  at the cost of a file you cannot hand-edit.
- **`{field}` on every member line.** Invisible when rendered, noise in the
  source. It is what keeps `Wrap(Key)` out of the method compartment.
- **Layout drift.** PlantUML picks its own layout, so the same view is arranged
  differently from the Graphviz drawing. Only the direction (`left to right` /
  `top to bottom`) carries over.
- **Big views tangle.** The whole crate — 199 nodes, 448 edges — renders, but
  the result is not worth looking at. Same as the drawing, so filter first.

### Not checked

- **Older PlantUML versions.** Only 1.2026.8 was tested. The two constructs
  most likely to differ are the inline element colour
  (`class "X" as n1 <<struct>> #ffe08a`) and the `<<Rectangle>>` package style.
- **Markup in type names.** PlantUML draws unknown tags literally, so
  `Vec<String>` is fine. A type or lifetime spelled like a real tag — `<u>`,
  `<i>`, `<size:…>` — would be swallowed. Not seen in practice.
- **Nothing runs in CI.** The check is manual:

  ```sh
  podman run --rm -v "$PWD":/w:z -w /w docker.io/library/eclipse-temurin:21-jre-jammy \
    java -Djava.awt.headless=true -jar plantuml.jar -checkonly -Playout=smetana out.puml
  ```

  `-checkonly` exits 200 on a file it cannot parse. Rendering a PNG and looking
  at it is the other half — every layout bug this project has had was invisible
  in the text.

## Mermaid: what it would take

Same shape as PlantUML: a `ui/src/mermaid.js` that walks the tree from
`ui/src/tree.js`, plus one more item in `exportControl` in `ui/src/main.js`.
Nothing in Rust, nothing new in the model.

### The fork: which dialect

This is the decision that has to come first, because the two lose different
halves of the view.

| | `classDiagram` | `flowchart` |
|---|---|---|
| Module tree | `namespace` blocks, **which do not nest** — `a::b::c` flattens to one box | `subgraph`, nests properly |
| Impl groups | no | yes, another `subgraph` |
| Member rows | yes | no — only a multi-line label |
| Kind of node | class / interface, with stereotypes | a box, shaped by syntax |
| Relations | real UML arrows (`..\|>`, `--\|>`, `*--`) | plain arrows with labels |

**Recommendation: flowchart.** The nested module tree is what this viewer is
about, and it is the one thing `classDiagram` cannot draw. Struct fields are
already optional in the drawing (the "members" switch), so losing them hurts
less than flattening the crate.

If both turn out to be wanted, the menu can ask — but ship one first.

### Work items

1. **Ids and labels.** Mermaid ids cannot hold `::`, `<`, `>` or spaces;
   `sanitize` in `tree.js` already does that job. Labels need quoting, and
   `<`/`>`/`"` inside them need `#lt;` / `#gt;` / `#quot;`.
2. **Colours.** One `classDef` per artifact kind, applied per node. Edges are
   harder: `linkStyle` addresses links **by index**, so the emitter has to
   count edges as it writes them and emit a matching `linkStyle` line for each.
3. **Line styles.** `-->` for direct, `-.->` for generic, `==>` for dyn — the
   nearest thing Mermaid has to `viaStyles`.
4. **Size guard.** Mermaid refuses big diagrams: `maxTextSize` defaults to
   50 000 characters and `maxEdges` to 500. This crate's unfiltered view is
   ~58 kB and 448 edges — already over one limit and near the other. The export
   should say so in the status line rather than hand over a file that fails to
   render on GitHub.
5. **Copy, not just download.** A Mermaid diagram usually goes straight into a
   README or an issue as a ```` ```mermaid ```` fence. A "copy" item is worth
   more here than a `.mmd` file, and probably worth adding to PlantUML at the
   same time.

### How to check it

`mermaid.parse()` runs under node and reports syntax errors without drawing
anything — that is the cheap gate. Actually rendering needs
`@mermaid-js/mermaid-cli`, which drives a headless Chromium; there is none on
this machine, so plan on pasting into a GitHub comment or the live editor to
look at the result.

### Size of the job

The generator is small — roughly the size of `plantuml.js`, around 200 lines.
The dialect decision and the checking path are the real work.

## Not planned

**GraphML** was considered alongside these two. It is not a drawing format —
the point is that the data survives into yEd or Gephi — so it belongs in the
Rust `emit` side, where the whole graph is available, rather than in the
browser where the view has already been filtered down. Worth doing only if
someone wants to analyse the graph rather than look at it.

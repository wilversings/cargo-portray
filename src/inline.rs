//! Folding a page and everything it loads into one file.
//!
//! A directory of files is what a static host wants. It is not what a *reader*
//! wants: a browser will not load an ES module or fetch a sibling file from a
//! `file://` page, so an exported directory cannot be opened by double-clicking
//! it — it has to be served. A page with nothing beside it can be, and can also
//! be attached to a message or committed next to a design note.
//!
//! Nothing here knows what it is folding. It reads a page, follows whatever
//! that page references — stylesheets, icons, images, scripts — and gives back
//! one string. The one thing that takes real work is a `type="module"` script,
//! because inlining its body is not enough: its imports are relative URLs that
//! stop resolving the moment the file they were written in stops existing. So
//! the module graph is walked, each module keeps its own scope in a closure,
//! and every `import` becomes a lookup by the id an `export` filled in.
//!
//! It reads the ES module syntax a hand-written page is written in, and stops
//! on anything else with a sentence naming the line. A bundler that guesses at
//! syntax it does not know produces a page that loads and then misbehaves,
//! which is worse than an export that refuses.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// A page with everything it referenced folded into it.
pub struct Page {
    pub html: String,
    /// How many ES modules went into it, for the line the export prints.
    pub modules: usize,
}

/// Folds `index` and everything it references into one self-contained page.
///
/// Paths are resolved against the page's own directory, and a reference that
/// leads outside it, or to another host, is left alone: this inlines a local
/// tree, and quietly reaching further than that would be the wrong surprise.
pub fn page(index: &Path) -> Result<Page> {
    let root = index
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    let html = read(index)?;
    let mut modules = 0;
    let out = rewrite_tags(&html, &mut |tag: &Tag| fold(&root, tag, &mut modules))?;
    Ok(Page { html: out, modules })
}

/// What one tag becomes, or `None` for tags that stay as they are.
fn fold(root: &Path, tag: &Tag, modules: &mut usize) -> Result<Option<String>> {
    let Some(reference) = tag.attr(if tag.name == "link" { "href" } else { "src" }) else {
        return Ok(None);
    };
    let Some(id) = local(&reference) else {
        return Ok(None);
    };

    match tag.name.as_str() {
        "link" if tag.attr("rel").as_deref() == Some("stylesheet") => {
            let css = stylesheet(root, &id)?;
            Ok(Some(format!("<style>\n{}\n</style>", css.trim_end())))
        }
        // Icons, images and anything else a `rel` points at: the tag stays,
        // and only where it points changes.
        "link" | "img" => Ok(Some(tag.with_data_uri(root, &id)?)),
        "script" if tag.attr("type").as_deref() == Some("module") => {
            let (script, count) = bundle(root, &id)?;
            *modules += count;
            Ok(Some(guard(format!(
                "<script type=\"module\">\n{script}</script>"
            ))?))
        }
        "script" => Ok(Some(guard(format!(
            "<script>\n{}\n</script>",
            read(&root.join(&id))?.trim_end()
        ))?)),
        _ => Ok(None),
    }
}

/// An inline script ends at the first `</script`, wherever that stands.
///
/// Escaping it away needs a JavaScript parser to know whether it is in a string
/// or in code, and saying so is enough: a page that would break silently is
/// worth stopping for.
fn guard(script: String) -> Result<String> {
    let body = script.to_ascii_lowercase();
    anyhow::ensure!(
        body.matches("</script").count() == 1,
        "a script being inlined contains `</script`, which would end it early — \
         write it split up, or keep it in a file the page loads",
    );
    Ok(script)
}

/// A local relative reference, or `None` for anything we should not follow.
fn local(reference: &str) -> Option<String> {
    let unusable = reference.is_empty()
        || reference.starts_with('#')
        || reference.starts_with('/')
        || reference.starts_with("//")
        || reference.contains("://")
        || reference.starts_with("data:");
    (!unusable).then(|| {
        reference
            .split(['?', '#'])
            .next()
            .unwrap_or(reference)
            .to_string()
    })
}

// ---------------------------------------------------------------- stylesheets

/// A stylesheet with its own references folded in, `@import`s included.
fn stylesheet(root: &Path, id: &str) -> Result<String> {
    let css = read(&root.join(id))?;
    let mut out = String::new();
    let mut rest = css.as_str();
    // `@import` first, so a sheet pulled in also gets its own urls inlined.
    while let Some(at) = rest.find("@import") {
        out.push_str(&rest[..at]);
        let (statement, tail) = rest[at..].split_once(';').unwrap_or((&rest[at..], ""));
        match import_target(statement).as_deref().and_then(local) {
            Some(target) => out.push_str(&stylesheet(root, &join(id, &target))?),
            None => {
                out.push_str(statement);
                out.push(';');
            }
        }
        rest = tail;
    }
    out.push_str(rest);
    Ok(css_urls(root, id, &out))
}

/// The path in `@import "x.css"` or `@import url(x.css)`.
fn import_target(statement: &str) -> Option<String> {
    let rest = statement.strip_prefix("@import")?.trim_start();
    let rest = rest
        .strip_prefix("url(")
        .map_or(rest, |after| after.trim_start());
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        return rest[1..].split(quote).next().map(str::to_string);
    }
    rest.split(')').next().map(|path| path.trim().to_string())
}

/// Every `url(...)` in a stylesheet that names a local file, as a data URI.
fn css_urls(root: &Path, id: &str, css: &str) -> String {
    let mut out = String::new();
    let mut rest = css;
    while let Some(at) = rest.find("url(") {
        out.push_str(&rest[..at + 4]);
        rest = &rest[at + 4..];
        let Some((inside, tail)) = rest.split_once(')') else {
            break;
        };
        let trimmed = inside.trim();
        let quote = trimmed
            .starts_with(['"', '\''])
            .then(|| trimmed.as_bytes()[0] as char);
        let bare = trimmed.trim_matches(|c| c == '"' || c == '\'');
        let replaced = local(bare)
            .map(|path| join(id, &path))
            .and_then(|target| data_uri(&root.join(target)).ok());
        match (replaced, quote) {
            (Some(uri), Some(quote)) => out.push_str(&format!("{quote}{uri}{quote}")),
            (Some(uri), None) => out.push_str(&uri),
            (None, _) => out.push_str(inside),
        }
        out.push(')');
        rest = tail;
    }
    out.push_str(rest);
    out
}

// --------------------------------------------------------------- ES modules

/// The name the bundle hangs its modules off. Nothing else is introduced into
/// the page's scope.
const REGISTRY: &str = "__modules";

/// Every module `entry` reaches, in dependency order, as one script.
///
/// Each module keeps its own scope — the bodies go into separate closures, not
/// into one shared one — so two modules may name the same local and nothing has
/// to be renamed.
fn bundle(root: &Path, entry: &str) -> Result<(String, usize)> {
    let mut walk = Walk {
        root,
        done: BTreeSet::new(),
        stack: Vec::new(),
        out: String::new(),
        count: 0,
    };
    walk.visit(entry)?;
    let script = format!(
        "// Every module of this page, in dependency order, written by an \
         inliner.\n// Edit the files it was built from, not this.\n\
         const {REGISTRY} = {{}};\n{}",
        walk.out
    );
    Ok((script, walk.count))
}

struct Walk<'a> {
    root: &'a Path,
    done: BTreeSet<String>,
    /// The chain of modules being read, so a cycle is a sentence rather than a
    /// stack overflow. ES modules allow one; a bundle in evaluation order
    /// cannot, because there is no order that would satisfy it.
    stack: Vec<String>,
    out: String,
    count: usize,
}

impl Walk<'_> {
    fn visit(&mut self, id: &str) -> Result<()> {
        if self.done.contains(id) {
            return Ok(());
        }
        anyhow::ensure!(
            !self.stack.iter().any(|seen| seen == id),
            "import cycle: {} → {id}, which cannot be folded into one file",
            self.stack.join(" → "),
        );
        let source = read(&self.root.join(id))?;
        let module = rewrite_module(id, &source)?;
        self.stack.push(id.to_string());
        for dep in &module.deps {
            self.visit(dep)?;
        }
        self.stack.pop();
        self.done.insert(id.to_string());
        self.count += 1;
        self.out.push_str(&module.render(id));
        Ok(())
    }
}

/// One module, with its imports and exports turned into plain assignments.
#[derive(Debug)]
struct Module {
    body: String,
    /// Module ids, already resolved against this module's own directory.
    deps: Vec<String>,
    /// `(local, exported)`, in the order the file names them.
    exports: Vec<(String, String)>,
}

impl Module {
    fn render(&self, id: &str) -> String {
        let named = self
            .exports
            .iter()
            .map(|(local, exported)| {
                if local == exported {
                    local.clone()
                } else {
                    format!("{exported}: {local}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let body = self.body.trim_end();
        format!("{REGISTRY}[{id:?}] = (() => {{\n{body}\nreturn {{ {named} }};\n}})();\n")
    }
}

/// Reads one module, rewriting every `import` and `export` statement in it.
fn rewrite_module(id: &str, source: &str) -> Result<Module> {
    let lines: Vec<&str> = source.lines().collect();
    let mut module = Module {
        body: String::new(),
        deps: Vec::new(),
        exports: Vec::new(),
    };
    let mut at = 0;
    let mut reexports = 0;
    while at < lines.len() {
        let line = lines[at];
        let trimmed = line.trim_start();
        if starts_statement(trimmed, "import") {
            let statement = gather(id, &lines, &mut at, complete_import)?;
            let (spec, binding) = parse_import(id, &statement)?;
            let dep = module.depend(id, &spec)?;
            match binding {
                Binding::None => module.body.push_str(&format!("{REGISTRY}[{dep:?}];\n")),
                Binding::Namespace(name) => {
                    module
                        .body
                        .push_str(&format!("const {name} = {REGISTRY}[{dep:?}];\n"));
                }
                Binding::Named(list) => {
                    module
                        .body
                        .push_str(&format!("const {{ {list} }} = {REGISTRY}[{dep:?}];\n"));
                }
            }
        } else if starts_statement(trimmed, "export") {
            // Only a name list is worth reading past the end of its line: a
            // declaration is followed by its own body, which is not part of the
            // statement and must not be read as one.
            let rest = trimmed
                .strip_prefix("export")
                .unwrap_or_default()
                .trim_start();
            let statement = if rest.starts_with('{') {
                gather(id, &lines, &mut at, complete_export_clause)?
            } else {
                trimmed.to_string()
            };
            at = handle_export(id, &statement, &mut module, &mut reexports, &lines, at)?;
        } else if let Some((remainder, names)) = take_export_clause(line) {
            // The minified build of a library puts its export clause on the end
            // of its last line rather than on one of its own.
            module.exports.extend(names);
            if !remainder.trim().is_empty() {
                module.body.push_str(&remainder);
                module.body.push('\n');
            }
        } else {
            module.body.push_str(line);
            module.body.push('\n');
        }
        at += 1;
    }
    Ok(module)
}

impl Module {
    /// Records a dependency, resolved, and gives back its id.
    fn depend(&mut self, id: &str, spec: &str) -> Result<String> {
        anyhow::ensure!(
            spec.starts_with("./") || spec.starts_with("../"),
            "{id}: imports `{spec}`, and a page folded into one file has no \
             package manager to resolve anything but a relative path with",
        );
        let dep = join(id, spec);
        if !self.deps.contains(&dep) {
            self.deps.push(dep.clone());
        }
        Ok(dep)
    }
}

/// Whether a line opens a statement with `keyword`, rather than merely starting
/// with those letters — `exportControl()` is not an export.
fn starts_statement(trimmed: &str, keyword: &str) -> bool {
    trimmed.strip_prefix(keyword).is_some_and(|rest| {
        rest.starts_with(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
    })
}

/// One statement, however many lines a formatter wrapped it over.
///
/// Where it ends is asked of the statement itself rather than of a semicolon,
/// because a name list wrapped over six lines has none until the last of them
/// — and because a declaration must not swallow the body that follows it.
fn gather(id: &str, lines: &[&str], at: &mut usize, done: fn(&str) -> bool) -> Result<String> {
    let mut statement = lines[*at].trim().to_string();
    while !done(&statement) {
        *at += 1;
        let next = lines
            .get(*at)
            .with_context(|| format!("{id}: unterminated statement: {statement}"))?;
        statement.push(' ');
        statement.push_str(next.trim());
    }
    Ok(statement)
}

/// An import is complete once the module it names has been closed off.
fn complete_import(statement: &str) -> bool {
    let after = match statement.split_once(" from ") {
        Some((_, after)) => after,
        None => statement.strip_prefix("import").unwrap_or(statement),
    };
    quoted(after.trim_start()).is_some()
}

/// An export clause is complete once its braces close — and, where it re-exports,
/// once the module it re-exports from is closed off too.
fn complete_export_clause(statement: &str) -> bool {
    let Some((_, after)) = statement.split_once('}') else {
        return false;
    };
    !after.trim_start().starts_with("from") || complete_import(statement)
}

/// What an import brings into scope.
enum Binding {
    /// `import "./x.js";` — evaluated for its effect and nothing else.
    None,
    /// `import * as ns from "./x.js";`
    Namespace(String),
    /// Everything else, as a destructuring list.
    Named(String),
}

/// The specifier an import names, and what it binds.
fn parse_import(id: &str, statement: &str) -> Result<(String, Binding)> {
    let refuse = || anyhow::anyhow!("{id}: cannot read this import: {statement}");
    let rest = statement.strip_prefix("import").ok_or_else(refuse)?.trim();

    // `import "./x.js";`
    if rest.starts_with('"') || rest.starts_with('\'') {
        return Ok((quoted(rest).ok_or_else(refuse)?, Binding::None));
    }
    let (clause, tail) = rest.split_once(" from ").ok_or_else(refuse)?;
    let spec = quoted(tail.trim()).ok_or_else(refuse)?;
    let clause = clause.trim();

    // `import * as ns from "./x.js";`
    if let Some(name) = clause.strip_prefix('*') {
        let name = name.trim().strip_prefix("as ").ok_or_else(refuse)?.trim();
        anyhow::ensure!(
            is_identifier(name),
            "{id}: cannot read this import: {statement}"
        );
        return Ok((spec, Binding::Namespace(name.to_string())));
    }

    // A named list, a default binding, or a default followed by a list. The
    // braces are asked about first, because the commas inside them are not the
    // comma that separates the two halves.
    let (default, named) = if clause.starts_with('{') {
        (None, Some(clause))
    } else if let Some((first, second)) = clause.split_once(',') {
        (Some(first.trim()), Some(second.trim()))
    } else {
        (Some(clause), None)
    };
    let mut parts = Vec::new();
    if let Some(default) = default.filter(|name| !name.is_empty()) {
        anyhow::ensure!(
            is_identifier(default),
            "{id}: cannot read this import: {statement}"
        );
        parts.push(format!("default: {default}"));
    }
    if let Some(named) = named {
        let inside = named
            .trim()
            .strip_prefix('{')
            .and_then(|rest| rest.split('}').next())
            .ok_or_else(refuse)?;
        for (local, imported) in clause_names(inside).ok_or_else(refuse)? {
            // In an import the alias runs the other way round: the name in the
            // braces is the exported one.
            parts.push(if local == imported {
                local
            } else {
                format!("{local}: {imported}")
            });
        }
    }
    anyhow::ensure!(
        !parts.is_empty(),
        "{id}: an import that brings in nothing: {statement}"
    );
    Ok((spec, Binding::Named(parts.join(", "))))
}

/// Handles one `export` statement, returning where reading continues.
fn handle_export(
    id: &str,
    statement: &str,
    module: &mut Module,
    reexports: &mut usize,
    lines: &[&str],
    at: usize,
) -> Result<usize> {
    let rest = statement
        .trim()
        .strip_prefix("export")
        .unwrap_or_default()
        .trim_start();

    // `export { a, b as c } from "./x.js";` — an import and an export at once,
    // so it becomes both, through a local nobody else can name.
    if let Some((clause, tail)) = rest.split_once(" from ") {
        let inside = clause.trim().trim_start_matches('{').trim_end_matches('}');
        let spec = quoted(tail.trim())
            .with_context(|| format!("{id}: cannot read this re-export: {statement}"))?;
        let dep = module.depend(id, &spec)?;
        let names = clause_names(inside)
            .with_context(|| format!("{id}: cannot read this re-export: {statement}"))?;
        let mut binding = Vec::new();
        for (imported, exported) in names {
            *reexports += 1;
            let local = format!("__reexport{reexports}");
            binding.push(format!("{imported}: {local}"));
            module.exports.push((local, exported));
        }
        module.body.push_str(&format!(
            "const {{ {} }} = {REGISTRY}[{dep:?}];\n",
            binding.join(", ")
        ));
        return Ok(at);
    }

    // `export { a, b as c };`
    if rest.starts_with('{') {
        let inside = rest
            .trim_start_matches('{')
            .split('}')
            .next()
            .unwrap_or_default();
        let names = clause_names(inside)
            .with_context(|| format!("{id}: cannot read this export: {statement}"))?;
        module.exports.extend(names);
        return Ok(at);
    }

    // `export default …` — the one export with no name of its own.
    if let Some(after) = rest.strip_prefix("default ") {
        let name = declared_name(after);
        return match name {
            Some(name) => {
                module.exports.push((name, "default".to_string()));
                emit(module, lines, at, |line| {
                    line.replacen("export default ", "", 1)
                })
            }
            None => {
                module
                    .exports
                    .push(("__default".to_string(), "default".to_string()));
                emit(module, lines, at, |line| {
                    line.replacen("export default ", "const __default = ", 1)
                })
            }
        };
    }

    // `export const|function|class NAME …`
    if let Some(name) = declared_name(rest) {
        module.exports.push((name.clone(), name));
        return emit(module, lines, at, |line| line.replacen("export ", "", 1));
    }

    // `export let` and `export var` are the one thing this cannot carry: the
    // importer reads the binding once, so a later reassignment would never
    // reach it. Live bindings are worth keeping; a stale copy is not.
    anyhow::bail!("{id}: cannot fold this export into one file: {statement}")
}

/// Writes the statement out with `edit` applied to its first line.
///
/// The statement was gathered as one line to be read; it goes back into the
/// body as the lines it was written on, so a stack trace still points at
/// something shaped like the source.
fn emit(
    module: &mut Module,
    lines: &[&str],
    at: usize,
    edit: impl Fn(&str) -> String,
) -> Result<usize> {
    module.body.push_str(&edit(lines[at]));
    module.body.push('\n');
    Ok(at)
}

/// The name a declaration declares, if it has one.
fn declared_name(rest: &str) -> Option<String> {
    for keyword in ["async function", "function", "const", "class", "let", "var"] {
        let Some(after) = rest.strip_prefix(keyword) else {
            continue;
        };
        if keyword == "let" || keyword == "var" {
            return None;
        }
        let name: String = after
            .trim_start()
            .trim_start_matches('*')
            .trim_start()
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
            .collect();
        return (!name.is_empty()).then_some(name);
    }
    None
}

/// Takes an `export { a, b as c };` clause off a line, wherever it stands.
///
/// Which is two places: on a line of its own in hand-written code, and welded
/// to the end of the last line of a minified build. Requiring a statement
/// boundary before it and identifiers inside it is what keeps the second case
/// from matching something that only looks like one.
fn take_export_clause(line: &str) -> Option<(String, Vec<(String, String)>)> {
    let mut from = 0;
    while let Some(found) = line[from..].find("export") {
        let start = from + found;
        from = start + "export".len();
        let before = line[..start].trim_end();
        if !(before.is_empty() || before.ends_with(';') || before.ends_with('}')) {
            continue;
        }
        let after = &line[from..];
        if after.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$') {
            continue;
        }
        let Some(open) = after.find('{').filter(|at| after[..*at].trim().is_empty()) else {
            continue;
        };
        let open = from + open;
        let Some(close) = line[open..].find('}').map(|at| open + at) else {
            continue;
        };
        let Some(names) = clause_names(&line[open + 1..close]) else {
            continue;
        };
        let tail = &line[close + 1..];
        let spaces = tail.len() - tail.trim_start().len();
        if !tail.trim_start().starts_with(';') {
            continue;
        }
        let end = close + 1 + spaces + 1;
        return Some((format!("{}{}", &line[..start], &line[end..]), names));
    }
    None
}

/// The `a, b as c` inside a clause, or `None` if that is not what it holds.
fn clause_names(inside: &str) -> Option<Vec<(String, String)>> {
    let mut names = Vec::new();
    for part in inside.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (local, exported) = match part.split_once(" as ") {
            Some((local, exported)) => (local.trim(), exported.trim()),
            None => (part, part),
        };
        if !is_identifier(local) || !(is_identifier(exported) || exported == "default") {
            return None;
        }
        names.push((local.to_string(), exported.to_string()));
    }
    (!names.is_empty()).then_some(names)
}

fn is_identifier(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// The contents of a leading quoted string.
fn quoted(text: &str) -> Option<String> {
    let quote = text.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    text[1..].split(quote).next().map(str::to_string)
}

/// A relative reference, as an id relative to the same root as `from`.
fn join(from: &str, reference: &str) -> String {
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for step in reference.split('/') {
        match step {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            name => parts.push(name),
        }
    }
    parts.join("/")
}

// --------------------------------------------------------------------- HTML

/// A start tag, as far as this needs to understand one.
struct Tag {
    name: String,
    attrs: Vec<(String, String)>,
    /// The whole element, start tag to end tag, as it stands in the source.
    text: String,
}

impl Tag {
    fn attr(&self, name: &str) -> Option<String> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    }

    /// The same tag with its reference replaced by the file it pointed at.
    fn with_data_uri(&self, root: &Path, id: &str) -> Result<String> {
        let attr = if self.name == "link" { "href" } else { "src" };
        let uri = data_uri(&root.join(id))?;
        let old = format!("{attr}=\"{}\"", self.attr(attr).unwrap_or_default());
        anyhow::ensure!(
            self.text.contains(&old),
            "cannot rewrite {}, which does not quote its {attr} the usual way",
            self.text,
        );
        Ok(self.text.replacen(&old, &format!("{attr}=\"{uri}\""), 1))
    }
}

/// The tags worth following. Anything else is left exactly as written.
const FOLLOWED: [&str; 3] = ["link", "script", "img"];

/// Walks the HTML, letting `fold` replace whole elements.
///
/// This is not an HTML parser and does not need to be: it finds the start tags
/// of three element names, reads their attributes with the quoting rules, and
/// copies everything else through untouched.
fn rewrite_tags(
    html: &str,
    fold: &mut dyn FnMut(&Tag) -> Result<Option<String>>,
) -> Result<String> {
    let bytes = html.as_bytes();
    let mut out = String::new();
    let mut at = 0;
    while at < html.len() {
        let Some(found) = html[at..].find('<').map(|found| at + found) else {
            break;
        };
        out.push_str(&html[at..found]);
        at = found;

        // A comment can hold anything, including something tag-shaped.
        if html[at..].starts_with("<!--") {
            let end = html[at..]
                .find("-->")
                .map_or(html.len(), |end| at + end + 3);
            out.push_str(&html[at..end]);
            at = end;
            continue;
        }
        let name: String = html[at + 1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if !FOLLOWED.contains(&name.as_str()) {
            out.push('<');
            at += 1;
            continue;
        }
        let (attrs, after_open) = attributes(bytes, at + 1 + name.len())?;
        // A script is only itself once it has been closed; the rest are void.
        let end = if name == "script" {
            match html[after_open..].find("</script") {
                Some(close) => html[after_open + close..]
                    .find('>')
                    .map_or(html.len(), |gt| after_open + close + gt + 1),
                None => html.len(),
            }
        } else {
            after_open
        };
        let tag = Tag {
            name,
            attrs,
            text: html[at..end].to_string(),
        };
        match fold(&tag)? {
            Some(replacement) => out.push_str(&replacement),
            None => out.push_str(&tag.text),
        }
        at = end;
    }
    out.push_str(&html[at.min(html.len())..]);
    Ok(out)
}

/// Reads a start tag's attributes, returning them and where the tag ends.
fn attributes(bytes: &[u8], mut at: usize) -> Result<(Vec<(String, String)>, usize)> {
    let mut attrs = Vec::new();
    loop {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        anyhow::ensure!(at < bytes.len(), "a tag in the page is never closed");
        if bytes[at] == b'>' {
            return Ok((attrs, at + 1));
        }
        if bytes[at] == b'/' {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len()
            && !bytes[at].is_ascii_whitespace()
            && !matches!(bytes[at], b'=' | b'>' | b'/')
        {
            at += 1;
        }
        let name = String::from_utf8_lossy(&bytes[start..at]).to_ascii_lowercase();
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= bytes.len() || bytes[at] != b'=' {
            attrs.push((name, String::new()));
            continue;
        }
        at += 1;
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        anyhow::ensure!(at < bytes.len(), "a tag in the page is never closed");
        let (value, next) = match bytes[at] {
            quote @ (b'"' | b'\'') => {
                let start = at + 1;
                let end = bytes[start..]
                    .iter()
                    .position(|byte| *byte == quote)
                    .map_or(bytes.len(), |end| start + end);
                (&bytes[start..end], (end + 1).min(bytes.len()))
            }
            _ => {
                let start = at;
                let mut end = at;
                while end < bytes.len() && !bytes[end].is_ascii_whitespace() && bytes[end] != b'>' {
                    end += 1;
                }
                (&bytes[start..end], end)
            }
        };
        attrs.push((name, String::from_utf8_lossy(value).to_string()));
        at = next;
    }
}

// ------------------------------------------------------------------- files

fn read(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

/// A file as a `data:` URI, typed by its extension.
fn data_uri(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(format!("data:{};base64,{}", mime(path), base64(&bytes)))
}

/// Enough media types to cover what a page loads. Anything unrecognised is
/// bytes, which every browser will still hand to whatever asked for it.
fn mime(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Base64, so a file can be a data URI. Fifteen lines beats a dependency.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut bits = 0u32;
        for (at, byte) in chunk.iter().enumerate() {
            bits |= u32::from(*byte) << (16 - 8 * at);
        }
        for at in 0..=chunk.len() {
            out.push(char::from(
                ALPHABET[(bits >> (18 - 6 * at)) as usize & 0x3f],
            ));
        }
        for _ in chunk.len()..3 {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The body a module was folded down to, for the assertions below.
    fn folded(source: &str) -> String {
        rewrite_module("src/a.js", source)
            .expect("rewrites")
            .render("src/a.js")
    }

    #[test]
    fn named_imports_become_a_lookup() {
        let out = folded("import { a, b as c } from \"./b.js\";\nuse(a, c);\n");
        assert!(
            out.contains("const { a, b: c } = __modules[\"src/b.js\"];"),
            "{out}"
        );
    }

    #[test]
    fn a_wrapped_import_list_is_one_statement() {
        let out = folded("import {\n  a,\n  b,\n} from \"./b.js\";\nuse(a, b);\n");
        assert!(
            out.contains("const { a, b } = __modules[\"src/b.js\"];"),
            "{out}"
        );
        assert!(out.contains("use(a, b);"), "{out}");
    }

    #[test]
    fn default_and_namespace_imports_are_carried() {
        let out = folded("import thing from \"./b.js\";\nimport * as all from \"./c.js\";\n");
        assert!(
            out.contains("const { default: thing } = __modules[\"src/b.js\"];"),
            "{out}"
        );
        assert!(
            out.contains("const all = __modules[\"src/c.js\"];"),
            "{out}"
        );
    }

    #[test]
    fn a_side_effect_import_binds_nothing() {
        let out = folded("import \"./b.js\";\n");
        assert!(out.contains("__modules[\"src/b.js\"];"), "{out}");
        assert!(!out.contains("const"), "{out}");
    }

    #[test]
    fn declarations_keep_their_bodies() {
        let out = folded("export function f(x) {\n  return x;\n}\nexport const K = 1;\n");
        assert!(out.contains("function f(x) {\n  return x;\n}"), "{out}");
        assert!(out.contains("const K = 1;"), "{out}");
        assert!(out.contains("return { f, K };"), "{out}");
        assert!(!out.contains("export"), "{out}");
    }

    #[test]
    fn a_clause_exports_without_declaring() {
        let out = folded("const a = 1;\nconst b = 2;\nexport { a, b as c };\n");
        assert!(out.contains("return { a, c: b };"), "{out}");
    }

    #[test]
    fn a_re_export_is_an_import_and_an_export_at_once() {
        let module =
            rewrite_module("src/a.js", "export { a as b } from \"./c.js\";\n").expect("rewrites");
        assert_eq!(module.deps, ["src/c.js"]);
        let out = module.render("src/a.js");
        assert!(
            out.contains("const { a: __reexport1 } = __modules[\"src/c.js\"];"),
            "{out}"
        );
        assert!(out.contains("return { b: __reexport1 };"), "{out}");
    }

    #[test]
    fn a_default_export_gets_a_name() {
        let named = folded("export default function f() {}\n");
        assert!(named.contains("return { default: f };"), "{named}");
        let anonymous = folded("export default { a: 1 };\n");
        assert!(
            anonymous.contains("const __default = { a: 1 };"),
            "{anonymous}"
        );
        assert!(
            anonymous.contains("return { default: __default };"),
            "{anonymous}"
        );
    }

    /// How a minified build writes its exports: no line of their own, welded to
    /// the end of the last statement in the file.
    #[test]
    fn a_trailing_clause_is_found_mid_line() {
        let out = folded("var q=1;function w(){}export{q as Q,w as W};\n");
        assert!(out.contains("var q=1;function w(){}"), "{out}");
        assert!(out.contains("return { Q: q, W: w };"), "{out}");
    }

    #[test]
    fn a_word_beginning_with_export_is_not_one() {
        let out = folded("const x = { exportControl: () => ({ a: 1 }) };\n");
        assert!(out.contains("exportControl"), "{out}");
        assert!(out.contains("return {  };"), "{out}");
    }

    #[test]
    fn a_reassignable_export_is_refused() {
        let error = rewrite_module("src/a.js", "export let n = 1;\n").expect_err("refuses");
        assert!(error.to_string().contains("export let n = 1;"), "{error}");
    }

    #[test]
    fn a_bare_specifier_is_refused() {
        let error =
            rewrite_module("src/a.js", "import { a } from \"lodash\";\n").expect_err("refuses");
        assert!(error.to_string().contains("package manager"), "{error}");
    }

    #[test]
    fn relative_paths_resolve_against_the_importer() {
        assert_eq!(join("src/panels/x.js", "../model.js"), "src/model.js");
        assert_eq!(join("src/x.js", "./panels/y.js"), "src/panels/y.js");
        assert_eq!(join("index.html", "src/main.js"), "src/main.js");
    }

    #[test]
    fn attributes_are_read_with_their_quoting() {
        let tags = std::cell::RefCell::new(Vec::new());
        let html = "<!-- <link href=\"skip.css\"> --><link rel=stylesheet href='a.css'/><p>x</p>\
                    <script type=\"module\" src=\"m.js\"></script>";
        let out = rewrite_tags(html, &mut |tag| {
            tags.borrow_mut()
                .push((tag.name.clone(), tag.attr("href"), tag.attr("src")));
            Ok(None)
        })
        .expect("walks");
        assert_eq!(out, html, "an untouched walk copies the page through");
        let seen = tags.borrow();
        assert_eq!(
            seen.len(),
            2,
            "the tag in the comment is not a tag: {seen:?}"
        );
        assert_eq!(seen[0].1.as_deref(), Some("a.css"));
        assert_eq!(seen[1].2.as_deref(), Some("m.js"));
    }

    #[test]
    fn a_script_element_is_replaced_whole() {
        let out = rewrite_tags("<script src=\"a.js\">ignored</script>!", &mut |_| {
            Ok(Some("<script>x</script>".to_string()))
        })
        .expect("walks");
        assert_eq!(out, "<script>x</script>!");
    }

    #[test]
    fn base64_matches_the_worked_examples() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    /// The one test that reads the real viewer: whatever it is made of now, it
    /// has to come out as one page with nothing left to load.
    #[test]
    fn the_viewer_folds_into_one_page() {
        let ui = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ui");
        let page = page(&ui.join("index.html")).expect("folds");
        assert!(page.modules > 1, "only {} modules", page.modules);
        for tag in ["src=\"src/", "href=\"src/", "href=\"favicon"] {
            assert!(
                !page.html.contains(tag),
                "{tag} is still loaded from outside the page"
            );
        }
        assert!(
            page.html.contains("<style>"),
            "the stylesheet is not in the page"
        );
        assert!(
            page.html.contains("data:image/svg+xml;base64,"),
            "the icon is not in the page"
        );
    }
}

// Doc comments, rendered.
//
// Rust doc comments are markdown, and the model carries them exactly as they
// were written — deciding what they look like is this half's job. This is a
// deliberately small subset: what doc comments actually contain (paragraphs,
// `code`, fenced examples, lists, headings, links) and nothing else.
//
// It builds DOM nodes rather than an HTML string, so there is no escaping to
// get wrong: text arrives as text, and a doc comment full of angle brackets
// is a doc comment full of angle brackets rather than markup.

import { h } from "./dom.js";

/** Fenced code, in either spelling. */
const FENCE = /^\s*(```|~~~)(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/**
 * `**bold**`, `*italic*`, `` `code` ``, `[text](url)`, and rustdoc's bare
 * `[Item]` links. Code is first so that backticks win over everything inside
 * them, which is what makes `` `Vec<*mut T>` `` come out intact.
 *
 * Built fresh per call rather than kept as a constant: a link label is walked
 * by recursing into `inline`, and one shared `/g` regex would have the nested
 * walk reset `lastIndex` out from under the outer one — which does not
 * misformat anything, it loops forever.
 */
function inlinePattern() {
  return /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^\s*][\s\S]*?)\*|\[([^\]]+)\]\(([^)\s]+)\)|\[([^\]]+)\]/g;
}

/** Only schemes a doc link plausibly means; anything else renders as text. */
function safeHref(url) {
  return /^(https?:|mailto:|#)/i.test(url) ? url : null;
}

/**
 * @param {string} text
 * @param {Node} parent
 */
function inline(text, parent) {
  let last = 0;
  const pattern = inlinePattern();
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const [, , code, bold, boldAlt, italic, linkText, linkUrl, itemLink] = match;
    if (code !== undefined) {
      parent.append(h("code", {}, code.trim()));
    } else if (bold !== undefined || boldAlt !== undefined) {
      parent.append(h("strong", {}, bold ?? boldAlt));
    } else if (italic !== undefined) {
      parent.append(h("em", {}, italic));
    } else if (linkText !== undefined) {
      const href = safeHref(linkUrl);
      const anchor = href
        ? h("a", { href, target: "_blank", rel: "noreferrer" })
        : h("span", {});
      inline(linkText, anchor);
      parent.append(anchor);
    } else if (itemLink !== undefined) {
      // `[Config]` and `[`Config`]` are rustdoc links to another item. There
      // is nothing to link to here, so the brackets simply go away.
      inline(itemLink, parent);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/**
 * A rustdoc example hides setup lines behind a leading `#`, and shows a
 * literal one written as `##`. What the reader wanted to see is what is left.
 * @param {string[]} lines
 */
function visibleCode(lines) {
  return lines
    .filter((line) => !/^\s*#($|\s)/.test(line))
    .map((line) => line.replace(/^(\s*)##/, "$1#"))
    .join("\n");
}

/**
 * @param {string} markdown
 * @returns {DocumentFragment}
 */
export function renderMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = markdown.split("\n");
  /** @type {{ tag: "ul"|"ol", element: HTMLElement }|null} */
  let list = null;
  /** @type {string[]} */
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const element = h("p", {});
    inline(paragraph.join(" "), element);
    fragment.append(element);
    paragraph = [];
  };
  const flush = () => {
    flushParagraph();
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      // The word after the fence is the language, and for Rust it is often a
      // doctest directive (`ignore`, `no_run`) rather than a language at all.
      fragment.append(h("pre", {}, h("code", {}, visibleCode(body))));
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      fragment.append(h("hr", {}));
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flush();
      // Doc headings sit inside a panel that already has one, so they start
      // small rather than at h1.
      const level = Math.min(heading[1].length + 3, 6);
      const element = h(/** @type {"h4"} */ (`h${level}`), {});
      inline(heading[2], element);
      fragment.append(element);
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote) {
      flush();
      const element = h("blockquote", {});
      inline(quote[1], element);
      fragment.append(element);
      continue;
    }

    // Four spaces is code too, which is how older doc comments write examples.
    if (/^ {4}\S/.test(line) && paragraph.length === 0 && !list) {
      const body = [];
      for (; i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === ""); i++) {
        body.push(lines[i].slice(4));
      }
      i--;
      while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
      fragment.append(h("pre", {}, h("code", {}, visibleCode(body))));
      continue;
    }

    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        list = { tag, element: h(tag, {}) };
        fragment.append(list.element);
      }
      const item = h("li", {});
      inline((bullet ?? numbered)[1], item);
      list.element.append(item);
      continue;
    }

    if (list) {
      // A wrapped list item, indented under the bullet it belongs to.
      inline(" " + line.trim(), list.element.lastElementChild ?? list.element);
      continue;
    }
    paragraph.push(line.trim());
  }

  flush();
  return fragment;
}

/**
 * The first sentence, for places that have room for a line and not a page.
 * @param {string} markdown
 */
export function summarize(markdown) {
  const firstBlock = markdown.split(/\n\s*\n/)[0].replace(/\n/g, " ").trim();
  const stop = firstBlock.match(/[.!?](\s|$)/);
  return stop ? firstBlock.slice(0, stop.index + 1) : firstBlock;
}

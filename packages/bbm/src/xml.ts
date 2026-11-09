// Minimal XML emission helpers tuned for the .bbm format.
//
// We hand-roll this rather than reusing fast-xml-parser's builder because
// we need exact byte-level control: 2-space indent, CRLF line endings,
// `<Foo />` self-close (with the space), `encoding="utf-8"` lowercase, no
// trailing newline. fast-xml-parser's serialiser doesn't promise any of
// those.

/**
 * Escape text content. .NET's XmlSerializer emits the bare minimum:
 *   - `&` → `&amp;`
 *   - `<` → `&lt;`
 *   - `>` → `&gt;` (only when in a context where `]]>` would otherwise form)
 *
 * We escape `>` unconditionally — real `.bbm` files have no `>` in text content,
 * and over-escaping is XML-equivalent. Quotes are NOT escaped in text
 * content per spec.
 */
export function escapeText(s: string): string {
  return stripInvalidXmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Characters XML 1.0 doesn't allow at all, not even as `&#x1;`: control
// characters other than tab, LF and CR, U+FFFE/U+FFFF and half a surrogate
// pair. A name or text pasted with one made a file BlueBrick and the
// desktop refuse to open (both stop at the first invalid character). As the
// desktop does (XmlPrimitives cleanText): a vertical tab or form feed, which
// are line breaks to the person who typed them, becomes a newline, and the
// others are left out.
// eslint-disable-next-line no-control-regex
const LINE_BREAK_CHARS = /[\u000B\u000C]/g;
const INVALID_XML_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripInvalidXmlChars(s: string): string {
  return s.replace(LINE_BREAK_CHARS, '\n').replace(INVALID_XML_CHARS, '');
}

/** Escape an attribute value. Adds quote escaping on top of escapeText. */
export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/**
 * Builder that accumulates XML lines and produces the final byte-faithful
 * string. Indent is 2 spaces, line endings are LF — the writer applies the
 * `vanillaPostProcess` pass at the end to switch to CRLF, fix self-close
 * spacing, and normalise the encoding declaration.
 */
export class XmlBuilder {
  private readonly lines: string[] = [];
  private depth = 0;

  prolog(): this {
    this.lines.push('<?xml version="1.0" encoding="utf-8"?>');
    return this;
  }

  /** Begin an element with optional attributes. */
  open(name: string, attrs?: Record<string, string>): this {
    this.lines.push(`${this.indent()}<${name}${this.attrs(attrs)}>`);
    this.depth++;
    return this;
  }

  /** Close the current element. */
  close(name: string): this {
    this.depth--;
    this.lines.push(`${this.indent()}</${name}>`);
    return this;
  }

  /** Self-closing element, e.g. `<Comment />` or `<Connexions count="0" />`. */
  selfClose(name: string, attrs?: Record<string, string>): this {
    this.lines.push(`${this.indent()}<${name}${this.attrs(attrs)} />`);
    return this;
  }

  /** Element with only text content, e.g. `<Version>9</Version>`. */
  textElement(name: string, text: string, attrs?: Record<string, string>): this {
    this.lines.push(
      `${this.indent()}<${name}${this.attrs(attrs)}>${escapeText(text)}</${name}>`,
    );
    return this;
  }

  /** Element that's text-only OR self-closing depending on whether the text is empty. */
  optionalTextElement(name: string, text: string): this {
    return text.length === 0 ? this.selfClose(name) : this.textElement(name, text);
  }

  build(): string {
    return this.lines.join('\n');
  }

  private indent(): string {
    return '  '.repeat(this.depth);
  }

  private attrs(attrs?: Record<string, string>): string {
    if (!attrs) return '';
    let out = '';
    for (const [k, v] of Object.entries(attrs)) {
      out += ` ${k}="${escapeAttr(v)}"`;
    }
    return out;
  }
}

/**
 * Apply the byte-faithful transforms the desktop's BbmWriter does
 * post-emission to make Qt's QXmlStreamWriter output match .NET XmlSerializer.
 *
 *   1. `<Foo></Foo>` → `<Foo />`         (collapse empty pairs)
 *   2. `<Foo/>` → `<Foo />`              (add space before self-close)
 *   3. `encoding="UTF-8"` → `encoding="utf-8"` (case)
 *   4. LF → CRLF
 *   5. Strip any trailing newline
 *
 * Our XmlBuilder never emits `<Foo></Foo>` or `<Foo/>` directly, so steps
 * 1 and 2 are no-ops in practice — kept so this function matches what
 * the desktop does and so a hand-edit upstream can't sneak in a bad
 * pattern.
 */
export function vanillaPostProcess(xml: string): string {
  let out = xml;
  out = out.replace(/<([A-Za-z][^<>\s/]{0,64})([^<>]{0,4096})><\/\1>/g, '<$1$2 />');
  out = out.replace(/<([A-Za-z][^<>\s/]*)([^<>]*?)\/>/g, (_m, name: string, rest: string) => {
    const trimmed = rest.replace(/\s+$/, '');
    return `<${name}${trimmed} />`;
  });
  out = out.replace(/encoding="UTF-8"/, 'encoding="utf-8"');
  out = out.replace(/\r?\n/g, '\r\n');
  out = out.replace(/[\r\n]+$/, '');
  return out;
}

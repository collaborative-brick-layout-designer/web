// A small, strict-enough XML start/end tag scanner for LDD's files (LXFML,
// ldraw.xml, Materials.xml): the elements in document order with their
// attributes, as the desktop's QXmlStreamReader loops read them. Web
// Workers have no DOMParser. Comments, processing instructions, CDATA and
// the doctype are skipped; text is ignored. Unbalanced tags are an error.

export interface XmlTag {
  name: string;
  /** Start (with its attributes), end, or a self-closed element (start and end). */
  kind: 'start' | 'end' | 'empty';
  attrs: Map<string, string>;
}

export interface XmlScan {
  tags: XmlTag[];
  error: string | null;
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const n = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function scanXml(text: string): XmlScan {
  const tags: XmlTag[] = [];
  const stack: string[] = [];
  let i = 0;
  const n = text.length;
  const fail = (why: string): XmlScan => ({ tags, error: why });
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return fail('unclosed comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return fail('unclosed CDATA');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return fail('unclosed processing instruction');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) return fail('unclosed declaration');
      i = end + 1;
      continue;
    }
    // A tag: find its end outside quoted values.
    let j = lt + 1;
    let quote = '';
    for (; j < n; j++) {
      const c = text[j]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) return fail('unclosed tag');
    const body = text.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (stack.pop() !== name) return fail(`mismatched </${name}>`);
      tags.push({ name, kind: 'end', attrs: new Map() });
      continue;
    }
    const selfClosed = body.endsWith('/');
    const inner = selfClosed ? body.slice(0, -1) : body;
    const m = /^([A-Za-z_:][\w.:-]*)/.exec(inner);
    if (!m) return fail('bad tag');
    const name = m[1]!;
    const attrs = new Map<string, string>();
    for (const a of inner.slice(name.length).matchAll(ATTR)) attrs.set(a[1]!, decode(a[2] ?? a[3] ?? ''));
    tags.push({ name, kind: selfClosed ? 'empty' : 'start', attrs });
    if (!selfClosed) stack.push(name);
  }
  if (stack.length) return fail(`unclosed <${stack[stack.length - 1]}>`);
  if (tags.length === 0) return fail('no elements');
  return { tags, error: null };
}

/** QString::toInt with the ok flag: digits with an optional sign, around whitespace. */
export function xmlInt(v: string | undefined): number | null {
  const t = (v ?? '').trim();
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null;
}

/** QString::toDouble without the flag: 0 when it isn't a number. */
export function xmlDouble(v: string | undefined): number {
  const t = (v ?? '').trim();
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : 0;
}

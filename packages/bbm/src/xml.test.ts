import { describe, expect, it } from 'vitest';
import { escapeAttr, escapeText, stripInvalidXmlChars, vanillaPostProcess, XmlBuilder } from './xml.js';

describe('escapeText / escapeAttr', () => {
  it('escapes the standard XML special chars', () => {
    expect(escapeText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapeAttr also escapes double quotes', () => {
    expect(escapeAttr('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('does not double-escape pre-encoded entities', () => {
    // We deliberately escape `&` first so an existing `&amp;` becomes
    // `&amp;amp;`. That's correct for raw input — test guards against
    // someone "fixing" it the wrong way.
    expect(escapeText('&amp;')).toBe('&amp;amp;');
  });

  it('leaves out characters XML 1.0 forbids, keeping tab, LF and CR', () => {
    // A name pasted with a control character made a .bbm that BlueBrick
    // and the desktop refuse to open (audit 2026-10-20).
    expect(escapeText('a\u0000b\u0001c\u0008d\u001Fg￾h￿')).toBe('abcdgh');
    expect(escapeText('t\tl\nc\r.')).toBe('t\tl\nc\r.');
    expect(escapeAttr('x\u0002"y')).toBe('x&quot;y');
    expect(escapeText('Zürich 駅 🚂')).toBe('Zürich 駅 🚂');
  });

  it('turns a vertical tab or form feed into a newline, as the desktop does', () => {
    // Line breaks to whoever typed them (Word's line break pastes as \v).
    expect(escapeText('one\u000Btwo\u000Cthree')).toBe('one\ntwo\nthree');
    expect(stripInvalidXmlChars('a\u000Bb')).toBe('a\nb');
  });

  it('leaves out half a surrogate pair, keeping whole ones', () => {
    expect(escapeText('x\uD83Dy\uDE82z🚂')).toBe('xyz🚂');
  });
});

describe('XmlBuilder', () => {
  it('emits a simple element tree with correct indentation', () => {
    const b = new XmlBuilder();
    b.prolog();
    b.open('Map');
    b.textElement('Version', '9');
    b.close('Map');
    expect(b.build()).toBe(
      ['<?xml version="1.0" encoding="utf-8"?>', '<Map>', '  <Version>9</Version>', '</Map>'].join(
        '\n',
      ),
    );
  });

  it('self-closes empty optional text elements', () => {
    const b = new XmlBuilder();
    b.optionalTextElement('Comment', '');
    expect(b.build()).toBe('<Comment />');
  });

  it('self-closes elements with attributes', () => {
    const b = new XmlBuilder();
    b.selfClose('Connexions', { count: '0' });
    expect(b.build()).toBe('<Connexions count="0" />');
  });

  it('escapes attributes', () => {
    const b = new XmlBuilder();
    b.selfClose('Foo', { bar: 'a"b' });
    expect(b.build()).toContain('bar="a&quot;b"');
  });
});

describe('vanillaPostProcess', () => {
  it('switches LF to CRLF', () => {
    const out = vanillaPostProcess('<a>\n  <b/>\n</a>');
    expect(out).toBe('<a>\r\n  <b />\r\n</a>');
  });

  it('strips a trailing newline', () => {
    expect(vanillaPostProcess('<a/>\n')).toBe('<a />');
    expect(vanillaPostProcess('<a/>\r\n\r\n')).toBe('<a />');
  });

  it('lowercases the encoding declaration', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<a/>';
    expect(vanillaPostProcess(xml)).toContain('encoding="utf-8"');
  });

  it('collapses empty pairs and pads self-close', () => {
    expect(vanillaPostProcess('<a></a>')).toBe('<a />');
    expect(vanillaPostProcess('<a/>')).toBe('<a />');
    expect(vanillaPostProcess('<a foo="x"/>')).toBe('<a foo="x" />');
  });
});

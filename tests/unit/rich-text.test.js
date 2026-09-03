import { sanitizeRichText } from '../../src/lib/rich-text.js';

describe('sanitizeRichText', () => {
  test('keeps what the editor toolbar can actually produce', () => {
    const html = '<p>Hello <strong>world</strong>, <em>welcome</em>.</p>'
      + '<h2>Agenda</h2><ul><li>One</li><li>Two</li></ul>'
      + '<ol><li>First</li><li>Second</li></ol>'
      + '<blockquote>A quote</blockquote>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  test('strips a script tag entirely, not just escapes it', () => {
    const out = sanitizeRichText('<p>Hi</p><script>alert(document.cookie)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert');
    expect(out).toContain('<p>Hi</p>');
  });

  test('strips an inline event handler attribute', () => {
    const out = sanitizeRichText('<p onmouseover="alert(1)">Hover me</p>');
    expect(out).not.toContain('onmouseover');
    expect(out).not.toContain('alert');
  });

  test('strips a javascript: link href, but keeps a real one', () => {
    const dangerous = sanitizeRichText('<p><a href="javascript:alert(1)">Click</a></p>');
    expect(dangerous).not.toContain('javascript:');

    const safe = sanitizeRichText('<p><a href="https://example.com">Click</a></p>');
    expect(safe).toContain('href="https://example.com"');
    expect(safe).toContain('rel="noopener noreferrer"');
  });

  test('strips a disallowed tag like iframe or img', () => {
    const out = sanitizeRichText('<p>Before</p><iframe src="https://evil.example"></iframe><img src="x" onerror="alert(1)">');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<img');
    expect(out).toContain('<p>Before</p>');
  });

  test('drops style and class attributes, not just script-bearing ones', () => {
    const out = sanitizeRichText('<p style="color:red" class="foo">Text</p>');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('class=');
    expect(out).toContain('Text');
  });

  test('collapses an empty paragraph left behind by a cleared editor', () => {
    expect(sanitizeRichText('<p>Real content</p><p></p><p>   </p>')).toBe('<p>Real content</p>');
  });

  test('null/undefined/empty pass through unchanged', () => {
    expect(sanitizeRichText(null)).toBe(null);
    expect(sanitizeRichText(undefined)).toBe(undefined);
    expect(sanitizeRichText('')).toBe('');
  });
});

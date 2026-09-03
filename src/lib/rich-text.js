import sanitizeHtml from 'sanitize-html';

/**
 * Cleans HTML from the admin's rich text editor (event "full description")
 * before it's stored — this is the one point every save path (create,
 * update) runs through via `.transform()` in cpd.validation.js and
 * summit.validation.js, so nothing can reach the database unsanitised. It
 * still matters even though only staff can write it: the value is rendered
 * on the public event page with `dangerouslySetInnerHTML`, so a compromised
 * or careless staff account pasting a `<script>` tag would otherwise run in
 * every visitor's browser, not just the admin's.
 *
 * The allowlist is exactly what the editor's toolbar can produce — nothing
 * more. Anything else (scripts, iframes, style/class/on* attributes, data:
 * URLs) is stripped rather than escaped, so the output is always safe to
 * render raw.
 *
 * `package.json` pins `sanitize-html`'s own `htmlparser2` dependency to
 * 9.1.x via `overrides` — 10+ ships ESM-only, which Jest 29's
 * `--experimental-vm-modules` runner can't `require()` through
 * `sanitize-html`'s CJS entry point (plain Node 22 handles it fine; Jest's
 * module system doesn't). 9.1.x's parsing API is what `sanitize-html`
 * actually calls, so this is a version pin, not a behavioural change.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em',
  'h2', 'h3', 'h4',
  'ul', 'ol', 'li',
  'blockquote', 'a',
];

export function sanitizeRichText(html) {
  if (!html) return html;
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    // rel/target aren't something the editor sets — they're added by
    // transformTags below, but still have to be allow-listed or the
    // attribute filter strips them right back off after the transform runs.
    allowedAttributes: { a: ['href', 'rel', 'target'] },
    // http(s)/mailto only — blocks javascript: and data: URLs in link hrefs.
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
    // Empty paragraphs (`<p></p>`, common while a TipTap editor is being
    // cleared) collapse to nothing rather than being kept as blank space.
    exclusiveFilter: (frame) => frame.tag === 'p' && !frame.text.trim() && !frame.mediaChildren?.length,
  }).trim();
}

export default { sanitizeRichText };

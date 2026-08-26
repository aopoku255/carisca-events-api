import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Fonts and background art the certificate needs, embedded rather than
 * fetched.
 *
 * The renderer is a standalone HTML string handed to Puppeteer via
 * `setContent()` — there is no server backing it to resolve a relative
 * image path or an external @font-face URL against, and this API's hosting
 * has already proven fragile around outbound network calls (see the
 * cPanel deployment notes). Reading these once at import time and inlining
 * them as data URIs means the certificate renders identically wherever
 * Chromium runs it, with nothing to fail at request time.
 *
 * `cert-background.jpg` is CARISCA's own certificate artwork (logos,
 * signatures, banner, everything that doesn't change per participant) —
 * see the design notes in `certificate.template.js` for how the dynamic
 * text is composited onto it.
 *
 * `poppins-*.woff2` and `baloo2-800.woff2` are Poppins (Indian Type
 * Foundry) and Baloo 2 (Ek Type), both SIL Open Font License — free to
 * embed and redistribute. They render the dynamic text laid over the
 * artwork: Poppins for the intro/body copy, Baloo 2 (extra-bold) for the
 * recipient's name — the closest free match by letterform to the
 * artwork's own two type roles, not a confirmed font-name match (nothing
 * in the source file names the fonts CSS could read).
 */

const ASSETS_DIR = path.dirname(fileURLToPath(import.meta.url));

function base64(filename) {
  return readFileSync(path.join(ASSETS_DIR, 'assets', filename)).toString('base64');
}

export const CERT_BACKGROUND = base64('cert-background.jpg');
export const POPPINS_LIGHT = base64('poppins-300.woff2');
export const POPPINS_BOLD = base64('poppins-700.woff2');
export const BALOO_EXTRABOLD = base64('baloo2-800.woff2');

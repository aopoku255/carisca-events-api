import {
  CERT_BACKGROUND, POPPINS_LIGHT, POPPINS_BOLD, BALOO_EXTRABOLD,
} from './assets.js';

const escape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BLUE = '#0F66DB';
const INK = '#3B3B3B';

// A4 landscape at 96dpi. Fixed rather than responsive: this is rendered
// once, by Puppeteer, never by a browser window someone can resize.
export const WIDTH = 1600;
export const HEIGHT = 1132;

/**
 * CARISCA's own certificate artwork (`cert-background.jpg`) as a full-bleed
 * background, with the per-participant text composited on top — everything
 * that never changes (the banner, logos, both signatures, the CARISCA/
 * Certificate wordmarks, every corner decoration) is real pixels from
 * CARISCA's design, not a CSS reconstruction of it.
 *
 * The tricky part is that the artwork itself has sample text baked into the
 * exact spot the real text needs to go — it's a flattened image, not a
 * template with blank fields. `.whiteout` covers that region with a plain
 * white rectangle sized and positioned to match the artwork's own left
 * panel precisely (measured directly against the source file, not
 * eyeballed), and `.overlay` draws the real intro/name/paragraph back on
 * top of it. The white rectangle stops well short of the top-left corner
 * decoration and the signature block below, so both keep showing through
 * from the artwork untouched.
 *
 * Font choice for the overlay is the same reasoning as before: Baloo 2
 * extra-bold for the name and Poppins for the rest are the closest free
 * match by letterform to the artwork's own two type roles, since nothing
 * in the source file names its fonts.
 *
 * The QR code sits in the one part of the artwork that was never occupied
 * by anything: the strip of white to the right of the blue banner, below
 * where the gold ribbon ends and above the bottom-right corner decoration
 * — measured against the source file the same way the `.whiteout` region
 * was, so it holds regardless of how the banner's own shape was produced.
 */
export function renderCertificateHtml({
  participantName, eventTitle, dateLabel, venue, verificationCode, qrDataUrl,
}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: 'Poppins';
    font-weight: 300;
    src: url(data:font/woff2;base64,${POPPINS_LIGHT}) format('woff2');
    font-display: block;
  }
  @font-face {
    font-family: 'Poppins';
    font-weight: 700;
    src: url(data:font/woff2;base64,${POPPINS_BOLD}) format('woff2');
    font-display: block;
  }
  @font-face {
    font-family: 'Name';
    font-weight: 800;
    src: url(data:font/woff2;base64,${BALOO_EXTRABOLD}) format('woff2');
    font-display: block;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    font-family: 'Poppins', sans-serif;
    font-weight: 300;
    color: ${INK};
    overflow: hidden;
  }
  .sheet { position: relative; width: 100%; height: 100%; }
  .bg {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; display: block;
  }
  .whiteout {
    position: absolute; left: 0; top: 195px;
    width: 50.8%; height: 695px;
    background: #fff;
  }
  .overlay {
    position: absolute; left: 84px; top: 195px;
    width: calc(50.8% - 168px);
  }
  .intro { font-size: 32px; font-weight: 300; color: ${INK}; }
  .name {
    font-family: 'Name', sans-serif;
    font-weight: 800;
    font-size: 74px;
    color: ${BLUE};
    line-height: 1.08;
    margin-top: 14px;
    padding-bottom: 10px;
    border-bottom: 4px solid ${BLUE};
    display: inline-block;
    max-width: 100%;
  }
  .body-text {
    font-size: 27px;
    font-weight: 300;
    line-height: 1.55;
    color: ${INK};
    margin-top: 30px;
  }
  .body-text strong { font-weight: 700; }

  .verify {
    position: absolute; right: 34px; top: 588px; width: 150px;
    text-align: center;
  }
  .verify img { width: 128px; height: 128px; display: block; margin: 0 auto; }
  .verify .label {
    font-size: 11px; font-weight: 700; color: ${BLUE};
    letter-spacing: 0.05em; text-transform: uppercase; margin-top: 8px;
  }
  .verify .code {
    font-family: monospace; font-size: 8px; font-weight: 400; color: ${INK};
    margin-top: 3px; letter-spacing: 0; white-space: nowrap;
  }
</style></head>
<body>
  <div class="sheet">
    <img class="bg" src="data:image/jpeg;base64,${CERT_BACKGROUND}" alt="" />
    <div class="whiteout"></div>
    <div class="overlay">
      <p class="intro">This is to certify that:</p>
      <h1 class="name">${escape(participantName)}</h1>
      <p class="body-text">
        has completed a workshop on <strong>&lsquo;${escape(eventTitle)},&rsquo;</strong> organised by
        the Centre for Applied Research and Innovation in Supply Chain &ndash; Africa
        (CARISCA)${venue ? ` at ${escape(venue)}` : ''} on ${escape(dateLabel)}.
      </p>
    </div>

    <div class="verify">
      <img src="${qrDataUrl}" alt="" />
      <div class="label">Scan to verify</div>
      <div class="code">${escape(verificationCode)}</div>
    </div>
  </div>
</body></html>`;
}

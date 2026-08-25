const escape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BRAND = { blue: '#0F3B8F', navy: '#0A2961', gold: '#C9A24B', slate: '#677289' };

// A4 landscape at 96dpi. Fixed rather than responsive: this is rendered
// once, by Puppeteer, never by a browser window someone can resize.
export const WIDTH = 1600;
export const HEIGHT = 1132;

/**
 * The one certificate design CARISCA issues, parameterised per registration.
 * Every event shares it rather than admins uploading their own artwork —
 * see the code review / session notes for why: it ships today instead of
 * waiting on a template editor, and it keeps every certificate looking like
 * it came from the same institution.
 */
export function renderCertificateHtml({
  participantName, eventTitle, dateLabel, credits, accreditingBody, code,
}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    font-family: Georgia, 'Times New Roman', serif;
    color: ${BRAND.navy};
    background: #fff;
  }
  .frame {
    width: 100%; height: 100%;
    padding: 40px;
    background: #fff;
  }
  .border {
    width: 100%; height: 100%;
    border: 3px solid ${BRAND.blue};
    padding: 10px;
  }
  .inner {
    width: 100%; height: 100%;
    border: 1px solid ${BRAND.gold};
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 56px 100px;
  }
  .brand { font-size: 22px; font-weight: bold; letter-spacing: 2px; color: ${BRAND.blue}; }
  .tagline { font-size: 13px; color: ${BRAND.slate}; margin-top: 4px; letter-spacing: .5px; }
  .rule { width: 90px; height: 3px; background: ${BRAND.gold}; margin: 28px 0; }
  .title { font-size: 40px; letter-spacing: 3px; text-transform: uppercase; color: ${BRAND.navy}; }
  .subtitle { font-size: 16px; color: ${BRAND.slate}; margin-top: 18px; }
  .name { font-size: 46px; font-weight: bold; color: ${BRAND.blue}; margin: 22px 0; font-family: Georgia, serif; }
  .body-text { font-size: 18px; line-height: 1.6; max-width: 900px; color: #232B42; }
  .event { font-weight: bold; }
  .credits { font-size: 15px; color: ${BRAND.slate}; margin-top: 10px; }
  .spacer { flex: 1; }
  .footer { width: 100%; display: flex; justify-content: space-between; align-items: flex-end; }
  .sign { text-align: center; width: 260px; }
  .sign-line { border-top: 1px solid ${BRAND.slate}; padding-top: 8px; font-size: 13px; color: ${BRAND.slate}; }
  .code { font-size: 12px; color: ${BRAND.slate}; }
  .code strong { color: ${BRAND.navy}; letter-spacing: 1px; }
</style></head>
<body>
  <div class="frame"><div class="border"><div class="inner">
    <div class="brand">CARISCA</div>
    <div class="tagline">Strong Supply Chains — Strong Communities</div>
    <div class="rule"></div>
    <div class="title">Certificate of Participation</div>
    <div class="subtitle">This is to certify that</div>
    <div class="name">${escape(participantName)}</div>
    <div class="body-text">
      participated in <span class="event">${escape(eventTitle)}</span><br>
      held ${escape(dateLabel)}${accreditingBody ? `, accredited by ${escape(accreditingBody)}` : ''}.
    </div>
    ${credits ? `<div class="credits">${escape(credits)} CPD credit hour${Number(credits) === 1 ? '' : 's'} awarded</div>` : ''}
    <div class="spacer"></div>
    <div class="footer">
      <div class="sign"><div class="sign-line">Executive Director, CARISCA</div></div>
      <div class="code">Verification code<br><strong>${escape(code)}</strong></div>
      <div class="sign"><div class="sign-line">Programme Lead</div></div>
    </div>
  </div></div></div>
</body></html>`;
}

import puppeteer from 'puppeteer';
import { logger } from '../../lib/logger.js';

/**
 * One Chromium instance, reused across requests. Launching it (roughly a
 * second, a new process) on every download would make the endpoint far
 * slower than it needs to be; a page per request is cheap by comparison.
 *
 * If the browser process dies — OOM, a host killing it — the next caller
 * relaunches it rather than getting stuck forever on a dead handle.
 */
let browserPromise = null;

function launch() {
  return puppeteer.launch({
    headless: true,
    // --no-sandbox is required in most container/shared-hosting environments,
    // where the kernel namespaces Chromium's sandbox needs aren't available.
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

async function getBrowser() {
  if (!browserPromise) browserPromise = launch();
  try {
    const browser = await browserPromise;
    if (!browser.connected) throw new Error('browser disconnected');
    return browser;
  } catch (err) {
    logger.warn({ err: err.message }, 'certificate browser was dead, relaunching');
    browserPromise = launch();
    return browserPromise;
  }
}

export async function getPage() {
  const browser = await getBrowser();
  return browser.newPage();
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const promise = browserPromise;
  browserPromise = null;
  try {
    const browser = await promise;
    await browser.close();
  } catch {
    // Already gone — nothing to clean up.
  }
}

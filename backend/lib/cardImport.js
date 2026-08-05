import { extractCharacterCard } from './tavernCard.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FETCH_TIMEOUT_MS = 15000;
const MAX_CARD_BYTES = 15 * 1024 * 1024; // generous cap for an avatar-embedded card PNG

// A plain server-side fetch with no User-Agent reads as a bot to more sites
// than not (both chub.ai's and botbooru's own CDNs/hosts sit behind
// Cloudflare) — this is a normal desktop Chrome UA, not spoofing anything
// beyond what any browser-based "download this card" click would already send.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function looksLikePng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

function isChubHost(hostname) {
  return hostname === 'chub.ai' || hostname === 'www.chub.ai' || hostname === 'characterhub.org' || hostname === 'www.characterhub.org';
}

// Chub.ai's character pages are a fully client-rendered SPA — the static
// HTML carries no character data at all, and there's no documented public
// API for anonymous card retrieval. But the underlying card PNGs are also
// served directly from a plain CDN at a predictable path derived from the
// page's own {creator}/{slug}, which needs no JS execution or private API
// to reach. Confirmed against known third-party downloader tools' own
// (independently reverse-engineered) use of this same path shape — not
// verified against a live chub.ai account in this environment, so treat a
// failure here as "try pasting the card's direct PNG link instead" rather
// than a dead end.
function resolveChubCardUrl(parsedUrl) {
  const m = parsedUrl.pathname.match(/^\/characters\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return null;
  return `https://avatars.charhub.io/avatars/${m[1]}/${m[2]}/chara_card_v2.png`;
}

async function fetchBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'image/png,text/html,application/xhtml+xml,*/*' },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timed out reaching ${url}`);
    throw new Error(`Could not reach ${url}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const contentType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_CARD_BYTES) throw new Error('That file is too large to be a character card.');
  return { buffer, contentType };
}

// Best-effort discovery of a downloadable card image inside an HTML page —
// covers sites (botbooru and any other TavernCard gallery) that are
// themselves fully client-rendered pages this app has no way to execute JS
// for, but whose card PNG is still a plain linked file on that same page.
// Tries the page's own og:image meta tag first (the standard "this page is
// about this image" signal most gallery sites already set for link
// previews), then falls back to the first same-page link pointing at a
// .png file.
function discoverCardLinkInHtml(html, baseUrl) {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og) return new URL(og[1], baseUrl).toString();
  const link = html.match(/href=["']([^"']*\.png[^"']*)["']/i);
  if (link) return new URL(link[1], baseUrl).toString();
  return null;
}

// Resolves an arbitrary user-pasted URL — a chub.ai character page, a
// direct card PNG link from anywhere (including botbooru, whose own
// client-rendered pages this app can't otherwise parse), or any other page
// that links to a downloadable card image — into TavernCard-shaped data.
// This app already fully understands the TavernCard PNG format via
// tavernCard.js; the only new problem this file solves is *locating* the
// actual card bytes from whatever URL the user gives it, which mirrors what
// a manual "click download on the card, then upload the file here" round
// trip would already do via UploadZone.vue.
export async function importCardFromUrl(inputUrl) {
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported.');
  }

  const directUrl = (isChubHost(parsed.hostname) && resolveChubCardUrl(parsed)) || inputUrl;

  let { buffer, contentType } = await fetchBytes(directUrl);

  if (!looksLikePng(buffer) && /text\/html/i.test(contentType)) {
    const discovered = discoverCardLinkInHtml(buffer.toString('utf8'), directUrl);
    if (!discovered) {
      throw new Error(
        "Could not find a downloadable character card on that page. Try pasting a direct link to the card's PNG "
        + 'download instead — most card sites have a "Download" or "Export" button that gives you one.',
      );
    }
    ({ buffer, contentType } = await fetchBytes(discovered));
  }

  if (!looksLikePng(buffer)) {
    throw new Error('That URL did not resolve to a character card PNG.');
  }

  const card = extractCharacterCard(buffer);
  return { card, avatarBuffer: buffer };
}

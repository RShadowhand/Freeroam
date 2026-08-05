import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { importCardFromUrl } from '../lib/cardImport.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

// Same minimal-card-PNG builder tavernCard.test.js uses — extractCharacterCard
// only reads text chunks, so the IHDR/pixel data doesn't need to be real.
function buildCardPng(name = 'Imported One') {
  const ihdr = pngChunk('IHDR', Buffer.alloc(13));
  const base64 = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name, description: 'From a card.' } })).toString('base64');
  const charaData = Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(base64, 'latin1')]);
  const textChunk = pngChunk('tEXt', charaData);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIGNATURE, ihdr, textChunk, iend]);
}

function fakeResponse({ ok = true, status = 200, contentType = 'image/png', body }) {
  return {
    ok,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe('importCardFromUrl', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('rejects a non-URL string without ever calling fetch', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; };
    await assert.rejects(importCardFromUrl('not a url'), /doesn't look like a valid URL/);
    assert.equal(called, false);
  });

  test('rejects a non-http(s) URL', async () => {
    await assert.rejects(importCardFromUrl('ftp://example.com/card.png'), /Only http\/https URLs/);
  });

  test('a direct PNG card URL is parsed straight away', async () => {
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://example.com/card.png');
      return fakeResponse({ body: buildCardPng('Direct PNG Character') });
    };
    const { card, avatarBuffer } = await importCardFromUrl('https://example.com/card.png');
    assert.equal(card.name, 'Direct PNG Character');
    assert.ok(Buffer.isBuffer(avatarBuffer));
  });

  test('a chub.ai character page URL resolves to the avatars.charhub.io card CDN, not the page itself', async () => {
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(url);
      return fakeResponse({ body: buildCardPng('Chub Character') });
    };
    const { card } = await importCardFromUrl('https://chub.ai/characters/some-creator/some-slug');
    assert.deepEqual(requested, ['https://avatars.charhub.io/avatars/some-creator/some-slug/chara_card_v2.png']);
    assert.equal(card.name, 'Chub Character');
  });

  test('a chub.ai URL with a trailing slash still resolves', async () => {
    const requested = [];
    globalThis.fetch = async (url) => { requested.push(url); return fakeResponse({ body: buildCardPng() }); };
    await importCardFromUrl('https://www.chub.ai/characters/creator-two/slug-two/');
    assert.deepEqual(requested, ['https://avatars.charhub.io/avatars/creator-two/slug-two/chara_card_v2.png']);
  });

  test('a chub.ai URL that does not match the /characters/:creator/:slug shape falls through unresolved', async () => {
    const requested = [];
    globalThis.fetch = async (url) => { requested.push(url); return fakeResponse({ body: buildCardPng() }); };
    await importCardFromUrl('https://chub.ai/characters/only-one-segment');
    assert.deepEqual(requested, ['https://chub.ai/characters/only-one-segment']);
  });

  test('an HTML page is scanned for an og:image card link', async () => {
    const html = `<html><head><meta property="og:image" content="https://cdn.example.com/cards/found.png"></head></html>`;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url === 'https://gallery.example.com/character/42') {
        return fakeResponse({ contentType: 'text/html', body: Buffer.from(html, 'utf8') });
      }
      assert.equal(url, 'https://cdn.example.com/cards/found.png');
      return fakeResponse({ body: buildCardPng('Discovered Via og:image') });
    };
    const { card } = await importCardFromUrl('https://gallery.example.com/character/42');
    assert.equal(card.name, 'Discovered Via og:image');
    assert.deepEqual(calls, ['https://gallery.example.com/character/42', 'https://cdn.example.com/cards/found.png']);
  });

  test('an HTML page with no og:image falls back to the first .png link on the page', async () => {
    const html = `<html><body><a href="/downloads/card-export.png?v=2">Download</a></body></html>`;
    globalThis.fetch = async (url) => {
      if (url === 'https://gallery.example.com/character/7') {
        return fakeResponse({ contentType: 'text/html', body: Buffer.from(html, 'utf8') });
      }
      assert.equal(url, 'https://gallery.example.com/downloads/card-export.png?v=2');
      return fakeResponse({ body: buildCardPng('Discovered Via Link') });
    };
    const { card } = await importCardFromUrl('https://gallery.example.com/character/7');
    assert.equal(card.name, 'Discovered Via Link');
  });

  test('an HTML page with no discoverable card link raises a clear, actionable error', async () => {
    globalThis.fetch = async () => fakeResponse({ contentType: 'text/html', body: Buffer.from('<html><body>Nothing here.</body></html>', 'utf8') });
    await assert.rejects(importCardFromUrl('https://gallery.example.com/character/9'), /Could not find a downloadable character card/);
  });

  test('a non-PNG, non-HTML response is rejected', async () => {
    globalThis.fetch = async () => fakeResponse({ contentType: 'application/json', body: Buffer.from('{"not":"a card"}', 'utf8') });
    await assert.rejects(importCardFromUrl('https://example.com/card.json'), /did not resolve to a character card PNG/);
  });

  test('a non-2xx response is surfaced as an error, not silently swallowed', async () => {
    globalThis.fetch = async () => fakeResponse({ ok: false, status: 404, body: Buffer.alloc(0) });
    await assert.rejects(importCardFromUrl('https://example.com/missing.png'), /Fetch failed \(404\)/);
  });

  test('an oversized response is rejected before card parsing', async () => {
    const huge = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(16 * 1024 * 1024)]);
    globalThis.fetch = async () => fakeResponse({ body: huge });
    await assert.rejects(importCardFromUrl('https://example.com/huge.png'), /too large/);
  });

  test('an aborted fetch (as a real timeout would produce) surfaces as a clear timeout error', async () => {
    globalThis.fetch = async () => { throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }); };
    await assert.rejects(importCardFromUrl('https://example.com/slow.png'), /Timed out reaching/);
  });
});

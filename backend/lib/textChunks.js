// Splits long text into smaller, topically-focused pieces before
// embedding. A sentence-embedding model pools over its whole input, so a
// long block covering several unrelated details ends up as a vector that
// faintly resembles all of them and strongly resembles none — a query for
// one short, specific fact (an exact phrase, an exact age) can then rank
// below content that just happens to repeat a common word. Splitting into
// chunks and scoring each independently keeps a short salient detail from
// getting averaged away. Shared by memoryStore.js (long recorded rounds)
// and characterEmbeddings.js (character descriptions/personalities).

export const CHUNK_TARGET_CHARS = 400; // small enough that pooling stays focused on roughly one topic
// Hard cap on chunks per piece of text — not just a soft target: callers
// size downstream work (KNN fetch width, how many chunk vectors to
// compare) off this constant, so keep any change in sync with that math.
export const MAX_CHUNKS_PER_TEXT = 6;

// Splits text into sentence-ish pieces (first on blank lines/paragraph
// breaks, then on sentence terminators within each), then greedily merges
// them back up to CHUNK_TARGET_CHARS so short sentences don't each become
// their own tiny, noisy chunk. Imperfect sentence detection is fine here —
// it's a heuristic for keeping chunks topically focused, not a linguistic
// requirement, and merge-back smooths over most mis-splits anyway.
export function chunkText(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const sentences = trimmed
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [];

  const chunks = [];
  let buf = '';
  for (const sentence of sentences) {
    if (!buf) { buf = sentence; continue; }
    if (buf.length + 1 + sentence.length <= CHUNK_TARGET_CHARS) {
      buf += ' ' + sentence;
    } else {
      chunks.push(buf);
      buf = sentence;
    }
  }
  if (buf) chunks.push(buf);

  if (chunks.length <= MAX_CHUNKS_PER_TEXT) return chunks;
  const head = chunks.slice(0, MAX_CHUNKS_PER_TEXT - 1);
  const tail = chunks.slice(MAX_CHUNKS_PER_TEXT - 1).join(' ');
  return [...head, tail];
}

import { pipeline, env } from '@huggingface/transformers';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local-first embeddings: runs entirely in-process via ONNX Runtime, no
// external API call (and no OpenRouter dependency) per embedding. The
// model is fetched from the Hugging Face hub once and cached here
// afterward — "local-first" means no per-request network call, not
// zero-network-ever; the first embed() call after a fresh install needs
// internet to populate the cache.
//
// Changing MODEL_ID makes new embeddings incompatible with ones already
// stored in the DB (different model = different vector space, even at the
// same dimension) — server.js tracks which model existing rows were built
// with and exposes a "rebuild embeddings" settings action rather than
// silently re-embedding everything on startup.
env.cacheDir = path.join(__dirname, '..', '.cache', 'transformers');

export const MODEL_ID = 'Xenova/bge-small-en-v1.5'; // 384-dim sentence embeddings, small enough to run on CPU

let pipelinePromise = null;

// Lazy singleton — importing this module never triggers a model
// download/load; only the first embed() call does.
function getExtractor() {
  if (!pipelinePromise) {
    pipelinePromise = pipeline('feature-extraction', MODEL_ID);
  }
  return pipelinePromise;
}

export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

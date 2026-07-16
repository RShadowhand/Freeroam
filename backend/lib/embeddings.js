import { pipeline, env } from '@huggingface/transformers';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local-first embeddings: runs entirely in-process via ONNX Runtime, no
// external API call (and no OpenRouter dependency) per embedding. The
// ~90MB model is fetched from the Hugging Face hub once and cached here
// afterward — "local-first" means no per-request network call, not
// zero-network-ever; the first embed() call after a fresh install needs
// internet to populate the cache.
env.cacheDir = path.join(__dirname, '..', '.cache', 'transformers');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'; // 384-dim sentence embeddings, small enough to run on CPU

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

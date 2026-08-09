import { pipeline, env } from '@huggingface/transformers';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same local-first pattern as embeddings.js: models run in-process via ONNX
// Runtime, cached here after the first (internet-requiring) download, no
// per-message network call and no dependency on the configured LLM.
env.cacheDir = path.join(__dirname, '..', '.cache', 'transformers');

const NER_MODEL_ID = 'Xenova/bert-base-NER';
// DeBERTa-v3 replaced MobileBERT-MNLI after a measured head-to-head (see
// the intent-detection research task in .kanbn): under the multi-label
// framing suggestedActions.js now uses, every MobileBERT label overlapped
// its negatives (no usable threshold existed at all), while DeBERTa
// separated the two families that matter most cleanly. q8 keeps the load
// ~242MB / load time ~13s — the fp32 variant costs 5x the load for no
// measured accuracy gain over the q8 numbers the thresholds were tuned on.
const ZERO_SHOT_MODEL_ID = 'Xenova/nli-deberta-v3-base';
const ZERO_SHOT_DTYPE = 'q8';

let nerPromise = null;
function getNer() {
  if (!nerPromise) nerPromise = pipeline('token-classification', NER_MODEL_ID);
  return nerPromise;
}

let zeroShotPromise = null;
function getZeroShot() {
  if (!zeroShotPromise) zeroShotPromise = pipeline('zero-shot-classification', ZERO_SHOT_MODEL_ID, { dtype: ZERO_SHOT_DTYPE });
  return zeroShotPromise;
}

// BIO/BILOU tag -> [prefix, bare type], e.g. "B-PER" -> ["B", "PER"]. Kept
// as loose as the library's own equivalent (falls back to "I" for anything
// that isn't a recognized X-TYPE shape) since it's mirroring that exact
// logic, not reimplementing NER tagging conventions from scratch.
function splitTag(entity) {
  const p = entity[0];
  return entity[1] === '-' && (p === 'B' || p === 'I' || p === 'E' || p === 'S')
    ? [p, entity.slice(2)]
    : ['I', entity];
}

// Groups the model's raw per-token BIO output into orthographic words using
// the "##" continuation marker — a tokenizer-level fact that's always
// complete and correct, unlike the model's own per-token predictions.
// This matters because bert-base-NER's pipeline drops "O"-tagged
// (non-entity) tokens *before* any aggregation runs (its ignore_labels
// default), and a rare/out-of-vocabulary name can have an interior
// wordpiece mistagged "O" — extractEntities asks for every token
// (ignore_labels: []) specifically so that piece is still here to group
// correctly, instead of silently vanishing and leaving the wordpieces on
// either side of the gap looking adjacent when they aren't. (That produced
// "Fffy" for "Fluffy": the pipeline had already thrown the middle piece
// away before any stitching-together code ever ran.)
function groupIntoWords(rawTokens) {
  const words = [];
  for (const tok of rawTokens) {
    let word;
    if (tok.word.startsWith('##') && words.length) {
      word = words[words.length - 1];
      word.text += tok.word.slice(2);
    } else {
      word = { text: tok.word, taggedPieces: [] };
      words.push(word);
    }
    if (tok.entity !== 'O') word.taggedPieces.push({ tag: tok.entity, score: tok.score });
  }
  return words;
}

// A word counts as an entity if any of its pieces got a real (non-"O") tag
// — the *first* tagged piece decides the type and B-/I- status (later
// pieces of the same word occasionally get mistagged, which is exactly the
// class of bug this file exists to route around), and confidence is the
// weakest of its tagged pieces.
function wordEntityInfo(word) {
  if (!word.taggedPieces.length) return null;
  const [prefix, type] = splitTag(word.taggedPieces[0].tag);
  const score = Math.min(...word.taggedPieces.map((p) => p.score));
  return { type, prefix, score };
}

// Turns the model's raw per-token BIO output into whole-word entities:
// groups wordpieces into words (see groupIntoWords), then merges
// consecutive words into one span exactly when they're the same type *and*
// the second word's tag is a continuation (I-/E-) rather than a fresh
// start (B-/S-) — the same rule the library's own 'simple' aggregation
// strategy uses (see groupEntities in the transformers.js source), just
// applied at the word level instead of the wordpiece level, so a single
// mistagged interior wordpiece can't fracture one name into disconnected
// fragments or silently swallow characters. Exported for testing —
// exercising this against the real model would mean shipping a fixture
// name that's guaranteed to trigger a particular mistagging, which is
// exactly the kind of thing that stops reproducing the moment the model
// updates.
export function aggregateEntities(rawTokens) {
  const words = groupIntoWords(rawTokens);
  const entities = [];
  for (const word of words) {
    const info = wordEntityInfo(word);
    if (!info || (info.type !== 'PER' && info.type !== 'LOC')) continue;
    const prev = entities[entities.length - 1];
    const continues = prev && prev.type === info.type && info.prefix !== 'B' && info.prefix !== 'S';
    if (continues) {
      prev.text += ' ' + word.text.trim();
      prev.score = Math.min(prev.score, info.score);
    } else {
      entities.push({ type: info.type, text: word.text.trim(), score: info.score });
    }
  }
  return entities;
}

// Named entities the model tags PER (person) or LOC (location) — the only
// two kinds suggestedActions.js's ML mode needs; ORG/MISC are dropped.
export async function extractEntities(text) {
  const ner = await getNer();
  const rawTokens = await ner(text, { ignore_labels: [], aggregation_strategy: 'none' });
  const entities = aggregateEntities(rawTokens);
  logger.debug('suggest', `NER: ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`,
    entities.map((e) => ({ type: e.type, text: e.text, score: Number(e.score?.toFixed?.(3) ?? e.score) })));
  return entities;
}

// Scores `text` against `labels` via NLI entailment (zero-shot — no
// training data needed, just the label strings themselves). multi_label
// mode on purpose: every label is scored independently (entailment vs.
// contradiction per label, sigmoid not softmax), so labels never compete —
// a strong reading of one intent can't suppress another that's also
// present, and there's no need for a "none of the above" competitor label.
// Returns [{ label, score }] covering every requested label, unsorted.
export async function classifyIntents(text, labels) {
  const classifier = await getZeroShot();
  const result = await classifier(text, labels, { multi_label: true });
  const scored = result.labels.map((label, i) => ({ label, score: result.scores[i] }));
  logger.debug('suggest', 'intent scores', scored.map((s) => ({ label: s.label, score: Number(s.score?.toFixed?.(3) ?? s.score) })));
  return scored;
}

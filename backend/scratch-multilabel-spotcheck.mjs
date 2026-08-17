// Go/no-go spot-check for the ML-instead-of-LLM intent pipeline (see the
// .kanbn research task's 2026-08-09 comment): does multi-label zero-shot
// with the reframed label set produce usable per-label score separation?
// Key differences from the failed Branch A framing:
//   - multi_label: true — every label scored independently (entailment vs.
//     contradiction per label), no softmax competition, no generic
//     "none of the above" needed. A dismissal reading structurally cannot
//     suppress a texting reading.
//   - ONE "texting" label — the now/later split (which every LLM tested
//     also fumbled) is handled by deterministic keyword rules instead.
//   - Alternate wordings tested in the same pass (independence means extra
//     labels are free apart from one forward pass each).
// Runs both models sequentially in one process: MobileBERT (current prod
// model, fast baseline) then DeBERTa-v3-base (cached since Branch A).
import { pipeline, env } from '@huggingface/transformers';
import path from 'path';

env.cacheDir = path.join(process.cwd(), '.cache', 'transformers');

const TIMES_OF_DAY = ['sunrise', 'morning', 'noon', 'afternoon', 'evening', 'sunset', 'night'];

// Keys are stable ids; existing prod label strings kept verbatim where they
// exist so results compare cleanly against Branch A's numbers.
const LABELS = {
  invite: 'invites the user to go to another place',
  introduce: 'introduces a new character by name',
  beckon: 'invites or calls someone over to join the conversation',
  stepback: 'the speaker excuses themselves or steps back from the conversation',
  stepbackAlt: 'the speaker announces that they are leaving',
  textingA: 'the speaker says they will send someone a text message',
  textingB: 'the speaker promises to text someone',
};

const EZRA_1 = `Ezra takes the card between two fingers, examining it the way he'd examine a document of uncertain provenance. He reads the number, flips it over, reads the back — blank — then sets it on the desk beside the brass pen holder, perfectly aligned with its edge.

"You're perceptive. Most people aren't." He pulls a second ledger from the cabinet, this one bound in faded red, labeled 2006-2009. "Go. I'll text you when I have something. Could be an hour, could be three. The 2003 church registry had a water damage incident that I'm still reconstructing, so if any of your mystery daughters were born that year and baptized, I'll be fighting handwriting that looks like a spider fell in ink and panicked."

He settles into his chair, uncaps the fountain pen, and opens the green ledger to the first page. Without looking up, he adds, "Three women, possibly multiple children, father's name Shad Torson. I'll find what's there to be found. If nothing turns up under your name, that doesn't mean nothing exists — just that whoever filed the paperwork used a different method. Unmarried mothers sometimes listed the father as 'unknown' by choice, not by ignorance."

His pen touches the page. He's already working, cross-referencing the index against his mental catalog of the town's family lines.

"Door sticks on the way out. Pull, don't push."`;

const EZRA_2 = `Ezra takes the card between two fingers, examines it like it's a primary source document, then tucks it into his shirt pocket. He doesn't answer immediately — instead he closes the ledger, squares it against the desk edge, and looks at Shad with something that might almost be appreciation.

"You're perceptive. That's uncommon." He pulls out the chair at his own desk, the one that doesn't wobble, and sits. "Go. I work better without someone breathing in my peripheral vision. I'll text what I find. Could be an hour, could be tomorrow — depends on how many Torsons have clogged up the registry over the years, and how much coffee I have."

He picks up his pen, already turning back to the green ledger. Then, without looking up: "Three women, potentially multiple children, and you can't remember any of their names. I'm not going to say anything about that, Shad Torson. I'm just going to write it down and let the record speak for itself."

A pause. The pen touches paper.

"Door pulls shut on its own if you let it. It sticks a little — give it a tug."`;

// `expect` lists the label KEYS that should score high; every other label
// should score low on that case. Alt wordings share their family's
// expectations. The two Ezra cases are the production regressions: texting
// must fire, stepback must NOT (the dismissal "Go." is aimed at the
// listener, the speaker stays).
const cases = [
  { id: 1, text: "I'll text my sister Elin about this later tonight, she'll want to know.", expect: ['textingA', 'textingB'] },
  { id: 2, text: 'Someone get Kestrel over here, she needs to see this.', expect: ['beckon'] },
  { id: 3, text: "Let me text you the address right now so you don't get lost.", expect: ['textingA', 'textingB'] },
  { id: 4, text: 'The market was crowded with vendors selling fruit and spices.', expect: [] },
  { id: 5, text: 'He shrugged and said nothing, turning back to his book.', expect: [] },
  { id: 6, text: "I'll send you a message tomorrow morning once I've thought it over.", expect: ['textingA', 'textingB'] },
  { id: 7, text: "Let's go down to the old pier, it's quiet this time of night.", expect: ['invite'] },
  { id: 8, text: 'You should come with me to the tavern, first round is on me.', expect: ['invite'] },
  { id: 9, text: 'This is my friend Selene, she just moved into town.', expect: ['introduce'] },
  { id: 10, text: 'You should meet Bram down there, he knows everything about the docks.', expect: ['introduce'] },
  { id: 11, text: "Corwin's been quiet all night over there — come sit with us, Corwin.", expect: ['beckon'] },
  { id: 12, text: 'Thalia, stop hovering by the door and come join the conversation.', expect: ['beckon'] },
  { id: 13, text: "I think I should get going, this isn't really my scene.", expect: ['stepback', 'stepbackAlt'] },
  { id: 14, text: "I'm going to head out now, if you'll excuse me.", expect: ['stepback', 'stepbackAlt'] },
  { id: 15, text: 'Rain drummed steadily against the tavern windows all evening.', expect: [] },
  { id: 16, text: 'She counted the coins twice before sliding them across the counter.', expect: [] },
  { id: 17, text: EZRA_1, label: 'EZRA 1 (production)', expect: ['textingA', 'textingB'] },
  { id: 18, text: EZRA_2, label: 'EZRA 2 (production)', expect: ['textingA', 'textingB'] },
];

// The deterministic now/later rules that replace the schema's when/day/
// timeOfDay LLM guesswork — demoed here against the texting-positive cases
// so the spot-check covers the whole proposed texting path, not just
// detection.
function resolveWhen(text, day, timeOfDay) {
  const t = text.toLowerCase();
  const idx = TIMES_OF_DAY.indexOf(timeOfDay);
  const step = (n) => ({ day: day + Math.floor((idx + n) / TIMES_OF_DAY.length), timeOfDay: TIMES_OF_DAY[(idx + n) % TIMES_OF_DAY.length] });
  if (/right now|immediately|this (very )?(second|minute|moment)/.test(t)) return { when: 'now' };
  if (/tomorrow/.test(t)) return { when: 'later', day: day + 1, timeOfDay: /tomorrow (morning|afternoon|evening|night)/.exec(t)?.[1] ?? 'morning' };
  if (/tonight|this evening/.test(t)) return { when: 'later', day, timeOfDay: idx < TIMES_OF_DAY.indexOf('evening') ? 'evening' : 'night' };
  if (/this afternoon/.test(t)) return { when: 'later', day, timeOfDay: 'afternoon' };
  if (/in an hour|an hour|a (few|couple( of)?) hours|later today/.test(t)) return { when: 'later', ...step(2) };
  if (/\blater\b|when i (have|find|get)|once i|what i find/.test(t)) return { when: 'later', ...step(2) };
  return { when: 'unspecified' };
}

function splitSentences(text) {
  return text
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=[.!?"])\s+(?=[A-Z"“])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

async function scoreText(classifier, text) {
  const labelStrings = Object.values(LABELS);
  const result = await classifier(text, labelStrings, { multi_label: true });
  const byString = {};
  result.labels.forEach((l, i) => { byString[l] = result.scores[i]; });
  const byKey = {};
  for (const [key, str] of Object.entries(LABELS)) byKey[key] = byString[str];
  return byKey;
}

async function evalModel(modelId, dtype) {
  console.log(`\n================ ${modelId} (dtype=${dtype ?? 'default/fp32'}) ================`);
  const t0 = performance.now();
  const classifier = await pipeline('zero-shot-classification', modelId, dtype ? { dtype } : {});
  console.log(`load: ${(performance.now() - t0).toFixed(0)}ms`);

  const rows = [];
  for (const c of cases) {
    const t1 = performance.now();
    const scores = await scoreText(classifier, c.text);
    const ms = performance.now() - t1;
    rows.push({ ...c, scores, ms });
    const desc = c.label ?? `"${c.text.slice(0, 60)}"`;
    const scoreStr = Object.entries(scores).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
    console.log(`case ${String(c.id).padStart(2)} [${c.expect.join(',') || 'none'}] ${ms.toFixed(0)}ms ${desc}`);
    console.log(`   ${scoreStr}`);
  }

  // Separation analysis: for each label, does ANY threshold separate its
  // positive cases from its negative ones?
  console.log('\n--- separation per label (min positive score vs. max negative score) ---');
  for (const key of Object.keys(LABELS)) {
    const pos = rows.filter((r) => r.expect.includes(key)).map((r) => r.scores[key]);
    const neg = rows.filter((r) => !r.expect.includes(key)).map((r) => r.scores[key]);
    if (!pos.length) continue;
    const minPos = Math.min(...pos);
    const maxNeg = Math.max(...neg);
    const sep = minPos - maxNeg;
    const worstNegCase = rows.filter((r) => !r.expect.includes(key)).sort((a, b) => b.scores[key] - a.scores[key])[0];
    console.log(`${key.padEnd(12)} minPos=${minPos.toFixed(3)} maxNeg=${maxNeg.toFixed(3)} sep=${sep >= 0 ? '+' : ''}${sep.toFixed(3)} ${sep > 0 ? `OK thr~${((minPos + maxNeg) / 2).toFixed(2)}` : `OVERLAP (worst neg: case ${worstNegCase.id})`}`);
  }

  // The production regression in focus: Ezra dismissals must not read as
  // the speaker stepping back.
  console.log('\n--- Ezra dismissal-vs-stepback focus ---');
  for (const r of rows.filter((x) => x.id >= 17)) {
    console.log(`case ${r.id}: texting A/B = ${r.scores.textingA.toFixed(2)}/${r.scores.textingB.toFixed(2)}, stepback = ${r.scores.stepback.toFixed(2)}, stepbackAlt = ${r.scores.stepbackAlt.toFixed(2)}`);
  }

  // Sentence-level pass for the long production replies — whole-text NLI
  // over ~400 tokens of mixed narration+dialogue is the hard mode; per-
  // sentence both localizes the trigger (which is also the extractive
  // `reason` for free) and keeps each premise short.
  console.log('\n--- per-sentence (Ezra cases): sentences clearing 0.70 on any label ---');
  for (const c of cases.filter((x) => x.id >= 17)) {
    console.log(`${c.label}:`);
    const sentences = splitSentences(c.text);
    const agg = Object.fromEntries(Object.keys(LABELS).map((k) => [k, 0]));
    for (const s of sentences) {
      const scores = await scoreText(classifier, s);
      for (const k of Object.keys(scores)) agg[k] = Math.max(agg[k], scores[k]);
      const hot = Object.entries(scores).filter(([, v]) => v >= 0.7).map(([k, v]) => `${k}=${v.toFixed(2)}`);
      if (hot.length) console.log(`   [${hot.join(' ')}] "${s.slice(0, 80)}"`);
    }
    console.log(`   max-per-label: ${Object.entries(agg).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')}`);
  }

  await classifier.dispose?.();
}

console.log('--- time-rule demo (deterministic now/later resolution) ---');
for (const c of cases.filter((x) => x.expect.includes('textingA'))) {
  const short = c.label ?? `"${c.text.slice(0, 55)}"`;
  console.log(`case ${c.id} ${short}\n   -> ${JSON.stringify(resolveWhen(c.text, 1, 'morning'))}`);
}

// q8 to match lib/nlp.js's production config exactly — thresholds MUST be
// calibrated on the same dtype they run under (the first calibration pass
// used fp32 and the q8 score shift broke two gates in the real pipeline).
await evalModel('Xenova/nli-deberta-v3-base', 'q8');
console.log('\nDONE');

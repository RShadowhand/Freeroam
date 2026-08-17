// End-to-end smoke of the rebuilt ml mode with the REAL models (DeBERTa-v3
// q8 zero-shot + bert-base-NER) — the unit suite covers the logic with
// fakes; this validates the whole path once against the cases that matter,
// including the production regression the LLM mode couldn't solve.
import { detectSuggestedActions } from './lib/suggestedActions.js';

// Wren included in the cast — in production backgroundCharacters is always
// a subset of charactersById, so a smoke ctx where it isn't tests a state
// the app can't produce (and made Wren look like a "new" character).
const characters = [
  { id: 'c1', name: 'Ezra Vane' },
  { id: 'c2', name: 'Mireille' },
  { id: 'c3', name: 'Wren' },
];

const EZRA_1 = `Ezra takes the card between two fingers, examining it the way he'd examine a document of uncertain provenance. He reads the number, flips it over, reads the back — blank — then sets it on the desk beside the brass pen holder, perfectly aligned with its edge.

"You're perceptive. Most people aren't." He pulls a second ledger from the cabinet, this one bound in faded red, labeled 2006-2009. "Go. I'll text you when I have something. Could be an hour, could be three. The 2003 church registry had a water damage incident that I'm still reconstructing, so if any of your mystery daughters were born that year and baptized, I'll be fighting handwriting that looks like a spider fell in ink and panicked."

He settles into his chair, uncaps the fountain pen, and opens the green ledger to the first page. Without looking up, he adds, "Three women, possibly multiple children, father's name Shad Torson. I'll find what's there to be found. If nothing turns up under your name, that doesn't mean nothing exists — just that whoever filed the paperwork used a different method. Unmarried mothers sometimes listed the father as 'unknown' by choice, not by ignorance."

His pen touches the page. He's already working, cross-referencing the index against his mental catalog of the town's family lines.

"Door sticks on the way out. Pull, don't push."`;

const EZRA_3 = `Ezra takes the card between two fingers, examining it like he's checking for watermarks. He reads the number, then reads it again, then sets it on the desk beside the ledger with the kind of precision that suggests it now occupies a specific coordinate in his mental map of the room.

"You're perceptive. That's rare. Most people sit in the wobbly chair and then complain about it as if I personally sabotaged the leg." He pulls a second ledger from the cabinet — blue this time, 2006-2009 — and stacks it beside the first. "Yes. Go. I work better without the ambient anxiety of someone hovering. I'll text what I find. If reception cooperates, you'll hear from me by this afternoon. If it doesn't, try standing near a window and praying."

He uncaps his pen, already bending over the index pages. Then, without looking up, he adds, "Three women, potentially multiple children, and you're chuckling about it. Either you're remarkably at peace with your past or you haven't fully thought through what finding these records means."

A beat. His pen scratches against paper.

"I'm not judging. That's not my function. I'm just noting it for context."`;

const runs = [
  {
    label: 'EZRA 3 (production — "by this afternoon" one sentence after the promise; must be scheduled-text afternoon)',
    text: EZRA_3,
    ctx: { characters, personaName: 'Shad', speakerId: 'c1', speakerName: 'Ezra Vane', worldDay: 1, worldTimeOfDay: 'morning' },
  },
  {
    label: 'EZRA 1 (production regression — must fire scheduled-text to persona, must NOT demote)',
    text: EZRA_1,
    ctx: { characters, personaName: 'Shad Torson', speakerId: 'c1', speakerName: 'Ezra Vane', worldDay: 1, worldTimeOfDay: 'morning' },
  },
  {
    label: 'beckon phrasing regex misses (must promote Wren)',
    text: 'She waves Wren over to the table without a word.',
    ctx: { characters, backgroundCharacters: [{ id: 'c3', name: 'Wren' }], speakerId: 'c1', speakerName: 'Ezra Vane' },
  },
  {
    label: 'speaker leaving (must demote)',
    text: "I think I should get going, this isn't really my scene.",
    ctx: { characters, speakerId: 'c1', speakerName: 'Ezra Vane' },
  },
  {
    label: 'neutral narration (must stay silent — fired stepback 0.97 on the OLD model)',
    text: 'He shrugged and said nothing, turning back to his book.',
    ctx: { characters, speakerId: 'c1', speakerName: 'Ezra Vane', backgroundCharacters: [{ id: 'c3', name: 'Wren' }] },
  },
];

for (const r of runs) {
  const t0 = performance.now();
  const hits = await detectSuggestedActions(r.text, { ...r.ctx, mode: 'ml' });
  console.log(`\n[${(performance.now() - t0).toFixed(0)}ms] ${r.label}`);
  console.log(JSON.stringify(hits, null, 2));
}
process.exit(0);

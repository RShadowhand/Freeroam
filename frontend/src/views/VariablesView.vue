<script setup>
// Documents backend/lib/context.js's macro engine (STATIC_MACROS + the two
// dynamic ones) — static copy, not fetched, since this is documentation
// text rather than data the backend needs to hand the frontend at runtime.
const VARIABLES_CATALOG = [
  { name: '{{user}}', desc: 'Your active persona\'s name.', example: 'No persona active → empty string. Persona "Kael" → Kael' },
  { name: '{{char}}', desc: 'The speaking character\'s name (or all present characters, comma-separated, in a block that lists more than one).', example: 'Ezra Vane' },
  { name: '{{persona}}', desc: 'Your active persona\'s description text.', example: 'A quiet wanderer who names stray cats.' },
  { name: '{{description}}', desc: 'The speaking character\'s Description field.', example: 'Precise, dry-witted archivist.' },
  { name: '{{personality}}', desc: 'The speaking character\'s Personality field.', example: 'Formal, quietly curious.' },
  { name: '{{scenario}}', desc: 'The current place\'s description.', example: 'A public greenhouse gone half-wild.' },
  { name: '{{world}}', desc: 'The global World Setting text (Places page).', example: 'A rain-soaked port city where the tide never fully goes out.' },
  { name: '{{time}}', desc: 'The in-world time of day (Freeroam\'s own clock — not the real-world clock).', example: 'evening' },
  { name: '{{day}}', desc: 'The in-world day number.', example: '3' },
  { name: '{{weekday}}', desc: 'The in-world day of the week, derived from the day number (Day 1 is always a Monday) — not today\'s real-world weekday.', example: 'Day 3 → Wednesday' },
  { name: '{{date}}', desc: 'Real-world wall-clock date — the one exception that reads your actual clock instead of the in-world one.', example: new Date().toLocaleDateString() },
  { name: '{{random:a,b,c}}', desc: 'Picks one of the comma-separated options at random, fresh each generation.', example: '{{random:rain,fog,clear skies}} → fog' },
  { name: '{{roll:2d6}}', desc: 'Rolls dice and inserts the sum — NdM, N optional (defaults to 1).', example: '{{roll:2d6}} → 8   ·   {{roll:d20}} → 14' },
  { name: '{{newline}}', desc: 'A literal line break — useful in single-line fields (like a block\'s name) where you can\'t just press Enter.', example: 'Line one{{newline}}Line two' },
];

// Vue's mustache tokenizer can't have literal "{{"/"}}" text inside an
// interpolation expression itself (it does simple brace-matching, not full
// JS parsing, so it reads the first "}}" it finds as the close) — kept as
// a plain variable and interpolated as a whole instead of writing the
// braces directly in the template.
const bracesExample = '{{these}}';
</script>

<template>
  <section id="view-variables" class="view">
    <div class="settings-card">
      <h2>Variables</h2>
      <p class="hint">
        Any text you write — prompt blocks, character description/personality, world setting, place descriptions,
        persona description, the <router-link to="/settings/connection">draft-persona prompt</router-link> — can use
        <code>{{ bracesExample }}</code>. Unset ones quietly become an empty string; anything not in the list below is
        left exactly as typed, unchanged.
      </p>
      <p class="hint">
        This is separate from the standard <strong>prompt blocks</strong> (World Info, Character Description, etc.)
        you insert from the dropdown on the <router-link to="/settings/prompts">Prompts</router-link> page — those decide
        <em>what's included</em> in the request; variables below just fill in text wherever you write them.
      </p>
    </div>
    <div class="settings-card">
      <div class="var-table">
        <div class="var-row" v-for="v in VARIABLES_CATALOG" :key="v.name">
          <code>{{ v.name }}</code>
          <div class="var-desc">{{ v.desc }}</div>
          <div class="var-example"><b>Example:</b> {{ v.example }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

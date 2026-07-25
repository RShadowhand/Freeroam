<script setup>
import { computed, ref } from 'vue';

// FAQ/manual content — static authored copy, same "data array + card
// rendering" pattern VariablesGuide.vue uses, not fetched or user-editable.
const MANUAL_CATEGORIES = [
  {
    id: 'getting-started',
    label: 'Getting Started',
    entries: [
      {
        q: 'What is Freeroam?',
        a: 'A roleplay app where you place characters in a world, walk between rooms, and talk to whoever\'s '
          + 'there — plus a phone for texting and calling characters who aren\'t. Characters can also proactively '
          + 'text you, remember past conversations, and track relationships with each other.',
      },
      {
        q: 'Nothing happens when I talk to a character — why?',
        a: 'You need an API key configured first. Until then you\'ll see a banner reading "No API key configured '
          + 'yet — characters will stay silent until you add one in Settings." Go to Settings → Connection, enter '
          + 'your key, and pick a model.',
      },
      {
        q: 'What model/provider should I use?',
        a: 'Any OpenRouter-compatible endpoint works — the default connection points at OpenRouter itself. Once a '
          + 'key is entered, Settings → Connection lets you filter and pick any model the endpoint serves; pricing '
          + 'shows automatically when the endpoint reports it.',
      },
      {
        q: 'What are the three main tabs at the top?',
        a: 'Freeroam (the map, chat, and phone — where you actually play), World (Places/Cast/Persona — editing '
          + 'the people and locations that exist), and Settings (connection, prompts, and this guide).',
      },
    ],
  },
  {
    id: 'worlds',
    label: 'Worlds (Save Slots)',
    entries: [
      {
        q: 'What is a "world"?',
        a: 'A world is a complete, isolated save slot — its own characters, places, chat history, memories, and '
          + 'relationships. Nothing in one world is visible from another. Manage them from the Worlds switcher '
          + '(the pinned chip in the top nav).',
      },
      {
        q: 'What\'s the difference between duplicating and exporting a world?',
        a: 'Duplicate makes an in-app copy instantly — useful for branching a variant of your current save without '
          + 'leaving the app. Export downloads a .zip file you can back up or move to a different install; Import '
          + 'reads that .zip back in as a brand-new world.',
      },
      {
        q: 'What does "Include chat history & memories" actually skip?',
        a: 'With it unchecked, the new world still gets your full cast, places, and relationships, but starts with '
          + 'a clean slate — no past conversations and no recorded memories. Good for reusing a cast/setting '
          + 'without carrying forward everything that happened to it.',
      },
      {
        q: 'Can I have characters/places in one world reference something in another?',
        a: 'No — worlds are fully isolated by design. To reuse a character or place across worlds, export it '
          + '(from the World tab) and import it into the other world.',
      },
    ],
  },
  {
    id: 'characters-personas',
    label: 'Characters & Personas',
    entries: [
      {
        q: 'What\'s the difference between a character and a persona?',
        a: 'Characters are the people the AI plays. Your persona is who you play as — set one under World → '
          + 'Persona so characters know who they\'re talking to; without one, you\'re just "the visitor."',
      },
      {
        q: 'How do I add a character?',
        a: 'Two ways: upload a character-card PNG (the same TavernCard format other roleplay tools use — drag one '
          + 'onto the Cast page), or fill in the fields manually (name, description, personality, scenario, '
          + 'example dialogue, greetings).',
      },
      {
        q: 'Why are description/personality/scenario/example dialogue kept as separate fields instead of one big text box?',
        a: 'Each becomes its own prompt block you can independently include or leave out per preset, rather than '
          + 'always sending everything whether it\'s relevant or not.',
      },
      {
        q: 'Can a persona have an avatar?',
        a: 'Yes — PNG, JPEG, or WebP, uploaded the same way as a persona\'s description when you create or edit it.',
      },
    ],
  },
  {
    id: 'places',
    label: 'Places',
    entries: [
      {
        q: 'What\'s the difference between a communal and a private place?',
        a: 'Communal places are open to anyone; private places belong to one or more residents (their owners). '
          + 'This is currently descriptive context for the scene, not an access lock — nothing stops another '
          + 'character or your persona from entering a private place.',
      },
      {
        q: 'Can a private place have more than one owner?',
        a: 'Yes — add as many residents as you like when creating or editing a place. Multiple owners\' names are '
          + 'shown together (e.g. "Ezra and Mireille\'s private place").',
      },
      {
        q: 'What is "Area" for?',
        a: 'A free-text label for loosely grouping places on the map (a neighborhood, district, or building) — '
          + 'purely organizational, with no effect on generation. New areas appear automatically the moment a '
          + 'place uses one.',
      },
      {
        q: 'How do I export just one place, or a whole area?',
        a: 'The Places page offers three export granularities: a single place, every place in one area, or every '
          + 'place in the world — all downloadable as JSON, or as a PNG card from a single place\'s own export button.',
      },
    ],
  },
  {
    id: 'chat',
    label: 'Talking to Characters',
    entries: [
      {
        q: 'Can I edit, delete, or retry a message?',
        a: 'Yes, on both your own lines and a character\'s replies — hover a message for the edit/delete controls, '
          + 'or use Retry to regenerate the last reply without resending your message.',
      },
      {
        q: 'What is the narrator?',
        a: 'An optional ambiance layer (enable it in Settings) that occasionally narrates the scene between '
          + 'character lines — useful for describing background characters or setting details that aren\'t any '
          + 'one character\'s dialogue.',
      },
      {
        q: 'Why does a character sometimes say nothing?',
        a: 'The narrator (and some reaction rolls) can deliberately stay silent rather than force a line every '
          + 'time — this is intentional, not an error.',
      },
      {
        q: 'What does "streaming" do?',
        a: 'Turn it on in Settings → Connection to see replies appear token-by-token as they generate, with an '
          + 'optional "so-and-so is typing…" indicator, instead of waiting for the whole message at once.',
      },
    ],
  },
  {
    id: 'phone',
    label: 'Texting & Calls (the Phone)',
    entries: [
      {
        q: 'What are Wavelength, TypeCast, and Party Line?',
        a: 'The three apps on the in-game phone: Wavelength is for voice calls, TypeCast is 1-on-1 texting, and '
          + 'Party Line is group texting.',
      },
      {
        q: 'How does a group text cascade work?',
        a: 'After you send a message, each participant has a chance to jump in, with the odds decaying after each '
          + 'reply so a cascade naturally tapers off rather than running forever. A "max replies in a row per '
          + 'character" setting caps how many times the same character can reply back-to-back before someone else '
          + 'has to speak.',
      },
      {
        q: 'Can characters text me first, without me starting it?',
        a: 'Yes — proactive texting is an optional, low-probability roll checked periodically per character. '
          + 'You\'ll see an unread badge on the phone when one comes in, and you can also manually nudge a '
          + 'character to send one from their contact row.',
      },
      {
        q: 'Can I rename or edit a group chat after creating it?',
        a: 'Yes — rename it and add or remove participants at any time from the group\'s info panel.',
      },
    ],
  },
  {
    id: 'memory',
    label: 'Memories & Relationships',
    entries: [
      {
        q: 'How does memory work?',
        a: 'Conversations are recorded and embedded locally (no API cost), then retrieved by semantic similarity '
          + 'to what\'s currently being discussed — so a character can recall something relevant from days ago '
          + 'without every past line being stuffed into every request.',
      },
      {
        q: 'What are relationships, separately from memories?',
        a: 'A lighter-weight, always-available layer — short labels (like "friend" or "sister") between two '
          + 'characters (or a character and your persona), used to keep who-knows-whom consistent without relying '
          + 'purely on memory recall.',
      },
      {
        q: 'What does "embeddings stale" mean, and how do I fix it?',
        a: 'It means stored memory/relationship vectors were built with a different embedding model than the one '
          + 'currently configured — recall quality degrades until you rebuild. Settings → Embeddings has a '
          + '"Rebuild embeddings" button that re-embeds everything with the current model, across every world.',
      },
      {
        q: 'Can I edit or delete an individual memory?',
        a: 'Yes, from a character\'s Memories tab — memories can be viewed, edited, or removed individually, same '
          + 'as chat messages.',
      },
    ],
  },
  {
    id: 'presets-prompts',
    label: 'Presets & Prompts',
    entries: [
      {
        q: 'What\'s a preset?',
        a: 'A named configuration of prompt blocks (system instructions, world info, character description, etc.) '
          + 'plus context-length settings — switch between presets to change how the AI is instructed without '
          + 'editing individual blocks each time.',
      },
      {
        q: 'Can I import a SillyTavern preset?',
        a: 'Yes — Settings → Prompts has an import zone that reads a SillyTavern-format preset JSON file directly, '
          + 'and export produces a file in the same format for use elsewhere.',
      },
      {
        q: 'What are those {{curly-brace}} variables for?',
        a: 'They\'re a separate mechanism from prompt blocks — placeholders like {{char}}, {{user}}, or '
          + '{{time}} that expand to live values anywhere you write text (a block\'s content, a character\'s '
          + 'description, and more). See the Variables guide above for the full list.',
      },
    ],
  },
  {
    id: 'import-export',
    label: 'Import/Export & PNG Cards',
    entries: [
      {
        q: 'What can be exported as PNG vs. JSON?',
        a: 'Characters, personas, and places can each export as either a plain JSON file or a PNG "card" — a real '
          + 'image with the data embedded invisibly inside it, the same trick TavernCard-format character cards '
          + 'use. Whole worlds only export as a .zip (too much data — chat history, avatars, memories — to fit in '
          + 'a single image).',
      },
      {
        q: 'Why would I want a PNG card instead of JSON?',
        a: 'It doubles as a normal, shareable image — you can see a preview of it, and it round-trips through '
          + 'other TavernCard-compatible tools for characters specifically. JSON is more compact and easier to '
          + 'read/diff by hand.',
      },
      {
        q: 'What happens to a private place\'s owners when I export/import it?',
        a: 'A place card carries owner *names* (for display), not the underlying character ids — ids only mean '
          + 'something inside the world that created them. Importing a place into a different world always lands '
          + 'it with no owners; re-assign them there if needed.',
      },
      {
        q: 'What if I import a card whose PNG has no real image (just a color)?',
        a: 'That\'s expected for personas without a PNG avatar and for places (which have no avatar concept at '
          + 'all) — the card still carries the full data, just embedded in a generated solid-color placeholder '
          + 'image instead of a real photo.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    entries: [
      {
        q: '"No API key configured yet" won\'t go away.',
        a: 'Enter a key in Settings → Connection and make sure it saved (the page will show the model picker '
          + 'populated once it has). The banner clears automatically once a valid key is set.',
      },
      {
        q: 'A character keeps repeating the same greeting.',
        a: 'This is usually a context issue — try Settings → Connection\'s streaming/context settings, or use '
          + 'Retry on the repeated message. If it persists in group chats specifically, check the "max replies in '
          + 'a row per character" setting under group texting.',
      },
      {
        q: 'I deleted a character — what happens to places they owned or memories that mention them?',
        a: 'They\'re automatically removed as an owner from any private place they held (other owners, if any, '
          + 'are unaffected), and their participation is cleaned up from memory/relationship records rather than '
          + 'left dangling.',
      },
      {
        q: 'My import says some owners "don\'t exist in this world and were dropped."',
        a: 'That\'s expected when importing a place whose owners were characters from a different world — see '
          + '"What happens to a private place\'s owners when I export/import it?" above.',
      },
    ],
  },
];

const query = ref('');

function matchesQuery(entry, terms) {
  const haystack = `${entry.q} ${entry.a}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

const filteredCategories = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return MANUAL_CATEGORIES.map((c) => ({ ...c, matched: false }));
  return MANUAL_CATEGORIES
    .map((c) => ({ ...c, entries: c.entries.filter((e) => matchesQuery(e, terms)), matched: true }))
    .filter((c) => c.entries.length);
});
</script>

<template>
  <div class="manual-guide">
    <div class="settings-card">
      <h2>FAQ / Manual</h2>
      <p class="hint">Answers to common questions about how Freeroam works — search below, or browse by topic.</p>
      <input type="text" v-model="query" placeholder="Search the manual (e.g. memory, private place, PNG card)...">
    </div>

    <div class="empty-note" v-if="query.trim() && !filteredCategories.length">No entries match "{{ query }}".</div>

    <div class="settings-card manual-category" v-for="c in filteredCategories" :key="c.id">
      <h3>{{ c.label }}</h3>
      <details class="manual-entry" v-for="(e, i) in c.entries" :key="i" :open="c.matched">
        <summary>{{ e.q }}</summary>
        <p>{{ e.a }}</p>
      </details>
    </div>
  </div>
</template>

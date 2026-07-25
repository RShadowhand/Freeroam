<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { getMemories, addMemory, updateMemory, deleteMemory, queryMemories } from '../../api/memory';
import ExpandableTextarea from '../shared/ExpandableTextarea.vue';

// View/add/edit/delete a character's own memory entries. Memory is scoped
// per (character, persona), so entries are tagged with which persona they
// belong to (or "No persona") and grouping is done visually via a badge
// rather than separate lists.
//
// Paginated rather than loaded all at once — a long-running roleplay can
// pile up hundreds of memories per character, and pulling all of them
// (each with a decoded row) into one response/render just to show a list
// doesn't scale. "Load more" fetches the next page on demand instead.
const props = defineProps({ characterId: { type: String, required: true } });
const emit = defineEmits(['total-change']); // lets the modal show a live count badge on its Memories tab
const world = useWorldStore();

const PAGE_SIZE = 20;

const memories = ref([]);
const total = ref(0);
const loadingMore = ref(false);
const editingId = ref(null);
const editText = ref('');
const newText = ref('');
const newPersonaId = ref('');
const addStatus = ref('');

// Debug-query state, declared up here (not down by runDebugQuery below) —
// load() calls resetDebug() and watch(..., { immediate: true }) below
// calls load() synchronously during setup, so these must already be
// initialized by the time that first call happens.
const debugQuery = ref('');
const debugResults = ref([]);
const debugBusy = ref(false);
const debugRan = ref(false);
const debugError = ref('');
const debugMinScoreUsed = ref(null);

function resetDebug() {
  debugQuery.value = '';
  debugResults.value = [];
  debugRan.value = false;
  debugError.value = '';
  debugMinScoreUsed.value = null;
}

const hasMore = computed(() => memories.value.length < total.value);
// A single watcher rather than an emit() next to every place total.value
// changes (load, add, delete, loadMore's confirmed re-count) — one source
// of truth that can't be missed if a future edit adds another mutation site.
watch(total, (t) => emit('total-change', t));

async function load() {
  editingId.value = null;
  newText.value = '';
  newPersonaId.value = '';
  addStatus.value = '';
  resetDebug();
  const { data } = await getMemories(props.characterId, { limit: PAGE_SIZE, offset: 0 });
  memories.value = data.memories || [];
  total.value = data.total || 0;
}
watch(() => props.characterId, load, { immediate: true });

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    const { data } = await getMemories(props.characterId, { limit: PAGE_SIZE, offset: memories.value.length });
    memories.value.push(...(data.memories || []));
    total.value = data.total ?? total.value;
  } finally {
    loadingMore.value = false;
  }
}

function personaLabelFor(personaId) {
  if (!personaId) return 'No persona';
  const p = world.personasList.find((x) => x.id === personaId);
  return p ? p.name : 'Unknown persona';
}
function placeLabelFor(placeId) {
  if (!placeId) return null;
  return world.placeById(placeId)?.name || null;
}
function formattedTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : '';
}

async function add() {
  const text = newText.value.trim();
  if (!text) { addStatus.value = 'Enter some text first.'; return; }
  const { ok, data } = await addMemory(props.characterId, { text, personaId: newPersonaId.value || null });
  if (!ok) { addStatus.value = data.error || 'Could not add memory.'; return; }
  memories.value.unshift(data.memory);
  total.value += 1;
  newText.value = '';
  addStatus.value = '';
}

function startEdit(entry) {
  editingId.value = entry.id;
  editText.value = entry.text;
}
function cancelEdit() {
  editingId.value = null;
}
async function saveEdit(entry) {
  const text = editText.value.trim();
  if (!text) return;
  const { ok, data } = await updateMemory(props.characterId, entry.id, { text });
  if (!ok) { alert(data.error || 'Could not save changes.'); return; }
  const idx = memories.value.findIndex((m) => m.id === entry.id);
  if (idx !== -1) memories.value[idx] = data.memory;
  editingId.value = null;
}
async function remove(entry) {
  if (!confirm('Delete this memory?')) return;
  const { ok } = await deleteMemory(props.characterId, entry.id);
  if (ok) {
    memories.value = memories.value.filter((m) => m.id !== entry.id);
    total.value = Math.max(0, total.value - 1);
  }
}

// --- Debug: test a memory query ------------------------------------------
// Runs the same ranking retrieveMemories() uses for real generation, but
// surfaces every candidate (not just the winners) with its score and
// whether it would actually be recalled — the "list everything" view above
// can't answer "why didn't X get remembered," this can. (State + resetDebug
// declared up top, near load() — see the comment there.)
async function runDebugQuery() {
  const query = debugQuery.value.trim();
  if (!query) return;
  debugBusy.value = true;
  debugError.value = '';
  try {
    const { ok, data } = await queryMemories(props.characterId, { query });
    if (!ok) { debugError.value = data.error || 'Query failed.'; return; }
    debugResults.value = data.results || [];
    debugMinScoreUsed.value = data.minScoreUsed ?? null;
    debugRan.value = true;
  } finally {
    debugBusy.value = false;
  }
}
</script>

<template>
  <div>
    <div class="form-grid">
      <div>
        <label>Persona</label>
        <select v-model="newPersonaId">
          <option value="">No persona</option>
          <option v-for="p in world.personasList" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
      <div class="span2">
        <label>Text</label>
        <ExpandableTextarea class="memory-textarea" v-model="newText" placeholder="What should this character remember?" />
      </div>
    </div>
    <div class="form-actions">
      <button class="btn small" @click="add">Add memory</button>
      <span class="form-status">{{ addStatus }}</span>
    </div>

    <div class="memory-debug">
      <h3 class="memory-debug-title">Debug: test a memory query</h3>
      <p class="hint">Ranks every one of this character's memories against a query, so you can see near-misses too — not just what would actually be recalled.</p>
      <div class="row">
        <input
          type="text" v-model="debugQuery" placeholder="e.g. what does she think about the market?"
          @keyup.enter="runDebugQuery"
        >
        <button class="btn small" :disabled="debugBusy || !debugQuery.trim()" @click="runDebugQuery">Test</button>
      </div>
      <div class="form-status" v-if="debugError">{{ debugError }}</div>
      <p class="hint" v-if="debugRan && debugMinScoreUsed !== null" style="margin:8px 0;">
        Relevance threshold: {{ debugMinScoreUsed.toFixed(2) }} (Settings → Memory). "✓ recalled" means it would actually reach a real prompt.
      </p>
      <div class="empty-note" v-if="debugRan && !debugResults.length">This character has no memories to search.</div>
      <div class="memory-row" v-for="r in debugResults" :key="r.id">
        <div class="memory-meta">
          <span class="badge" :class="r.selected ? 'badge-recalled' : 'badge-dim'">{{ r.selected ? `✓ ${r.selectionReason}` : 'not recalled' }}</span>
          <span class="badge">score {{ r.score.toFixed(3) }}</span>
          <span class="badge">{{ personaLabelFor(r.personaId) }}</span>
          <span class="memory-time">{{ formattedTime(r.timestamp) }}</span>
        </div>
        <div class="memory-text">{{ r.text }}</div>
      </div>
    </div>

    <div class="empty-note" v-if="!memories.length">No memories yet — they accumulate automatically as you talk, or add one above.</div>
    <div class="memory-row" v-for="entry in memories" :key="entry.id">
      <div class="memory-meta">
        <span class="badge">{{ personaLabelFor(entry.personaId) }}</span>
        <span class="badge" v-if="placeLabelFor(entry.placeId)">{{ placeLabelFor(entry.placeId) }}</span>
        <span class="memory-time">{{ formattedTime(entry.timestamp) }}</span>
      </div>
      <template v-if="entry.id === editingId">
        <ExpandableTextarea class="memory-textarea" v-model="editText" />
        <div class="form-actions">
          <button class="btn small" @click="saveEdit(entry)">Save</button>
          <button class="btn secondary small" @click="cancelEdit">Cancel</button>
        </div>
      </template>
      <template v-else>
        <div class="memory-text">{{ entry.text }}</div>
        <div class="row-actions">
          <button @click="startEdit(entry)">Edit</button>
          <button class="danger" @click="remove(entry)">Delete</button>
        </div>
      </template>
    </div>
    <div class="memory-pagination" v-if="memories.length">
      <span class="memory-time" style="margin-left:0;">{{ memories.length }} of {{ total }}</span>
      <button class="btn secondary small" v-if="hasMore" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>

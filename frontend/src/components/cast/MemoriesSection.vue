<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { getMemories, addMemory, updateMemory, deleteMemory } from '../../api/memory';

// View/add/edit/delete a character's own memory entries. Memory is scoped
// per (character, persona), so entries are tagged with which persona they
// belong to (or "No persona") and grouping is done visually via a badge
// rather than separate lists.
const props = defineProps({ characterId: { type: String, required: true } });
const world = useWorldStore();

const memories = ref([]);
const editingId = ref(null);
const editText = ref('');
const newText = ref('');
const newPersonaId = ref('');
const addStatus = ref('');

async function load() {
  editingId.value = null;
  newText.value = '';
  newPersonaId.value = '';
  addStatus.value = '';
  const { data } = await getMemories(props.characterId);
  memories.value = data.memories || [];
}
watch(() => props.characterId, load, { immediate: true });

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
  if (ok) memories.value = memories.value.filter((m) => m.id !== entry.id);
}
</script>

<template>
  <div>
    <h2 style="font-size:1rem;margin:18px 0 10px;border-top:1px solid var(--border);padding-top:16px;">Memories</h2>
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
        <textarea v-model="newText" placeholder="What should this character remember?"></textarea>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn small" @click="add">Add memory</button>
      <span class="form-status">{{ addStatus }}</span>
    </div>

    <div class="empty-note" v-if="!memories.length">No memories yet — they accumulate automatically as you talk, or add one above.</div>
    <div class="memory-row" v-for="entry in memories" :key="entry.id">
      <div class="memory-meta">
        <span class="badge">{{ personaLabelFor(entry.personaId) }}</span>
        <span class="badge" v-if="placeLabelFor(entry.placeId)">{{ placeLabelFor(entry.placeId) }}</span>
        <span class="memory-time">{{ formattedTime(entry.timestamp) }}</span>
      </div>
      <template v-if="entry.id === editingId">
        <textarea class="edit-memory-text" v-model="editText"></textarea>
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
  </div>
</template>

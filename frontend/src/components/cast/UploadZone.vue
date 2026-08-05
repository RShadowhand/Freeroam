<script setup>
import { ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { uploadCharacterCard, importCharacterFromUrl } from '../../api/characters';

const world = useWorldStore();
const fileInput = ref(null);
const dragover = ref(false);
const statusLines = ref([]); // { text, ok }, newest first
const importUrl = ref('');
const importing = ref(false);

function addStatusLine(text, ok) {
  statusLines.value.unshift({ text, ok });
}

function addCharacter(character) {
  world.charactersList.push(character);
  world.charactersById[character.id] = character;
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type === 'image/png' || f.name.toLowerCase().endsWith('.png'));
  for (const file of files) {
    const { ok, data } = await uploadCharacterCard(file);
    if (!ok) { addStatusLine(`${file.name}: ${data.error || `upload failed`}`, false); continue; }
    addStatusLine(`${data.character.name} added (${file.name})`, true);
    addCharacter(data.character);
  }
}

function onChange() {
  if (fileInput.value.files.length) uploadFiles(fileInput.value.files);
  fileInput.value.value = '';
}
function onDrop(e) {
  dragover.value = false;
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
}

// A page URL (e.g. a chub.ai character page) or a direct card PNG link —
// see backend/lib/cardImport.js for what's actually supported. Guarded by
// `importing` the same way the modal saves are (see CharacterModal.vue):
// this is a real network fetch on the backend, not an instant local read
// like the file-upload path above, so a double-click is a real risk here.
async function importFromUrl() {
  const url = importUrl.value.trim();
  if (!url || importing.value) return;
  importing.value = true;
  try {
    const { ok, data } = await importCharacterFromUrl(url);
    if (!ok) { addStatusLine(`${url}: ${data.error || 'import failed'}`, false); return; }
    addStatusLine(`${data.character.name} added (from URL)`, true);
    addCharacter(data.character);
    importUrl.value = '';
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div
    class="upload-zone" :class="{ dragover }"
    @dragenter.prevent="dragover = true" @dragover.prevent="dragover = true"
    @dragleave.prevent="dragover = false" @drop.prevent="onDrop"
  >
    <p>Drop TavernCard V2 PNGs here, or</p>
    <button class="btn" type="button" @click="fileInput.click()">Choose files</button>
    <input type="file" ref="fileInput" accept="image/png" multiple @change="onChange">
    <div class="upload-zone-url-row">
      <p>Or import from a Chub.ai/Botbooru character page (or a direct card PNG link):</p>
      <div class="upload-zone-url-input">
        <input
          type="text" v-model="importUrl" placeholder="https://chub.ai/characters/..."
          :disabled="importing" @keydown.enter="importFromUrl"
        >
        <button class="btn secondary" type="button" :disabled="importing || !importUrl.trim()" @click="importFromUrl">
          {{ importing ? 'Importing…' : 'Import' }}
        </button>
      </div>
    </div>
    <div class="upload-status">
      <div v-for="(line, i) in statusLines" :key="i" :class="line.ok ? 'ok' : 'fail'">
        {{ line.ok ? '✓ ' : '✗ ' }}{{ line.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.upload-zone-url-row{ margin-top:12px; }
.upload-zone-url-row p{ margin:0 0 6px; font-size:0.85rem; color:var(--dim); }
.upload-zone-url-input{ display:flex; gap:8px; }
.upload-zone-url-input input{ flex:1; min-width:0; }
</style>

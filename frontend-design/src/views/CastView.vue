<script setup>
import { onMounted, ref } from 'vue';
import { useWorldStore } from '../stores/world';
import { useCharacterModal } from '../composables/useCharacterModal';
import { randomizePlacements } from '../api/world';
import { importCharacters } from '../api/characters';
import UploadZone from '../components/cast/UploadZone.vue';
import CastCard from '../components/cast/CastCard.vue';
import CharacterModal from '../components/cast/CharacterModal.vue';

const world = useWorldStore();
const characterModal = useCharacterModal();
const importFileInput = ref(null);
const importStatus = ref('');

onMounted(async () => {
  await world.loadWorldState();
});

async function randomize() {
  const { ok, data } = await randomizePlacements();
  if (ok) world.placements = data.placements;
}

// Accepts the { characters: [...] } shape CharacterModal's Export button
// produces (plain JSON — a PNG card upload is UploadZone.vue's separate flow).
async function importFile(file) {
  importStatus.value = '';
  try {
    const raw = JSON.parse(await file.text());
    const characters = Array.isArray(raw.characters) ? raw.characters : [raw];
    const { ok, data } = await importCharacters(characters);
    if (!ok) throw new Error(data.error || 'import failed');
    world.charactersList.push(...data.characters);
    data.characters.forEach((c) => { world.charactersById[c.id] = c; });
    importStatus.value = `Imported ${data.characters.length} character(s).`;
  } catch (err) {
    importStatus.value = `${file.name}: ${err.message}`;
  }
}
function onImportFileChange() {
  const [file] = importFileInput.value.files;
  if (file) importFile(file);
  importFileInput.value.value = '';
}
</script>

<template>
  <section id="view-cast" class="view">
    <UploadZone />

    <div class="toolbar">
      <h2>Everyone in the cast</h2>
      <div class="toolbar-actions">
        <button class="btn secondary" @click="importFileInput.click()">Import (.json)</button>
        <input type="file" ref="importFileInput" accept="application/json,.json" style="display:none;" @change="onImportFileChange">
        <button class="btn secondary" @click="randomize">🎲 Randomize placements</button>
        <button class="btn" type="button" @click="characterModal.open(null)">+ New character</button>
      </div>
    </div>
    <div class="form-status" v-if="importStatus">{{ importStatus }}</div>

    <div class="empty-note" v-if="!world.charactersList.length">No characters yet — upload a card above, or add one.</div>
    <div class="grid cast-grid" v-else>
      <CastCard v-for="c in world.charactersList" :key="c.id" :character="c" />
    </div>
  </section>
  <CharacterModal />
</template>

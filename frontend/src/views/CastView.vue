<script setup>
import { onMounted, ref } from 'vue';
import { useWorldStore } from '../stores/world';
import { useCharacterModal } from '../composables/useCharacterModal';
import { usePersonaModal } from '../composables/usePersonaModal';
import { randomizePlacements } from '../api/world';
import { importCharacters } from '../api/characters';
import { setActivePersona, importPersonas, importPersonaCard } from '../api/personas';
import UploadZone from '../components/cast/UploadZone.vue';
import CastCard from '../components/cast/CastCard.vue';
import CharacterModal from '../components/cast/CharacterModal.vue';
import PersonaCard from '../components/persona/PersonaCard.vue';
import PersonaModal from '../components/persona/PersonaModal.vue';

const world = useWorldStore();
const characterModal = useCharacterModal();
const personaModal = usePersonaModal();
const importFileInput = ref(null);
const importStatus = ref('');
const personaImportFileInput = ref(null);
const personaImportStatus = ref('');

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

async function clearActivePersona() {
  const { ok, data } = await setActivePersona(null);
  if (ok) world.activePersonaId = data.activePersonaId;
}

// Accepts either the { personas: [...] } shape PersonaModal's Export button
// produces (a JSON file) or a tavernroam_persona_v1 PNG card.
async function importPersonaFile(file) {
  personaImportStatus.value = '';
  try {
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
    let ok, data;
    if (isPng) {
      ({ ok, data } = await importPersonaCard(file));
    } else {
      const raw = JSON.parse(await file.text());
      const personas = Array.isArray(raw.personas) ? raw.personas : [raw];
      ({ ok, data } = await importPersonas(personas));
    }
    if (!ok) throw new Error(data.error || 'import failed');
    world.personasList.push(...data.personas);
    personaImportStatus.value = `Imported ${data.personas.length} persona(s).`;
  } catch (err) {
    personaImportStatus.value = `${file.name}: ${err.message}`;
  }
}
function onPersonaImportFileChange() {
  const [file] = personaImportFileInput.value.files;
  if (file) importPersonaFile(file);
  personaImportFileInput.value.value = '';
}
</script>

<template>
  <section id="view-cast" class="view">
    <!-- Personas first — a handful at most, versus a cast that can run to
         hundreds, so the short list leads. Each section wrapped in
         .cast-section so there's real breathing room between the two
         grids, however either one currently renders (grid vs empty-note). -->
    <div class="cast-section">
      <div class="toolbar">
        <h2>Your personas</h2>
        <div class="toolbar-actions">
          <button class="btn secondary small" v-if="world.activePersonaId" @click="clearActivePersona">Clear active persona</button>
          <button class="btn secondary small" @click="personaImportFileInput.click()">Import persona (.json or .png)</button>
          <input type="file" ref="personaImportFileInput" accept="application/json,.json,image/png,.png" style="display:none;" @change="onPersonaImportFileChange">
          <button class="btn" type="button" @click="personaModal.open(null)">+ New persona</button>
        </div>
      </div>
      <div class="form-status" v-if="personaImportStatus">{{ personaImportStatus }}</div>
      <div class="empty-note" v-if="!world.personasList.length">
        No personas yet — add one above. Without one, you'll appear in scenes as "the visitor."
      </div>
      <div class="grid" v-else>
        <PersonaCard v-for="p in world.personasList" :key="p.id" :persona="p" />
      </div>
    </div>

    <div class="cast-section">
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
    </div>
  </section>
  <CharacterModal />
  <PersonaModal />
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useWorldStore } from '../stores/world';
import { setActivePersona, importPersonas } from '../api/personas';
import AddPersonaForm from '../components/persona/AddPersonaForm.vue';
import PersonaCard from '../components/persona/PersonaCard.vue';

const world = useWorldStore();
const importFileInput = ref(null);
const importStatus = ref('');

onMounted(async () => {
  await world.loadWorldState();
});

async function clearActive() {
  const { ok, data } = await setActivePersona(null);
  if (ok) world.activePersonaId = data.activePersonaId;
}

// Accepts the { personas: [...] } shape PersonaCard's Export button produces
// (a JSON file, client-parsed here — same file.text()+JSON.parse pattern as
// PresetUploadZone.vue), not a zip — this is per-persona, not a whole world.
async function importFile(file) {
  importStatus.value = '';
  try {
    const raw = JSON.parse(await file.text());
    const personas = Array.isArray(raw.personas) ? raw.personas : [raw];
    const { ok, data } = await importPersonas(personas);
    if (!ok) throw new Error(data.error || 'import failed');
    world.personasList.push(...data.personas);
    importStatus.value = `Imported ${data.personas.length} persona(s).`;
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
  <section id="view-persona" class="view">
    <AddPersonaForm />

    <div class="toolbar">
      <h2>Your personas</h2>
      <div class="toolbar-actions">
        <button class="btn secondary small" @click="importFileInput.click()">Import persona (.json)</button>
        <input type="file" ref="importFileInput" accept="application/json,.json" style="display:none;" @change="onImportFileChange">
        <button class="btn secondary small" v-if="world.activePersonaId" @click="clearActive">Clear active persona</button>
      </div>
    </div>
    <div class="form-status" v-if="importStatus">{{ importStatus }}</div>

    <div class="empty-note" v-if="!world.personasList.length">
      No personas yet — add one above. Without one, you'll appear in scenes as "the visitor."
    </div>
    <div class="grid" v-else>
      <PersonaCard v-for="p in world.personasList" :key="p.id" :persona="p" />
    </div>
  </section>
</template>

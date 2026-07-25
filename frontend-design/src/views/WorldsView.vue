<script setup>
import { ref, onMounted } from 'vue';
import { useWorldsStore } from '../stores/worlds';
import WorldCard from '../components/worlds/WorldCard.vue';

const worlds = useWorldsStore();

const creating = ref(false);
const newName = ref('');
const newMode = ref('seeded'); // seeded | empty | clone
const cloneFromId = ref('');
const cloneIncludeHistory = ref(true);
const createError = ref('');
const creatingBusy = ref(false);

const importFileInput = ref(null);
const importBusy = ref(false);
const importStatus = ref('');

onMounted(async () => {
  await worlds.refresh();
});

async function importWorldFile(file) {
  importBusy.value = true;
  importStatus.value = '';
  const { ok, data } = await worlds.importWorld(file, file.name.replace(/\.zip$/i, ''));
  importBusy.value = false;
  if (!ok) { importStatus.value = data.error || 'Could not import world.'; return; }
  const warnings = data.warnings || [];
  importStatus.value = `Imported "${data.world.name}"${warnings.length ? ` — ${warnings.join(' ')}` : '.'}`;
}

function onImportFileChange() {
  const [file] = importFileInput.value.files;
  if (file) importWorldFile(file);
  importFileInput.value.value = '';
}

function openCreate() {
  newName.value = '';
  newMode.value = 'seeded';
  cloneFromId.value = worlds.list[0]?.id || '';
  cloneIncludeHistory.value = true;
  createError.value = '';
  creating.value = true;
}

async function create() {
  creatingBusy.value = true;
  const opts = { name: newName.value, mode: newMode.value };
  if (newMode.value === 'clone') {
    opts.cloneFromId = cloneFromId.value;
    opts.includeHistory = cloneIncludeHistory.value;
  }
  const { ok, data } = await worlds.create(opts);
  creatingBusy.value = false;
  if (!ok) { createError.value = data.error || 'Could not create world.'; return; }
  creating.value = false;
}
</script>

<template>
  <section id="view-worlds" class="view">
    <div class="toolbar">
      <div>
        <h2>Worlds</h2>
        <p class="hint" style="margin:2px 0 0;">Save slots — switch, duplicate, or start fresh.</p>
      </div>
      <div class="toolbar-actions">
        <button class="btn secondary small" :disabled="importBusy" @click="importFileInput.click()">Import world (.zip)</button>
        <input type="file" ref="importFileInput" accept="application/zip,.zip" style="display:none;" @change="onImportFileChange">
        <button class="btn secondary small" @click="openCreate">+ New world</button>
      </div>
    </div>
    <div class="form-status" v-if="importStatus">{{ importStatus }}</div>

    <div class="world-grid">
      <WorldCard v-for="w in worlds.list" :key="w.id" :world="w" />
    </div>

    <div class="modal-overlay" v-if="creating" @click="(e) => { if (e.target === e.currentTarget) creating = false; }">
      <div class="modal">
        <h2>New world</h2>
        <div class="form-grid">
          <div class="span2">
            <label>Name</label>
            <input type="text" v-model="newName" placeholder="A fantasy campaign, a modern-city sandbox...">
          </div>
          <div class="span2">
            <label>Starting point</label>
            <div class="placement-options">
              <label><input type="radio" value="seeded" v-model="newMode"> Seeded — the built-in starter cast and places</label>
              <label><input type="radio" value="empty" v-model="newMode"> Empty — a blank slate</label>
              <label><input type="radio" value="clone" v-model="newMode"> Copy of an existing world</label>
            </div>
          </div>
          <template v-if="newMode === 'clone'">
            <div class="span2">
              <label>Copy from</label>
              <select v-model="cloneFromId">
                <option v-for="w in worlds.list" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
            </div>
            <div class="span2">
              <label class="world-card-checkbox"><input type="checkbox" v-model="cloneIncludeHistory"> Include chat history &amp; memories</label>
            </div>
          </template>
        </div>
        <div class="form-actions">
          <button class="btn" :disabled="creatingBusy" @click="create">Create world</button>
          <button class="btn secondary" @click="creating = false">Cancel</button>
          <span class="form-status">{{ createError }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

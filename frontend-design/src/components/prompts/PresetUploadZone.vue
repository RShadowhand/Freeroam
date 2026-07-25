<script setup>
import { ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { importPreset, createPreset } from '../../api/presets';

const world = useWorldStore();
const fileInput = ref(null);
const statusLines = ref([]);

function addStatusLine(text, ok) {
  statusLines.value.unshift({ text, ok });
}

async function importFile(file) {
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const fallbackName = file.name.replace(/\.json$/i, '');
    const { ok, data } = await importPreset(raw, fallbackName);
    if (!ok) throw new Error(data.error || 'import failed');
    world.presetsList.push(data.preset);
    addStatusLine(`Imported "${data.preset.name}" (${data.preset.prompts.length} prompt blocks)`, true);
  } catch (err) {
    addStatusLine(`${file.name}: ${err.message}`, false);
  }
}

function onChange() {
  const [file] = fileInput.value.files;
  if (file) importFile(file);
  fileInput.value.value = '';
}
function onDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) importFile(file);
}

async function newBlank() {
  const { ok, data } = await createPreset({
    name: 'New preset',
    prompts: [{ identifier: 'main', name: 'Main Prompt', role: 'system', content: '', marker: false, enabled: true }],
  });
  if (ok) world.presetsList.push(data.preset);
}
</script>

<template>
  <div class="upload-zone" @dragover.prevent @drop.prevent="onDrop">
    <p>Drop a SillyTavern Chat Completion preset (.json) here, or</p>
    <button class="btn" type="button" @click="fileInput.click()">Choose file</button>
    <button class="btn secondary" type="button" @click="newBlank">+ New blank preset</button>
    <input type="file" ref="fileInput" accept="application/json,.json" @change="onChange">
    <div class="upload-status">
      <div v-for="(line, i) in statusLines" :key="i" :class="line.ok ? 'ok' : 'fail'">
        {{ line.ok ? '✓ ' : '✗ ' }}{{ line.text }}
      </div>
    </div>
  </div>
</template>

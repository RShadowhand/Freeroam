<script setup>
import { ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { uploadCharacterCard } from '../../api/characters';

const world = useWorldStore();
const fileInput = ref(null);
const dragover = ref(false);
const statusLines = ref([]); // { text, ok }, newest first

function addStatusLine(text, ok) {
  statusLines.value.unshift({ text, ok });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type === 'image/png' || f.name.toLowerCase().endsWith('.png'));
  for (const file of files) {
    const { ok, data } = await uploadCharacterCard(file);
    if (!ok) { addStatusLine(`${file.name}: ${data.error || `upload failed`}`, false); continue; }
    addStatusLine(`${data.character.name} added (${file.name})`, true);
    world.charactersList.push(data.character);
    world.charactersById[data.character.id] = data.character;
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
    <div class="upload-status">
      <div v-for="(line, i) in statusLines" :key="i" :class="line.ok ? 'ok' : 'fail'">
        {{ line.ok ? '✓ ' : '✗ ' }}{{ line.text }}
      </div>
    </div>
  </div>
</template>

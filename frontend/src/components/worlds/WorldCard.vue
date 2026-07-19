<script setup>
import { ref, computed } from 'vue';
import { useWorldsStore } from '../../stores/worlds';

const props = defineProps({ world: { type: Object, required: true } });
const worlds = useWorldsStore();

const isCurrent = computed(() => props.world.id === worlds.currentWorldId);
const busy = ref(false);
const error = ref('');

const renaming = ref(false);
const renameValue = ref('');
function startRename() {
  renameValue.value = props.world.name;
  renaming.value = true;
  error.value = '';
}
async function saveRename() {
  busy.value = true;
  const { ok, data } = await worlds.rename(props.world.id, renameValue.value);
  busy.value = false;
  if (!ok) { error.value = data.error || 'Could not rename.'; return; }
  renaming.value = false;
}

const duplicating = ref(false);
const duplicateName = ref('');
const duplicateIncludeHistory = ref(true);
function startDuplicate() {
  duplicateName.value = `${props.world.name} (copy)`;
  duplicateIncludeHistory.value = true;
  duplicating.value = true;
  error.value = '';
}
async function confirmDuplicate() {
  busy.value = true;
  const { ok, data } = await worlds.duplicate(props.world.id, { name: duplicateName.value, includeHistory: duplicateIncludeHistory.value });
  busy.value = false;
  if (!ok) { error.value = data.error || 'Could not duplicate.'; return; }
  duplicating.value = false;
}

async function switchTo() {
  busy.value = true;
  await worlds.switchWorld(props.world.id);
  busy.value = false;
}

async function remove() {
  if (worlds.list.length <= 1) return;
  const sure = confirm(`Delete "${props.world.name}"? This permanently deletes its characters, places, chat history, and memories. This cannot be undone.`);
  if (!sure) return;
  busy.value = true;
  const { ok, data } = await worlds.remove(props.world.id);
  busy.value = false;
  if (!ok) error.value = data.error || 'Could not delete.';
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}
</script>

<template>
  <div class="world-card" :class="{ current: isCurrent }">
    <template v-if="renaming">
      <div class="world-card-header"><h3>{{ world.name }}</h3></div>
      <input type="text" v-model="renameValue" @keyup.enter="saveRename" @keyup.escape="renaming = false">
      <div class="form-actions">
        <button class="btn small" :disabled="busy" @click="saveRename">Save</button>
        <button class="btn secondary small" @click="renaming = false">Cancel</button>
      </div>
    </template>

    <template v-else-if="duplicating">
      <div class="world-card-header"><h3>{{ world.name }}</h3></div>
      <input type="text" v-model="duplicateName" placeholder="New world name">
      <label class="world-card-checkbox"><input type="checkbox" v-model="duplicateIncludeHistory"> Include chat history &amp; memories</label>
      <div class="form-actions">
        <button class="btn small" :disabled="busy" @click="confirmDuplicate">Create copy</button>
        <button class="btn secondary small" @click="duplicating = false">Cancel</button>
      </div>
    </template>

    <template v-else>
      <div class="world-card-header">
        <h3>{{ world.name }}</h3>
        <span class="world-badge" v-if="isCurrent">Current</span>
      </div>
      <div class="world-card-meta">Last played {{ formatDate(world.lastPlayedAt) }}</div>
      <div class="world-card-actions">
        <button class="btn small" :disabled="busy || isCurrent" @click="switchTo">{{ isCurrent ? 'Current' : 'Switch' }}</button>
        <button class="btn secondary small" :disabled="busy" @click="startRename">Rename</button>
        <button class="btn secondary small" :disabled="busy" @click="startDuplicate">Duplicate</button>
        <button
          class="btn danger small" :disabled="busy || worlds.list.length <= 1"
          :title="worlds.list.length <= 1 ? 'Cannot delete the only world' : 'Delete this world'" @click="remove"
        >Delete</button>
      </div>
    </template>

    <div class="form-status" v-if="error">{{ error }}</div>
  </div>
</template>

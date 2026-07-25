<script setup>
import { ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { addPlace } from '../../api/places';
import { useQuickAddPlace } from '../../composables/useQuickAddPlace';

// Quick-add place — a mini version of the Places form living beside the
// map, so a new room (and, via its free-text area field, a new area) can be
// added mid-roam without leaving the chat view.
const world = useWorldStore();
const quickAdd = useQuickAddPlace();

const name = ref('');
const area = ref('');
const type = ref('communal');
const status = ref('');

watch(quickAdd.prefillName, (n) => { if (n) name.value = n; });

async function submit() {
  status.value = '';
  if (!name.value.trim()) { status.value = 'Name is required.'; return; }
  const { ok, data } = await addPlace({ name: name.value.trim(), area: area.value.trim(), type: type.value, desc: '' });
  if (!ok) { status.value = data.error || 'Could not add place.'; return; }
  world.places.push(data.place);
  name.value = '';
  area.value = '';
  quickAdd.isOpen.value = false;
}
</script>

<template>
  <button class="btn secondary small" type="button" @click="quickAdd.isOpen.value = !quickAdd.isOpen.value">+ Add place</button>
  <div class="quick-add-form" v-if="quickAdd.isOpen.value">
    <input type="text" v-model="name" placeholder="Place name">
    <input type="text" v-model="area" placeholder="Area (optional)">
    <select v-model="type">
      <option value="communal">Communal</option>
      <option value="private">Private</option>
    </select>
    <div class="form-actions" style="margin-top:8px;">
      <button class="btn small" type="button" @click="submit">Add</button>
      <span class="form-status">{{ status }}</span>
    </div>
  </div>
</template>

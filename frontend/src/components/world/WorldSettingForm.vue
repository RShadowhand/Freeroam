<script setup>
import { ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';

const world = useWorldStore();
const text = ref(world.worldSetting || '');
const status = ref('');

watch(() => world.worldSetting, (v) => { text.value = v || ''; });

async function save() {
  const { ok, data } = await world.saveWorldSetting(text.value);
  status.value = ok ? 'Saved.' : (data.error || 'Could not save.');
}
</script>

<template>
  <div class="form-card">
    <h2>World setting</h2>
    <p class="hint">Global setting/lore fed into every scene's context (e.g. genre, era, tone). Leave blank for none.</p>
    <textarea v-model="text" placeholder="A rain-soaked port city where the streetlights never quite go out..."></textarea>
    <div class="form-actions">
      <button class="btn small" type="button" @click="save">Save setting</button>
      <span class="form-status">{{ status }}</span>
    </div>
  </div>
</template>

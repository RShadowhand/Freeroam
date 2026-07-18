<script setup>
import { computed, onMounted, ref } from 'vue';
import { useWorldStore } from '../stores/world';
import { getStandardBlocks, setActivePreset } from '../api/presets';
import PresetUploadZone from '../components/prompts/PresetUploadZone.vue';
import PresetCard from '../components/prompts/PresetCard.vue';

const world = useWorldStore();
const standardBlocks = ref([]);
const markerLabels = computed(() => Object.fromEntries(standardBlocks.value.filter((b) => b.marker).map((b) => [b.identifier, b.description])));

onMounted(async () => {
  await world.loadWorldState();
  const { data } = await getStandardBlocks();
  standardBlocks.value = data.blocks || [];
});

async function useDefaultPrompt() {
  const { ok, data } = await setActivePreset(null);
  if (ok) world.activePresetId = data.activePresetId;
}
</script>

<template>
  <section id="view-prompts" class="view">
    <PresetUploadZone />

    <div class="toolbar">
      <h2>System prompt presets</h2>
      <button class="btn secondary small" v-if="world.activePresetId" @click="useDefaultPrompt">Use default prompt</button>
    </div>

    <div class="empty-note" v-if="!world.presetsList.length">
      No presets yet — import a SillyTavern Chat Completion preset above, or start a blank one. Without an active preset, Freeroam uses its built-in prompt.
    </div>
    <PresetCard
      v-for="preset in world.presetsList" :key="preset.id"
      :preset="preset" :standard-blocks="standardBlocks" :marker-labels="markerLabels"
    />
  </section>
</template>

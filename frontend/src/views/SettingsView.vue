<script setup>
import { onMounted } from 'vue';
import { useSettingsStore } from '../stores/settings';
import EndpointCard from '../components/settings/EndpointCard.vue';
import ModelCard from '../components/settings/ModelCard.vue';
import TestConnectionCard from '../components/settings/TestConnectionCard.vue';

const settings = useSettingsStore();

onMounted(async () => {
  await settings.load();
  await settings.loadModels();
});
</script>

<template>
  <section id="view-settings" class="view">
    <div class="auto-grid" style="--grid-min:360px;">
      <EndpointCard />
      <TestConnectionCard />
    </div>
    <ModelCard />
  </section>
</template>

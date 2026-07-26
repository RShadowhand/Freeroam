<script setup>
import { onMounted } from 'vue';
import { useWorldStore } from '../stores/world';
import RelationsGraph from '../components/world/RelationsGraph.vue';

const world = useWorldStore();

onMounted(async () => {
  await world.loadWorldState();
});
</script>

<template>
  <section id="view-relations" class="view">
    <div class="toolbar">
      <h2>Relations Graph</h2>
    </div>
    <p class="hint">Click a node to open that character or persona. Drag to reposition, scroll to zoom.</p>
    <RelationsGraph />
  </section>
</template>

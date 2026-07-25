<script setup>
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
</script>

<template>
  <div class="settings-card">
    <h2>Memory</h2>
    <p class="hint">How relevant a memory has to be (0–1 cosine similarity) before it's recalled into context. Small local embedding models can rate a memory as similar just for sharing one common word with what's being said, even when it's not actually related — raise this if characters bring up unrelated memories too often; lower it if they're not recalling things they should.</p>
    <div class="endpoint-row">
      <label style="flex-shrink:0;">Minimum relevance</label>
      <input
        type="range" min="0" max="1" step="0.05" style="flex:1;"
        v-model.number="settings.memoryMinScore" @change="settings.setMemoryMinScore(settings.memoryMinScore)"
      >
      <span class="status" style="min-width:2.5em;">{{ settings.memoryMinScore.toFixed(2) }}</span>
    </div>
  </div>
</template>

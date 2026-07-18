<script setup>
import { ref } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';

const settings = useSettingsStore();
const ui = useUiStore();
const rebuilding = ref(false);
const result = ref('');

async function rebuild() {
  rebuilding.value = true;
  result.value = 'Rebuilding embeddings…';
  try {
    const { ok, data } = await settings.rebuildEmbeddings();
    if (!ok) throw new Error(data.error || 'request failed');
    result.value = `✓ Rebuilt ${data.memories} memories, ${data.relationships} relationships, ${data.characters} character profiles.`;
  } catch (err) {
    result.value = `✗ ${err.message}`;
    ui.showError(`Rebuild embeddings failed: ${err.message}`);
  } finally {
    rebuilding.value = false;
  }
}
</script>

<template>
  <div class="settings-card">
    <h2>Embeddings</h2>
    <p class="hint">
      The local model that turns memory and relationship text into vectors for semantic recall. Currently
      <code>{{ settings.embeddingModel }}</code>. Switching models makes existing stored vectors incompatible with
      new ones (a different model isn't just a different score, it's a different vector space), so recall quality
      degrades until everything is re-embedded.
    </p>
    <p v-if="settings.embeddingsStale" class="hint" style="color: var(--rose);">
      Stored memories and relationships were embedded with a different model than the one currently configured.
      Recall may be degraded until you rebuild.
    </p>
    <button class="btn" :disabled="rebuilding" @click="rebuild">Rebuild embeddings</button>
    <div v-if="result" class="test-output">{{ result }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getChangelog } from '../../api/changelog';

const entries = ref([]);
const status = ref('loading'); // 'loading' | 'ready' | 'error'

onMounted(async () => {
  const { ok, data } = await getChangelog();
  if (ok) {
    entries.value = data.entries;
    status.value = 'ready';
  } else {
    status.value = 'error';
  }
});
</script>

<template>
  <div class="settings-card">
    <h2>Changelog</h2>
    <p class="hint">Read straight from this install's own git commit history.</p>
    <p class="hint" v-if="status === 'loading'">Loading…</p>
    <p class="hint" v-else-if="status === 'error'">Could not load the changelog.</p>
    <p class="hint" v-else-if="!entries.length">No commit history found (this copy may not have a .git directory).</p>
    <ul class="changelog-list" v-else>
      <li v-for="entry in entries" :key="entry.hash" class="changelog-entry">
        <span class="changelog-date">{{ entry.date }}</span>
        <span class="changelog-subject">{{ entry.subject }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.changelog-list{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
.changelog-entry{ display:flex; gap:10px; align-items:baseline; }
.changelog-date{
  font-family:'IBM Plex Mono',monospace; font-size:0.75rem; color:var(--dim); flex-shrink:0;
}
</style>

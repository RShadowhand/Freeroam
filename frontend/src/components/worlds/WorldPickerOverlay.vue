<script setup>
import { useRouter } from 'vue-router';
import { useWorldsStore } from '../../stores/worlds';
import { useWorldPicker } from '../../composables/useWorldPicker';

const worlds = useWorldsStore();
const picker = useWorldPicker();
const router = useRouter();

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}

async function pick(id) {
  if (id !== worlds.currentWorldId) await worlds.switchWorld(id);
  picker.close();
}

function manage() {
  picker.close();
  router.push('/worlds');
}
</script>

<template>
  <div class="modal-overlay" v-if="picker.isOpen.value" @click="(e) => { if (e.target === e.currentTarget) picker.close(); }">
    <div class="modal">
      <div class="modal-head-row">
        <h2>Choose a world</h2>
        <button class="modal-close" type="button" @click="picker.close()" title="Continue with the current world">✕</button>
      </div>
      <p class="hint" style="margin:2px 0 0;">You have more than one save slot — pick which one to play.</p>

      <div class="world-grid" style="margin-top:10px;">
        <button
          v-for="w in worlds.list" :key="w.id" type="button"
          class="world-card world-picker-card" :class="{ current: w.id === worlds.currentWorldId }"
          :disabled="worlds.switching" @click="pick(w.id)"
        >
          <div class="world-card-header">
            <h3>{{ w.name }}</h3>
            <span class="world-badge" v-if="w.id === worlds.currentWorldId">Current</span>
          </div>
          <div class="world-card-meta">Last played {{ formatDate(w.lastPlayedAt) }}</div>
        </button>
      </div>

      <div class="form-actions">
        <button class="btn secondary small" type="button" @click="manage">Manage worlds</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.world-picker-card{ text-align:left; cursor:pointer; font:inherit; color:inherit; }
.world-picker-card:hover{ border-color:var(--accent); }
.world-picker-card:disabled{ opacity:0.6; cursor:default; }
</style>

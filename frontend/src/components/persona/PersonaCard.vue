<script setup>
import { computed } from 'vue';
import { useWorldStore } from '../../stores/world';
import { usePersonaModal } from '../../composables/usePersonaModal';
import { setActivePersona } from '../../api/personas';
import CardAvatar from '../shared/CardAvatar.vue';

const props = defineProps({ persona: { type: Object, required: true } });
const world = useWorldStore();
const personaModal = usePersonaModal();

const isActive = computed(() => props.persona.id === world.activePersonaId);

async function activate() {
  const { ok, data } = await setActivePersona(props.persona.id);
  if (ok) world.activePersonaId = data.activePersonaId;
}
async function deactivate() {
  const { ok, data } = await setActivePersona(null);
  if (ok) world.activePersonaId = data.activePersonaId;
}
</script>

<template>
  <div class="char-card cast-card persona-cast-card">
    <div class="cast-card-avatar">
      <CardAvatar :name="persona.name" :avatar-url="persona.avatarUrl" :color="persona.color" />
    </div>
    <div class="card-name">{{ persona.name }}</div>
    <span class="active-badge" v-if="isActive">Active</span>
    <div class="card-actions">
      <button class="btn secondary small" v-if="isActive" @click="deactivate">Clear active</button>
      <button class="btn secondary small" v-else @click="activate">Set active</button>
      <button class="btn secondary small" @click="personaModal.open(persona.id)">Edit</button>
    </div>
  </div>
</template>

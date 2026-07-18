<script setup>
import { onMounted } from 'vue';
import { useWorldStore } from '../stores/world';
import { setActivePersona } from '../api/personas';
import AddPersonaForm from '../components/persona/AddPersonaForm.vue';
import PersonaCard from '../components/persona/PersonaCard.vue';

const world = useWorldStore();

onMounted(async () => {
  await world.loadWorldState();
});

async function clearActive() {
  const { ok, data } = await setActivePersona(null);
  if (ok) world.activePersonaId = data.activePersonaId;
}
</script>

<template>
  <section id="view-persona" class="view">
    <AddPersonaForm />

    <div class="toolbar">
      <h2>Your personas</h2>
      <button class="btn secondary small" v-if="world.activePersonaId" @click="clearActive">Clear active persona</button>
    </div>

    <div class="empty-note" v-if="!world.personasList.length">
      No personas yet — add one above. Without one, you'll appear in scenes as "the visitor."
    </div>
    <div class="grid" v-else>
      <PersonaCard v-for="p in world.personasList" :key="p.id" :persona="p" />
    </div>
  </section>
</template>

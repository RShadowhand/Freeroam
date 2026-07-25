<script setup>
import { useCharacterModal } from '../../composables/useCharacterModal';
import CardAvatar from '../shared/CardAvatar.vue';

const props = defineProps({ character: { type: Object, required: true } });
const characterModal = useCharacterModal();

const sourceLabel = {
  builtin: 'Built-in',
  npc: 'Saved from a scene',
}[props.character.source] || 'Uploaded';
</script>

<template>
  <div class="char-card cast-card" @click="characterModal.open(character.id)">
    <div class="cast-card-avatar">
      <CardAvatar :name="character.name" :avatar-url="character.avatarUrl" :color="character.color" />
    </div>
    <div class="card-name">{{ character.name }}</div>
    <div class="badge">{{ sourceLabel }}</div>
  </div>
</template>

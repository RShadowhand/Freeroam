<script setup>
import { computed } from 'vue';
import { useWorldStore } from '../../stores/world';
import CardAvatar from '../shared/CardAvatar.vue';

// Contacts are characters the user actually knows — either they've shared
// a scene together already, or the world author gave them an explicit
// relationship to the user (see world.knowsUser). Not every character in
// the world, which would list strangers from unrelated corners of the
// cast the user has never met.
const world = useWorldStore();
defineEmits(['open']);

const contacts = computed(() => world.charactersList.filter((c) => world.knowsUser(c.id)));
</script>

<template>
  <div class="phone-contacts">
    <div class="empty-note" v-if="!contacts.length">No contacts yet — meet someone in a scene, or give them a relationship to you in Cast.</div>
    <button class="phone-contact-row" type="button" v-for="c in contacts" :key="c.id" @click="$emit('open', c.id)">
      <CardAvatar :name="c.name" :avatar-url="c.avatarUrl" :color="c.color" />
      <span class="phone-contact-name">{{ c.name }}</span>
    </button>
  </div>
</template>

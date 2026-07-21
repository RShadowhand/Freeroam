<script setup>
import { computed, onMounted } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useGroupsStore } from '../../stores/groups';
import CardAvatar from '../shared/CardAvatar.vue';

// Contacts are characters the user actually knows — either they've shared
// a scene together already, or the world author gave them an explicit
// relationship to the user (see world.knowsUser). Not every character in
// the world, which would list strangers from unrelated corners of the
// cast the user has never met. Existing groups (Phase 4) share this same
// list, above the 1-on-1 contacts, rather than living behind a separate tab.
const world = useWorldStore();
const groups = useGroupsStore();
defineEmits(['open', 'open-group', 'new-group']);

const contacts = computed(() => world.charactersList.filter((c) => world.knowsUser(c.id)));

onMounted(() => { groups.loadGroups(); });
</script>

<template>
  <div class="phone-contacts">
    <button class="phone-contact-row new-group-row" type="button" @click="$emit('new-group')">
      <span class="group-icon">＋</span>
      <span class="phone-contact-name">New group</span>
    </button>

    <button
      class="phone-contact-row" type="button" v-for="g in groups.groups" :key="g.id"
      @click="$emit('open-group', g.id)"
    >
      <span class="group-icon">👥</span>
      <span class="phone-contact-name">{{ g.name }}</span>
    </button>

    <div class="empty-note" v-if="!contacts.length">No contacts yet — meet someone in a scene, or give them a relationship to you in Cast.</div>
    <button class="phone-contact-row" type="button" v-for="c in contacts" :key="c.id" @click="$emit('open', c.id)">
      <CardAvatar :name="c.name" :avatar-url="c.avatarUrl" :color="c.color" />
      <span class="phone-contact-name">{{ c.name }}</span>
    </button>
  </div>
</template>

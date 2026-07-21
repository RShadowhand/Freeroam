<script setup>
import { ref } from 'vue';
import PhoneHeader from './PhoneHeader.vue';
import PhoneContacts from './PhoneContacts.vue';
import PhoneThread from './PhoneThread.vue';
import GroupThread from './GroupThread.vue';
import NewGroupForm from './NewGroupForm.vue';

// Right column of the Freeroam layout, mirroring MapAreaPanel.vue on the
// left — always visible on desktop, shown full-screen on mobile via
// PhoneStrip's toggle (see FreeroamView.vue). World state is already
// loaded by the time this mounts (it's inside .layout, which only
// renders once FreeroamView's own onMounted has resolved).
// view: null (contacts list) | {type:'contact', id} | {type:'group', id} | {type:'new-group'}
const view = ref(null);
const emit = defineEmits(['call-started']);
</script>

<template>
  <div class="phone-col">
    <PhoneHeader />
    <PhoneContacts
      v-if="!view"
      @open="view = { type: 'contact', id: $event }"
      @open-group="view = { type: 'group', id: $event }"
      @new-group="view = { type: 'new-group' }"
    />
    <PhoneThread
      v-else-if="view.type === 'contact'" :character-id="view.id"
      @back="view = null" @call-started="emit('call-started')"
    />
    <GroupThread v-else-if="view.type === 'group'" :group-id="view.id" @back="view = null" />
    <NewGroupForm v-else @created="view = { type: 'group', id: $event }" @cancel="view = null" />
  </div>
</template>

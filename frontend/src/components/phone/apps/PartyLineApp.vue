<script setup>
import { onMounted, ref } from 'vue';
import { useGroupsStore } from '../../../stores/groups';
import GroupThread from '../GroupThread.vue';
import NewGroupForm from '../NewGroupForm.vue';

// Party Line: RoamOS's group texting app.
const emit = defineEmits(['back']);
const groups = useGroupsStore();
const view = ref(null); // null (list) | { type: 'group', id } | { type: 'new' }

onMounted(() => { groups.loadGroups(); });
</script>

<template>
  <div class="phone-app-screen" v-if="!view">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('back')">‹ Home</button>
      <span class="phone-thread-name">Party Line</span>
    </div>
    <div class="phone-contacts">
      <button class="phone-contact-row new-group-row" type="button" @click="view = { type: 'new' }">
        <span class="group-icon">＋</span>
        <span class="phone-contact-name">New group</span>
      </button>
      <div class="empty-note" v-if="!groups.groups.length">No groups yet — start one above.</div>
      <button
        class="phone-contact-row" type="button" v-for="g in groups.groups" :key="g.id"
        @click="view = { type: 'group', id: g.id }"
      >
        <span class="group-icon">👥</span>
        <span class="phone-contact-name">{{ g.name }}</span>
      </button>
    </div>
  </div>
  <GroupThread v-else-if="view.type === 'group'" :group-id="view.id" @back="view = null" />
  <NewGroupForm v-else @created="view = { type: 'group', id: $event }" @cancel="view = null" />
</template>

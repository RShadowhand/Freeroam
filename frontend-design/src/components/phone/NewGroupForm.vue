<script setup>
import { computed, ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useGroupsStore } from '../../stores/groups';
import CardAvatar from '../shared/CardAvatar.vue';

const emit = defineEmits(['created', 'cancel']);

const world = useWorldStore();
const groups = useGroupsStore();

const name = ref('');
const selected = ref(new Set());
const error = ref('');
const creating = ref(false);

// Same "known" pool the 1-on-1 contacts list already uses — a group is
// still just people the user actually knows, not the whole cast.
const candidates = computed(() => world.charactersList.filter((c) => world.knowsUser(c.id)));

function toggle(id) {
  if (selected.value.has(id)) selected.value.delete(id);
  else selected.value.add(id);
}

async function create() {
  error.value = '';
  if (!name.value.trim()) { error.value = 'Give the group a name.'; return; }
  if (selected.value.size < 2) { error.value = 'Pick at least 2 people.'; return; }

  creating.value = true;
  const { ok, data } = await groups.createGroup(name.value.trim(), [...selected.value]);
  creating.value = false;
  if (!ok) { error.value = data.error || 'Could not create the group.'; return; }
  emit('created', data.group.id);
}
</script>

<template>
  <div class="new-group-form">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('cancel')">‹ Contacts</button>
      <span class="phone-thread-name">New group</span>
    </div>

    <input class="new-group-name" v-model="name" type="text" placeholder="Group name" maxlength="60">

    <div class="empty-note" v-if="!candidates.length">No one to add yet — meet someone in a scene, or give them a relationship to you in Cast.</div>
    <div class="new-group-picker">
      <label class="new-group-option" v-for="c in candidates" :key="c.id">
        <input type="checkbox" :checked="selected.has(c.id)" @change="toggle(c.id)">
        <CardAvatar :name="c.name" :avatar-url="c.avatarUrl" :color="c.color" />
        <span>{{ c.name }}</span>
      </label>
    </div>

    <div class="new-group-actions">
      <span class="new-group-error" v-if="error">{{ error }}</span>
      <button class="btn small" :disabled="creating" @click="create">Create group</button>
    </div>
  </div>
</template>

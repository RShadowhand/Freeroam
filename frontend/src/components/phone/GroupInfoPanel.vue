<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useGroupsStore } from '../../stores/groups';
import CardAvatar from '../shared/CardAvatar.vue';

// Reachable via the "ⓘ" button in GroupThread.vue's header — the only
// place a group's roster is visible or editable after creation.
const props = defineProps({ groupId: { type: String, required: true } });
const emit = defineEmits(['back']);

const world = useWorldStore();
const groups = useGroupsStore();

const group = computed(() => groups.groups.find((g) => g.id === props.groupId));
const name = ref(group.value?.name || '');
watch(() => group.value?.name, (v) => { if (v !== undefined) name.value = v; });

const error = ref('');
const status = ref('');
const addingId = ref('');

const members = computed(() => (group.value?.participantIds || []).map((id) => world.charactersById[id]).filter(Boolean));
// Same "known" pool NewGroupForm.vue uses, minus whoever's already in the group.
const candidates = computed(() => world.charactersList
  .filter((c) => world.knowsUser(c.id) && !(group.value?.participantIds || []).includes(c.id)));

async function saveName() {
  if (!group.value || name.value.trim() === group.value.name) return;
  error.value = '';
  const { ok, data } = await groups.updateGroup(props.groupId, { name: name.value });
  if (!ok) { error.value = data.error || 'Could not rename the group.'; return; }
  status.value = 'Saved.';
}

async function addMember() {
  if (!addingId.value || !group.value) return;
  error.value = '';
  const { ok, data } = await groups.updateGroup(props.groupId, {
    participantIds: [...group.value.participantIds, addingId.value],
  });
  if (!ok) error.value = data.error || 'Could not add them.';
  addingId.value = '';
}

async function removeMember(id) {
  if (!group.value) return;
  const remaining = group.value.participantIds.filter((pid) => pid !== id);
  if (remaining.length < 2) { error.value = 'A group needs at least 2 participants.'; return; }
  error.value = '';
  const { ok, data } = await groups.updateGroup(props.groupId, { participantIds: remaining });
  if (!ok) error.value = data.error || 'Could not remove them.';
}
</script>

<template>
  <div class="phone-app-screen" v-if="group">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('back')">‹ Back</button>
      <span class="phone-thread-name">Group info</span>
    </div>

    <input
      class="new-group-name" v-model="name" type="text" maxlength="60"
      placeholder="Group name" @blur="saveName" @keydown.enter="saveName"
    >

    <div class="new-group-picker">
      <div class="new-group-option" v-for="m in members" :key="m.id" style="cursor:default;">
        <CardAvatar :name="m.name" :avatar-url="m.avatarUrl" :color="m.color" />
        <span style="flex:1;">{{ m.name }}</span>
        <button class="chip-remove" type="button" title="Remove from group" @click="removeMember(m.id)">✕</button>
      </div>
    </div>

    <div class="endpoint-row" v-if="candidates.length">
      <select v-model="addingId" style="flex:1;">
        <option value="">+ Add someone…</option>
        <option v-for="c in candidates" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <button class="btn secondary small" @click="addMember">Add</button>
    </div>

    <span class="new-group-error" v-if="error">{{ error }}</span>
    <span class="form-status" v-if="status">{{ status }}</span>
  </div>
</template>

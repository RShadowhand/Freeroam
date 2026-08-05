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
const saving = ref(false);
// A real generation call (see groups.js's triggerText), not the instant
// roster/name edits `saving` above guards — its own loadingIds check, not
// reused here, so nudging a member doesn't get blocked by (or block) an
// unrelated in-flight rename/add/remove.
const triggering = computed(() => groups.loadingIds.has(props.groupId));

const members = computed(() => (group.value?.participantIds || []).map((id) => world.charactersById[id]).filter(Boolean));
// Same "known" pool NewGroupForm.vue uses, minus whoever's already in the group.
const candidates = computed(() => world.charactersList
  .filter((c) => world.knowsUser(c.id) && !(group.value?.participantIds || []).includes(c.id)));

async function saveName() {
  // The name-unchanged check alone isn't a re-entrancy guard: it compares
  // against group.value.name, which doesn't update until this same request
  // resolves — so pressing Enter (starts a save) then tabbing away (fires
  // @blur) before the response lands would otherwise pass this check twice
  // and fire a duplicate identical rename request.
  if (!group.value || name.value.trim() === group.value.name || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const { ok, data } = await groups.updateGroup(props.groupId, { name: name.value });
    if (!ok) { error.value = data.error || 'Could not rename the group.'; return; }
    status.value = 'Saved.';
  } finally {
    saving.value = false;
  }
}

// Same re-entrancy guard as saveName, and for the same reason: both
// compute their new participantIds array from group.value, which doesn't
// update until this same request resolves — two rapid clicks (e.g.
// removing two different members quickly) would otherwise both read the
// same stale array, and whichever request resolves last silently
// overwrites the roster, reverting the other change.
async function addMember() {
  if (!addingId.value || !group.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const { ok, data } = await groups.updateGroup(props.groupId, {
      participantIds: [...group.value.participantIds, addingId.value],
    });
    if (!ok) error.value = data.error || 'Could not add them.';
    addingId.value = '';
  } finally {
    saving.value = false;
  }
}

async function removeMember(id) {
  if (!group.value || saving.value) return;
  const remaining = group.value.participantIds.filter((pid) => pid !== id);
  if (remaining.length < 2) { error.value = 'A group needs at least 2 participants.'; return; }
  saving.value = true;
  error.value = '';
  try {
    const { ok, data } = await groups.updateGroup(props.groupId, { participantIds: remaining });
    if (!ok) error.value = data.error || 'Could not remove them.';
  } finally {
    saving.value = false;
  }
}

// Random-member nudge lives here too (not just per-member) since this
// panel is the one place the full roster is visible at a glance.
function nudgeRandom() {
  if (!group.value || triggering.value) return;
  groups.triggerText(props.groupId);
}
function nudgeMember(id) {
  if (triggering.value) return;
  groups.triggerText(props.groupId, id);
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
        <span
          class="phone-nudge-btn" role="button" tabindex="0"
          :aria-disabled="triggering" title="Nudge them to text the group now" @click="nudgeMember(m.id)"
        >📨</span>
        <button class="chip-remove" type="button" title="Remove from group" :disabled="saving" @click="removeMember(m.id)">✕</button>
      </div>
    </div>

    <div class="endpoint-row" v-if="candidates.length">
      <select v-model="addingId" style="flex:1;">
        <option value="">+ Add someone…</option>
        <option v-for="c in candidates" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <button class="btn secondary small" :disabled="saving" @click="addMember">Add</button>
    </div>

    <button class="btn secondary small" type="button" :disabled="triggering" @click="nudgeRandom">
      {{ triggering ? 'Texting…' : '📨 Nudge a random member' }}
    </button>

    <span class="new-group-error" v-if="error">{{ error }}</span>
    <span class="form-status" v-if="status">{{ status }}</span>
  </div>
</template>

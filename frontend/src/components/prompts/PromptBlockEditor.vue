<script setup>
// Mutates `block` in place — it's the same reactive object living inside
// the parent PresetCard's draft.prompts array, not a copy, so edits here
// are exactly equivalent to editing the draft directly.
const props = defineProps({
  block: { type: Object, required: true },
  index: { type: Number, required: true },
  total: { type: Number, required: true },
  markerLabel: { type: String, default: null },
});
const emit = defineEmits(['move-up', 'move-down', 'remove']);
</script>

<template>
  <div class="prompt-block" :class="{ marker: block.marker }">
    <div class="prompt-block-top">
      <label class="enable-toggle"><input type="checkbox" v-model="block.enabled"> on</label>
      <input type="text" class="prompt-name-input" v-model="block.name">
      <select v-if="!block.marker" v-model="block.role">
        <option value="system">system</option>
        <option value="user">user</option>
        <option value="assistant">assistant</option>
      </select>
      <div class="prompt-block-actions">
        <button :disabled="index === 0" title="Move up" @click="emit('move-up')">↑</button>
        <button :disabled="index === total - 1" title="Move down" @click="emit('move-down')">↓</button>
        <button class="danger" title="Remove block" @click="emit('remove')">✕</button>
      </div>
    </div>
    <div class="marker-note" v-if="block.marker">
      Placeholder · {{ markerLabel ? 'filled with: ' + markerLabel : 'not used in Freeroam, left empty' }}
    </div>
    <textarea
      v-else class="prompt-content" v-model="block.content"
      placeholder="Prompt text. {{user}} and {{char}} are supported."
    ></textarea>
  </div>
</template>

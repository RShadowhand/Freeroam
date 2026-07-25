<script setup>
import { ref } from 'vue';

// SillyTavern's "editor_maximize" pattern (their .editor_maximize icon +
// callGenericPopup) — a small expand button next to a textarea pops the
// same text into a big modal for comfortable editing, instead of trying
// to make every inline box huge. v-model keeps the inline textarea and
// the modal's textarea trivially in sync (both just bind the same ref);
// ST needs a manual input-listener to bridge two real DOM elements, Vue
// doesn't.
defineOptions({ inheritAttrs: false });
defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
});
defineEmits(['update:modelValue']);
const expanded = ref(false);
</script>

<template>
  <div class="expandable-textarea">
    <textarea
      v-bind="$attrs"
      :value="modelValue" @input="$emit('update:modelValue', $event.target.value)"
      :placeholder="placeholder"
    ></textarea>
    <button type="button" class="expand-toggle" title="Expand the editor" @click="expanded = true">⛶</button>
  </div>

  <div class="modal-overlay" v-if="expanded" @click="(e) => { if (e.target === e.currentTarget) expanded = false; }">
    <div class="modal wide editor-modal">
      <textarea
        class="editor-modal-textarea" autofocus
        :value="modelValue" @input="$emit('update:modelValue', $event.target.value)"
        :placeholder="placeholder"
      ></textarea>
      <div class="modal-tab-foot">
        <button class="btn" type="button" @click="expanded = false">Done</button>
      </div>
    </div>
  </div>
</template>

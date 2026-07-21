<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat';

const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const text = ref(props.message.text);
const textareaEl = ref(null);

// Plain scrollHeight measurement rather than relying on the CSS
// field-sizing:content property — that's brand new and inconsistently
// supported (SillyTavern itself only uses it behind a CSS.supports()
// check, with this same JS as its own fallback), where this technique
// has worked identically in every browser for well over a decade.
function autoResize() {
  if (!textareaEl.value) return;
  textareaEl.value.style.height = 'auto';
  textareaEl.value.style.height = `${textareaEl.value.scrollHeight}px`;
}
onMounted(() => nextTick(autoResize));

function save() {
  const trimmed = text.value.trim();
  if (!trimmed) return;
  chat.saveMessageEdit(props.message.id, trimmed);
}
function cancel() {
  chat.editingMessageId = null;
}
</script>

<template>
  <div class="msg-edit-wrap">
    <div class="msg-edit-actions">
      <button class="btn small" @click="save">Save</button>
      <button class="btn secondary small" @click="cancel">Cancel</button>
    </div>
    <textarea ref="textareaEl" class="msg-edit-textarea" v-model="text" @input="autoResize"></textarea>
    <div class="msg-edit-actions">
      <button class="btn small" @click="save">Save</button>
      <button class="btn secondary small" @click="cancel">Cancel</button>
    </div>
  </div>
</template>

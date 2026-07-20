<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat';

const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const text = ref(props.message.text);
const textareaEl = ref(null);

// field-sizing:content (see main.css) handles auto-grow natively where
// supported; this only does anything on browsers without it yet.
const supportsFieldSizing = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
function autoResize() {
  if (supportsFieldSizing || !textareaEl.value) return;
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
  <textarea ref="textareaEl" class="msg-edit-textarea" v-model="text" @input="autoResize"></textarea>
  <div class="msg-edit-actions">
    <button class="btn small" @click="save">Save</button>
    <button class="btn secondary small" @click="cancel">Cancel</button>
  </div>
</template>

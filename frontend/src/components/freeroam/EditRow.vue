<script setup>
import { ref } from 'vue';
import { useChatStore } from '../../stores/chat';

const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const text = ref(props.message.text);

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
  <textarea class="msg-edit-textarea" v-model="text"></textarea>
  <div class="msg-edit-actions">
    <button class="btn small" @click="save">Save</button>
    <button class="btn secondary small" @click="cancel">Cancel</button>
  </div>
</template>

<script setup>
import { useChatStore } from '../../stores/chat';

// Edit/delete apply to any persisted user or character line; both are
// backend-synced (PUT/DELETE /messages/:id), which rebuilds every
// character's memory that witnessed the affected entry to match.
const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();

function del() {
  if (confirm('Delete this message? Linked memories will be updated to match.')) chat.deleteMessage(props.message.id);
}
</script>

<template>
  <template v-if="message.id && (message.type === 'user' || message.type === 'char' || message.type === 'narrator')">
    <button class="msg-edit-btn" title="Edit" @click="chat.editingMessageId = message.id">✎</button>
    <button class="msg-delete-btn" title="Delete" @click="del">🗑</button>
  </template>
</template>

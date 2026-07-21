<script setup>
import { computed } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';
import EditRow from './EditRow.vue';
import MessageActions from './MessageActions.vue';

const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const theme = useThemeStore();

const isEditing = computed(() => props.message.id && props.message.id === chat.editingMessageId);
const html = computed(() => formatMessage(props.message.text, theme.format));
</script>

<template>
  <div class="msg narrator" :class="{ editing: isEditing, call: message.call }">
    <EditRow v-if="isEditing" :message="message" />
    <template v-else>
      <MessageActions :message="message" />
      <div class="narrator-text" v-html="html"></div>
    </template>
  </div>
</template>

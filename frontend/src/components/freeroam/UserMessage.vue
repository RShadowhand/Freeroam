<script setup>
import { computed } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';
import EditRow from './EditRow.vue';
import MessageActions from './MessageActions.vue';

const props = defineProps({
  message: { type: Object, required: true },
  isLast: { type: Boolean, default: false },
});
const chat = useChatStore();
const theme = useThemeStore();

const isEditing = computed(() => props.message.id && props.message.id === chat.editingMessageId);
const html = computed(() => formatMessage(props.message.text, theme.format));
// Nothing followed this message — every reply was deleted, or generation
// produced nothing (e.g. an endpoint error) — offer to send it again as if
// it had just been typed.
const showRetry = computed(() => props.isLast && !chat.streamingState);
</script>

<template>
  <div class="msg user">
    <EditRow v-if="isEditing" :message="message" />
    <template v-else>
      <div class="bubble" v-html="html"></div>
      <div class="msg-actions">
        <MessageActions :message="message" />
        <button
          v-if="showRetry" class="retry-btn"
          title="No reply yet — try sending this again" @click="chat.retryMessage()"
        >↻ Retry</button>
      </div>
    </template>
  </div>
</template>

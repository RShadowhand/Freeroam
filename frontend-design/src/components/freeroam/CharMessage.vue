<script setup>
import { computed } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { useQuickMoveMenu } from '../../composables/useQuickMoveMenu';
import { formatMessage } from '../../utils/format';
import Avatar from '../shared/Avatar.vue';
import EditRow from './EditRow.vue';
import MessageActions from './MessageActions.vue';
import ReasoningBlock from './ReasoningBlock.vue';
import MessageStats from './MessageStats.vue';
import SuggestionChips from './SuggestionChips.vue';

const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const theme = useThemeStore();
const quickMove = useQuickMoveMenu();

const isEditing = computed(() => props.message.id && props.message.id === chat.editingMessageId);
const html = computed(() => formatMessage(props.message.text, theme.format));

function onQuickMoveClick(e) {
  quickMove.toggle(props.message.id, props.message.charId, e.currentTarget);
}
</script>

<template>
  <div class="msg char" :class="{ editing: isEditing, call: message.call }">
    <EditRow v-if="isEditing" :message="message" />
    <template v-else>
      <div class="msg-avatar">
        <Avatar :char-id="message.charId" :size="38" />
        <button
          v-if="message.id && message.charId && !message.call" class="quick-move-trigger"
          :class="{ active: quickMove.openForMessageId.value === message.id }"
          title="Step back, send elsewhere, or go with them" @click="onQuickMoveClick"
        >⋯</button>
      </div>
      <div class="msg-body">
        <div class="speaker">
          {{ message.name }}
          <button v-if="message.id && message.charId && !message.call" class="regen-btn" title="Regenerate this message" @click="chat.regenerateMessage(message.id)">↻</button>
          <MessageActions :message="message" />
        </div>
        <ReasoningBlock :message="message" />
        <div class="bubble" v-html="html"></div>
        <MessageStats :stats="message.stats" />
        <SuggestionChips :message="message" />
      </div>
    </template>
  </div>
</template>

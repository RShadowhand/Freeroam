<script setup>
import { computed } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { useNpcModal } from '../../composables/useNpcModal';
import { formatMessage } from '../../utils/format';
import EditRow from './EditRow.vue';
import MessageActions from './MessageActions.vue';
import ReasoningBlock from './ReasoningBlock.vue';
import MessageStats from './MessageStats.vue';
import SuggestionChips from './SuggestionChips.vue';

const props = defineProps({
  message: { type: Object, required: true },
  offerSave: { type: Boolean, default: false },
});
const chat = useChatStore();
const theme = useThemeStore();
const npcModal = useNpcModal();

const isEditing = computed(() => props.message.id && props.message.id === chat.editingMessageId);
const html = computed(() => formatMessage(props.message.text, theme.format));
</script>

<template>
  <div class="msg char npc" :class="{ editing: isEditing }">
    <EditRow v-if="isEditing" :message="message" />
    <template v-else>
      <div class="msg-avatar"><span class="npc-dot"></span></div>
      <div class="msg-body">
        <div class="speaker">
          {{ message.name }}
          <span class="npc-tag">new</span>
          <button v-if="offerSave" class="save-npc-btn" @click="npcModal.open({ name: message.name, placeId: chat.currentPlace })">+ Save as character</button>
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

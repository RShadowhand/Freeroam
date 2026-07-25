<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';
import Avatar from '../shared/Avatar.vue';
import MessageItem from './MessageItem.vue';

const chat = useChatStore();
const theme = useThemeStore();
const box = ref(null);

// Only offer "+ Save as character" once per NPC name per render, not once
// per line from that same (still-unsaved) NPC.
const offerSaveByIndex = computed(() => {
  const shown = new Set();
  return chat.currentLog.map((m) => {
    if (!m.isNPC) return false;
    const key = m.name.toLowerCase();
    const offer = !chat.savedNpcNames.has(key) && !shown.has(key);
    shown.add(key);
    return offer;
  });
});

const liveReasoningHtml = computed(() => chat.streamingState ? formatMessage(chat.streamingState.reasoning, theme.format) : '');
const liveTextHtml = computed(() => chat.streamingState ? formatMessage(chat.streamingState.text, theme.format) : '');

function scrollToBottom() {
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}

watch(
  () => [chat.currentLog.length, chat.streamingState?.text, chat.loading],
  () => nextTick(scrollToBottom),
  { flush: 'post' },
);
watch(() => chat.currentPlace, () => nextTick(scrollToBottom));
</script>

<template>
  <div class="messages" id="messages" ref="box">
    <MessageItem
      v-for="(m, i) in chat.currentLog" :key="m.id || i"
      :message="m" :is-last="i === chat.currentLog.length - 1" :offer-save="offerSaveByIndex[i]"
    />
    <div class="msg char" v-if="chat.streamingState">
      <div class="msg-avatar"><Avatar :char-id="chat.streamingState.charId" :size="38" /></div>
      <div class="msg-body">
        <div class="speaker">{{ chat.streamingState.name }}</div>
        <div class="reasoning-text reasoning-live" v-if="chat.streamingState.reasoning" v-html="liveReasoningHtml"></div>
        <div class="bubble" v-html="liveTextHtml"></div>
      </div>
    </div>
    <div class="typing" v-else-if="chat.loading">...someone stirs</div>
  </div>
</template>

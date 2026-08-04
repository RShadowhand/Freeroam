<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';
import { dayDividerLabels } from '../../utils/time';
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

// A trailing generation-failure error (type 'error', client-only, never
// persisted — see stores/chat.js) shouldn't hide the Retry button on the
// user message it followed; scan back past any of those to find the last
// *real* entry. isLast is only ever consumed by UserMessage.vue's retry
// button, so this redefinition is safely scoped.
const lastRealIndex = computed(() => {
  const log = chat.currentLog;
  for (let i = log.length - 1; i >= 0; i--) { if (log[i].type !== 'error') return i; }
  return -1;
});

// A date divider wherever day/timeOfDay changes from the previous entry —
// a room's log can span many in-world days between visits, and there was
// previously no way to tell when a given message was actually said. Scene
// chat keeps the sparse-divider approach; PhoneThread.vue/GroupThread.vue
// moved to a per-message timestamp instead (per feedback that the divider
// alone was too easy to miss there) — see their own use of formatDayTime.
const dividerLabels = computed(() => dayDividerLabels(chat.currentLog));

function scrollToBottom() {
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}

watch(
  () => [chat.currentLog.length, chat.streamingState?.text, chat.loading],
  () => nextTick(scrollToBottom),
  { flush: 'post' },
);
watch(() => chat.currentPlace, () => nextTick(scrollToBottom));
// The watchers above only fire on a *subsequent* change to the log/place —
// neither fires on this component's own first mount (e.g. navigating back
// to Freeroam from another tab remounts this component fresh, with the
// same already-loaded log/place it had before, so nothing actually
// "changes" reactively). Watching the ref itself catches that: it flips
// from null to the element exactly once, the moment this container is
// first attached to the DOM, regardless of whether the underlying data
// changed — the one case those two watchers can't see.
watch(box, (el) => { if (el) nextTick(scrollToBottom); });
</script>

<template>
  <div class="messages" id="messages" ref="box">
    <template v-for="(m, i) in chat.currentLog" :key="m.id || i">
      <div class="chat-day-divider" v-if="dividerLabels[i]">{{ dividerLabels[i] }}</div>
      <MessageItem :message="m" :is-last="i === lastRealIndex" :offer-save="offerSaveByIndex[i]" />
    </template>
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

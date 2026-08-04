<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { usePhoneStore } from '../../stores/phone';
import { useSettingsStore } from '../../stores/settings';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';
import { formatDayTime } from '../../utils/time';
import CardAvatar from '../shared/CardAvatar.vue';

// Calling lives in its own app (Wavelength) now, not a button bolted onto
// a text thread — matches a real phone's Messages/Phone app split.
const props = defineProps({ characterId: { type: String, required: true } });
const emit = defineEmits(['back']);

const world = useWorldStore();
const phone = usePhoneStore();
const settings = useSettingsStore();
const theme = useThemeStore();

const character = computed(() => world.charactersById[props.characterId]);
const log = computed(() => phone.logs[props.characterId] || []);
const text = ref('');
const box = ref(null);
const textareaEl = ref(null);

// A generic "..." bubble, not a live character-by-character reveal — see
// stores/phone.js for why. Only shows when the setting is on AND
// streaming actually is (it silently no-ops otherwise; TextingCard.vue
// carries the "needs streaming" warning, not this component).
const showTyping = computed(() => (
  settings.textingTypingIndicator && settings.streaming
  && phone.streamingState && phone.streamingState.characterId === props.characterId
));

// Whether THIS conversation (not some other one) has a send/retry in
// flight — phone.js tracks loadingIds per-characterId precisely so a
// different open thread's request can't make this one look busy.
const isLoadingHere = computed(() => phone.loadingIds.has(props.characterId));

// Every message shows its own in-world day/time — a texting conversation
// can span many in-world days, unlike a single scene visit, and a sparse
// divider between changes turned out to be too easy to miss (per feedback:
// each message should carry it, not just the boundary). Older history with
// no day/timeOfDay stamp just shows nothing, same "no backfill" rule as
// before.
function timestamp(m) {
  return m.day != null ? formatDayTime(m.day, m.timeOfDay) : '';
}

// A trailing generation-failure error (type 'error', client-only, never
// persisted — see stores/phone.js) shouldn't hide Retry on the user message
// it followed; scan back past any of those to find the last *real* entry.
const lastRealIndex = computed(() => {
  const l = log.value;
  for (let i = l.length - 1; i >= 0; i--) { if (l[i].type !== 'error') return i; }
  return -1;
});

// Nothing replied to the trailing message yet — same "offer to try again"
// condition place chat's UserMessage.vue and GroupThread.vue both use.
// Only THIS conversation's own streaming state should hide Retry — a
// different conversation streaming at the same time must not.
const showRetry = computed(() => {
  const idx = lastRealIndex.value;
  const streamingHere = phone.streamingState && phone.streamingState.characterId === props.characterId;
  return idx >= 0 && log.value[idx].type === 'user' && !streamingHere;
});

function html(t) {
  return formatMessage(t, theme.format);
}
function scrollToBottom() {
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}
watch(() => [log.value.length, isLoadingHere.value], () => nextTick(scrollToBottom), { flush: 'post' });
// openThread()'s own scrollToBottom call below can run before .messages
// actually exists in the DOM (its container is gated by v-if="character",
// which may not have flipped true yet at mount time) — watching the ref
// itself catches the exact moment it's first attached, regardless of that
// timing, the same fix applied to MessageList.vue.
watch(box, (el) => { if (el) nextTick(scrollToBottom); });

async function openThread() {
  await phone.openConversation(props.characterId);
  nextTick(scrollToBottom);
}
onMounted(openThread);
watch(() => props.characterId, openThread);

function autoGrow() {
  const el = textareaEl.value;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

async function send() {
  const value = text.value.trim();
  if (!value || isLoadingHere.value) return;
  text.value = '';
  if (textareaEl.value) textareaEl.value.style.height = 'auto';
  await phone.sendText(props.characterId, value);
}
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // Shift+Enter still inserts a real newline
    send();
  }
}

function deleteMessage(entryId) {
  if (!entryId) return;
  if (confirm('Delete this message? Linked memories will be updated to match.')) {
    phone.deleteMessage(props.characterId, entryId);
  }
}
function retry() {
  phone.retryText(props.characterId);
}
function stop() {
  phone.cancelText(props.characterId);
}
function dismissError(entryId) {
  phone.removeError(props.characterId, entryId);
}
</script>

<template>
  <div class="phone-thread" v-if="character">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('back')">‹ Contacts</button>
      <CardAvatar :name="character.name" :avatar-url="character.avatarUrl" :color="character.color" />
      <span class="phone-thread-name">{{ character.name }}</span>
    </div>

    <div class="messages" ref="box">
      <div class="empty-note" v-if="!log.length">No messages yet — say hello.</div>
      <template v-for="(m, i) in log" :key="m.id || i">
        <div class="msg error" v-if="m.type === 'error'">
          {{ m.text }}
          <button class="msg-delete-btn error-dismiss" title="Dismiss" @click="dismissError(m.id)">✕</button>
        </div>
        <div class="msg" :class="m.type === 'user' ? 'user' : 'char'" v-else>
          <div class="msg-bubble-col">
            <div class="bubble" v-html="html(m.text)"></div>
            <div class="msg-timestamp" v-if="timestamp(m)">{{ timestamp(m) }}</div>
          </div>
          <div class="msg-actions">
            <button v-if="m.id" class="msg-delete-btn" title="Delete" @click="deleteMessage(m.id)">🗑</button>
            <button
              v-if="m.type === 'user' && i === lastRealIndex && showRetry" class="retry-btn"
              title="No reply yet — try sending this again" @click="retry"
            >↻ Retry</button>
          </div>
        </div>
      </template>
      <div class="msg char" v-if="showTyping"><div class="bubble typing-bubble">…</div></div>
      <div class="typing" v-else-if="isLoadingHere">typing…</div>
    </div>

    <div class="input-row">
      <textarea
        ref="textareaEl" v-model="text" rows="1" autocomplete="off"
        placeholder="Text something... (Shift+Enter for a new line)"
        :disabled="isLoadingHere"
        @input="autoGrow" @keydown="onKeydown"
      ></textarea>
      <button v-if="isLoadingHere" class="stop-btn" @click="stop">Stop</button>
      <button v-else @click="send">Send</button>
    </div>
  </div>
</template>

<style scoped>
.stop-btn{ background:var(--rose); color:var(--parchment); }
/* .msg.char is display:flex (see main.css) for the scene-chat avatar+body
   layout — a plain-column wrapper here keeps the bubble and its timestamp
   stacked regardless of what the shared .msg/.msg.char/.msg.user rules do,
   instead of the timestamp becoming a third item squeezed into that row. */
.msg-bubble-col{ display:flex; flex-direction:column; min-width:0; }
.msg-timestamp{
  font-family:'IBM Plex Mono',monospace; font-size:0.62rem; letter-spacing:0.02em;
  color:var(--dim); opacity:0.75; margin-top:2px;
}
.msg.user .msg-timestamp{ text-align:right; }
</style>

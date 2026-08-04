<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useGroupsStore } from '../../stores/groups';
import { useSettingsStore } from '../../stores/settings';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';
import { formatDayTime } from '../../utils/time';
import CardAvatar from '../shared/CardAvatar.vue';
import GroupInfoPanel from './GroupInfoPanel.vue';

const props = defineProps({ groupId: { type: String, required: true } });
const emit = defineEmits(['back']);

const world = useWorldStore();
const groups = useGroupsStore();
const settings = useSettingsStore();
const theme = useThemeStore();

const group = computed(() => groups.groups.find((g) => g.id === props.groupId));
const log = computed(() => groups.logs[props.groupId] || []);
const text = ref('');
const box = ref(null);
const textareaEl = ref(null);
const showInfo = ref(false);

// Same generic "..." bubble as 1-on-1 texting (PhoneThread.vue) — only
// shows when the setting AND streaming are both actually on.
const showTyping = computed(() => (
  settings.textingTypingIndicator && settings.streaming
  && groups.streamingState && groups.streamingState.groupId === props.groupId
));
// Guarded by groupId, not just truthiness — groups.streamingState is one
// piece of shared store state, so without this check, switching to a
// different group while a send is still in flight elsewhere would show
// that OTHER group's speaker name here.
const typingName = computed(() => (
  groups.streamingState && groups.streamingState.groupId === props.groupId ? groups.streamingState.name : ''
));

// Whether THIS group's conversation (not some other one) has a send/retry
// in flight — groups.js tracks loadingIds per-groupId precisely so a
// different open thread's request can't make this one look busy.
const isLoadingHere = computed(() => groups.loadingIds.has(props.groupId));

// Every message shows its own in-world day/time — see PhoneThread.vue's
// identical use of formatDayTime and its comment for why this replaced an
// earlier sparse-divider-only approach.
function timestamp(m) {
  return m.day != null ? formatDayTime(m.day, m.timeOfDay) : '';
}

// A trailing generation-failure error (type 'error', client-only, never
// persisted — see stores/groups.js) shouldn't hide Retry on the user
// message it followed; scan back past any of those to find the last *real*
// entry.
const lastRealIndex = computed(() => {
  const l = log.value;
  for (let i = l.length - 1; i >= 0; i--) { if (l[i].type !== 'error') return i; }
  return -1;
});

// Nothing replied to the trailing message yet — same "offer to try again"
// condition place chat's UserMessage.vue uses for its own retry button.
// Only THIS group's own streaming state should hide Retry — a different
// group streaming at the same time must not.
const showRetry = computed(() => {
  const idx = lastRealIndex.value;
  const streamingHere = groups.streamingState && groups.streamingState.groupId === props.groupId;
  return idx >= 0 && log.value[idx].type === 'user' && !streamingHere;
});

function charName(charId) {
  return world.charactersById[charId]?.name || charId;
}
function html(t) {
  return formatMessage(t, theme.format);
}
function scrollToBottom() {
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}
watch(() => [log.value.length, isLoadingHere.value], () => nextTick(scrollToBottom), { flush: 'post' });
// openThread()'s own scrollToBottom call below can run before .messages
// actually exists in the DOM (its container is gated by v-else-if="group",
// and also toggles away entirely behind showInfo's v-if) — watching the ref
// itself catches the exact moment it's (re-)attached, the same fix applied
// to MessageList.vue/PhoneThread.vue.
watch(box, (el) => { if (el) nextTick(scrollToBottom); });

async function openThread() {
  await groups.openConversation(props.groupId);
  nextTick(scrollToBottom);
}
onMounted(openThread);
watch(() => props.groupId, openThread);

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
  await groups.sendText(props.groupId, value);
}
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function deleteMessage(entryId) {
  if (!entryId) return;
  if (confirm('Delete this message? Linked memories will be updated to match.')) {
    groups.deleteMessage(props.groupId, entryId);
  }
}
function retry() {
  groups.retryText(props.groupId);
}
function stop() {
  groups.cancelText(props.groupId);
}
function dismissError(entryId) {
  groups.removeError(props.groupId, entryId);
}
</script>

<template>
  <GroupInfoPanel v-if="showInfo" :group-id="groupId" @back="showInfo = false" />
  <div class="phone-thread" v-else-if="group">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('back')">‹ Contacts</button>
      <span class="group-icon">👥</span>
      <span class="phone-thread-name">{{ group.name }}</span>
      <button class="phone-info-btn" type="button" title="Group info" @click="showInfo = true">ⓘ</button>
    </div>

    <div class="messages" ref="box">
      <div class="empty-note" v-if="!log.length">No messages yet — say hello to the group.</div>
      <template v-for="(m, i) in log" :key="m.id || i">
        <div class="msg error" v-if="m.type === 'error'">
          {{ m.text }}
          <button class="msg-delete-btn error-dismiss" title="Dismiss" @click="dismissError(m.id)">✕</button>
        </div>
        <div class="msg user" v-else-if="m.type === 'user'">
          <div class="msg-bubble-col">
            <div class="bubble" v-html="html(m.text)"></div>
            <div class="msg-timestamp" v-if="timestamp(m)">{{ timestamp(m) }}</div>
          </div>
          <div class="msg-actions">
            <button v-if="m.id" class="msg-delete-btn" title="Delete" @click="deleteMessage(m.id)">🗑</button>
            <button
              v-if="i === lastRealIndex && showRetry" class="retry-btn"
              title="No reply yet — try sending this again" @click="retry"
            >↻ Retry</button>
          </div>
        </div>
        <div class="msg char group-char" v-else>
          <CardAvatar :name="charName(m.charId)" :avatar-url="world.charactersById[m.charId]?.avatarUrl" :color="world.charactersById[m.charId]?.color" />
          <div class="group-char-body">
            <div class="speaker">{{ m.name || charName(m.charId) }}</div>
            <div class="bubble" v-html="html(m.text)"></div>
            <div class="msg-timestamp" v-if="timestamp(m)">{{ timestamp(m) }}</div>
            <div class="msg-actions">
              <button v-if="m.id" class="msg-delete-btn" title="Delete" @click="deleteMessage(m.id)">🗑</button>
            </div>
          </div>
        </div>
      </template>
      <div class="msg char group-char" v-if="showTyping">
        <div class="group-char-body">
          <div class="speaker">{{ typingName }}</div>
          <div class="bubble typing-bubble">…</div>
        </div>
      </div>
      <div class="typing" v-else-if="isLoadingHere">
        <template v-if="typingName">{{ typingName }} is typing…</template>
        <template v-else>typing…</template>
      </div>
    </div>

    <div class="input-row">
      <textarea
        ref="textareaEl" v-model="text" rows="1" autocomplete="off"
        placeholder="Text the group... (Shift+Enter for a new line)"
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
   layout — a plain-column wrapper here keeps the user bubble and its
   timestamp stacked regardless of what the shared .msg/.msg.user rules do.
   The group-char branch doesn't need this: .group-char-body is already a
   plain block column. */
.msg-bubble-col{ display:flex; flex-direction:column; min-width:0; }
.msg-timestamp{
  font-family:'IBM Plex Mono',monospace; font-size:0.62rem; letter-spacing:0.02em;
  color:var(--dim); opacity:0.75; margin-top:2px;
}
.msg.user .msg-timestamp{ text-align:right; }
</style>

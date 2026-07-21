<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { usePhoneStore } from '../../stores/phone';
import { useSettingsStore } from '../../stores/settings';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';
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

function html(t) {
  return formatMessage(t, theme.format);
}
function scrollToBottom() {
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}
watch(() => [log.value.length, phone.loading], () => nextTick(scrollToBottom), { flush: 'post' });

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
  if (!value || phone.loading) return;
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
        <div class="msg error" v-if="m.type === 'error'">{{ m.text }}</div>
        <div class="msg" :class="m.type === 'user' ? 'user' : 'char'" v-else>
          <div class="bubble" v-html="html(m.text)"></div>
        </div>
      </template>
      <div class="msg char" v-if="showTyping"><div class="bubble typing-bubble">…</div></div>
      <div class="typing" v-else-if="phone.loading">typing…</div>
    </div>

    <div class="input-row">
      <textarea
        ref="textareaEl" v-model="text" rows="1" autocomplete="off"
        placeholder="Text something... (Shift+Enter for a new line)"
        :disabled="phone.loading"
        @input="autoGrow" @keydown="onKeydown"
      ></textarea>
      <button :disabled="phone.loading" @click="send">Send</button>
    </div>
  </div>
</template>

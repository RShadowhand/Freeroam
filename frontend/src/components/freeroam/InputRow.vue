<script setup>
import { ref } from 'vue';
import { useChatStore } from '../../stores/chat';

const chat = useChatStore();
const text = ref('');
const textareaEl = ref(null);

// Grows the textarea to fit wrapped text (up to the CSS max-height, after
// which it scrolls internally) instead of staying a fixed single-line box.
function autoGrow() {
  const el = textareaEl.value;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

async function send() {
  const value = text.value.trim();
  if (!value || chat.loading || chat.entering || chat.currentPlace === null) return;
  text.value = '';
  if (textareaEl.value) textareaEl.value.style.height = 'auto'; // collapse back to one line
  await chat.sendMessage(value);
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // Shift+Enter still inserts a real newline
    send();
  }
}
</script>

<template>
  <div class="input-row">
    <textarea
      ref="textareaEl" v-model="text" rows="1" autocomplete="off"
      placeholder="Say something... (Shift+Enter for a new line)"
      :disabled="chat.loading"
      @input="autoGrow" @keydown="onKeydown"
    ></textarea>
    <button v-if="chat.isGenerating" class="stop-btn" @click="chat.cancelGeneration()">Stop</button>
    <button v-else :disabled="chat.loading" @click="send">Send</button>
  </div>
</template>

<style scoped>
.stop-btn{ background:var(--rose); color:var(--parchment); }
</style>

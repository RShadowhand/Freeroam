<script setup>
import { ref } from 'vue';
import { useUiStore } from '../../stores/ui';
import { sendTestMessage } from '../../api/settings';

const ui = useUiStore();
const sending = ref(false);
const output = ref('');

async function test() {
  sending.value = true;
  output.value = 'Sending test message…';
  try {
    const { ok, data } = await sendTestMessage();
    if (!ok) throw new Error(data.error || 'request failed');
    output.value = `✓ (${data.model})\n${data.text}`;
  } catch (err) {
    output.value = `✗ ${err.message}`;
    ui.showError(`Test connection failed: ${err.message}`);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="settings-card">
    <h2>Test connection</h2>
    <p class="hint">Sends one short message through your backend to confirm the key and model work.</p>
    <button class="btn" :disabled="sending" @click="test">Send test message</button>
    <div class="test-output">{{ output }}</div>
  </div>
</template>

<script setup>
import MessageList from './MessageList.vue';
import InputRow from './InputRow.vue';
import CallBar from './CallBar.vue';
</script>

<template>
  <div class="chat-panel">
    <CallBar />
    <MessageList />
    <InputRow />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { formatMessage } from '../../utils/format';

const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const theme = useThemeStore();

const expanded = computed(() => chat.expandedReasoningIds.has(props.message.id));
const html = computed(() => formatMessage(props.message.reasoning, theme.format));
</script>

<template>
  <template v-if="message.reasoning">
    <button class="reasoning-toggle" type="button" @click="chat.toggleReasoning(message.id)">
      {{ expanded ? 'Hide thinking' : 'Show thinking' }}
    </button>
    <div class="reasoning-text" v-if="expanded" v-html="html"></div>
  </template>
</template>

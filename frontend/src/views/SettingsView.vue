<script setup>
import { onMounted } from 'vue';
import { useSettingsStore } from '../stores/settings';
import Brand from '../components/shared/Brand.vue';
import EndpointCard from '../components/settings/EndpointCard.vue';
import MemoryCard from '../components/settings/MemoryCard.vue';
import SuggestedActionsCard from '../components/settings/SuggestedActionsCard.vue';
import ModelCard from '../components/settings/ModelCard.vue';
import DraftPersonaPromptCard from '../components/settings/DraftPersonaPromptCard.vue';
import TestConnectionCard from '../components/settings/TestConnectionCard.vue';
import MessageFormattingCard from '../components/settings/MessageFormattingCard.vue';
import ThemeCard from '../components/settings/ThemeCard.vue';

const settings = useSettingsStore();

onMounted(async () => {
  await settings.load();
  await settings.loadModels();
});
</script>

<template>
  <section id="view-settings" class="view">
    <Brand tag="keys · endpoint · models · prompts" />
    <EndpointCard />
    <MemoryCard />
    <SuggestedActionsCard />
    <ModelCard />
    <DraftPersonaPromptCard />
    <TestConnectionCard />
    <MessageFormattingCard />
    <ThemeCard />
  </section>
</template>

<script setup>
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
</script>

<template>
  <div class="settings-card">
    <h2>Narrator</h2>
    <p class="hint">
      An ambient world-voice that fills in the scene: an empty place, a solo conversation that could use a little texture, or
      a crowd where some present characters aren't part of the conversation right now (see "step back" in the quick-move
      menu, or the ● toggle on a present character's chip). It's an extra generation call, off the fast path — only fires
      when there's actually something worth adding, and never speaks for anyone in the conversation.
    </p>
    <div class="checkbox-field">
      <input type="checkbox" id="narratorEnabled" v-model="settings.narratorEnabled" @change="settings.setNarratorEnabled(settings.narratorEnabled)">
      <label for="narratorEnabled">Enable the narrator</label>
    </div>
  </div>
</template>

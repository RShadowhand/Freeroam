<script setup>
import { useThemeStore } from '../../stores/theme';

const theme = useThemeStore();
</script>

<template>
  <div class="settings-card">
    <h2>Message formatting</h2>
    <p class="hint">SillyTavern-style formatting for chat bubbles — these just turn each rule on or off; pick their colors below in Theme. Saved in this browser only.</p>
    <div class="checkbox-field">
      <input type="checkbox" id="fmtBold" v-model="theme.format.bold" @change="theme.setFormatFlag('bold', theme.format.bold)">
      <label for="fmtBold">**Bold**</label>
    </div>
    <div class="checkbox-field">
      <input type="checkbox" id="fmtItalics" v-model="theme.format.italics" @change="theme.setFormatFlag('italics', theme.format.italics)">
      <label for="fmtItalics">*Italics* (actions/gestures)</label>
    </div>
    <div class="checkbox-field">
      <input type="checkbox" id="fmtQuotes" v-model="theme.format.quotes" @change="theme.setFormatFlag('quotes', theme.format.quotes)">
      <label for="fmtQuotes">Highlight "quoted speech"</label>
    </div>
    <div class="checkbox-field">
      <input type="checkbox" id="fmtHideAngle" v-model="theme.format.hideAngleBrackets" @change="theme.setFormatFlag('hideAngleBrackets', theme.format.hideAngleBrackets)">
      <label for="fmtHideAngle">Hide &lt;bracketed&gt; tags</label>
    </div>
  </div>
</template>

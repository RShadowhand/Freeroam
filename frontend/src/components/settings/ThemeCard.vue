<script setup>
import { computed } from 'vue';
import { useThemeStore, FMT_BOLD_PICKER_DEFAULT, FMT_ITALIC_PICKER_DEFAULT } from '../../stores/theme';

const theme = useThemeStore();

// These pickers show a resolved color even when nothing's been customized
// yet (an empty fmt*Color means "follow the theme"), so the shown color
// never looks stale/wrong.
const boldColor = computed(() => theme.theme.fmtBoldColor || FMT_BOLD_PICKER_DEFAULT);
const italicColor = computed(() => theme.theme.fmtItalicColor || FMT_ITALIC_PICKER_DEFAULT);
const quoteColor = computed(() => theme.theme.fmtQuoteColor || theme.resolvedVar('--accent'));

function onThemeChange(e) {
  theme.setTheme(e.target.value);
}
function onAvatarShapeChange(e) {
  theme.setAvatarRadius(e.target.value);
}
</script>

<template>
  <div class="settings-card">
    <h2>Theme</h2>
    <p class="hint">Saved in this browser only.</p>
    <div class="field-row">
      <label>Color theme</label>
      <select :value="theme.theme.theme" @change="onThemeChange">
        <option value="amber">Amber (default)</option>
        <option value="rose">Rose</option>
        <option value="sage">Sage</option>
        <option value="violet">Violet</option>
        <option value="slate">Slate</option>
      </select>
    </div>
    <div class="field-row">
      <label>Avatar shape</label>
      <select :value="theme.theme.avatarRadius" @change="onAvatarShapeChange">
        <option value="50%">Circle</option>
        <option value="18%">Rounded square</option>
        <option value="4%">Square</option>
      </select>
    </div>
    <div class="theme-color-row">
      <label for="fmtBoldColor">**Bold** text color</label>
      <input type="color" id="fmtBoldColor" :value="boldColor" @input="theme.setFmtColor('fmtBoldColor', $event.target.value)">
    </div>
    <div class="theme-color-row">
      <label for="fmtItalicColor">*Italics* text color</label>
      <input type="color" id="fmtItalicColor" :value="italicColor" @input="theme.setFmtColor('fmtItalicColor', $event.target.value)">
    </div>
    <div class="theme-color-row">
      <label for="fmtQuoteColor">"Quote" text color</label>
      <input type="color" id="fmtQuoteColor" :value="quoteColor" @input="theme.setFmtColor('fmtQuoteColor', $event.target.value)">
    </div>
    <button class="btn secondary small" type="button" @click="theme.resetFmtColors()">Reset colors to theme default</button>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
const text = ref(settings.textingPromptTemplate);
const status = ref('');

// Keeps the textarea in sync after save()/reset() update the store (the
// backend is the source of truth for the "effective" text, e.g. falling
// back to the built-in default after a reset) — same pattern as
// DraftPersonaPromptCard.vue.
watch(() => settings.textingPromptTemplate, (v) => { text.value = v; });

async function save() {
  await settings.setTextingPromptTemplate(text.value.trim());
  status.value = 'Saved.';
}
async function reset() {
  await settings.resetTextingPromptTemplate();
  status.value = 'Reset to default.';
}

// Local drafts so typing in the number fields doesn't save on every
// keystroke — same idea as the prompt textarea's own Save button.
const cascadeBaseChance = ref(settings.cascadeBaseChance);
const cascadeDecayRate = ref(settings.cascadeDecayRate);
const cascadePerCharacterCap = ref(settings.cascadePerCharacterCap);
const cascadeStatus = ref('');
watch(() => [settings.cascadeBaseChance, settings.cascadeDecayRate, settings.cascadePerCharacterCap], ([b, d, c]) => {
  cascadeBaseChance.value = b; cascadeDecayRate.value = d; cascadePerCharacterCap.value = c;
});

async function saveCascade() {
  await settings.setCascadeSettings({
    cascadeBaseChance: Number(cascadeBaseChance.value),
    cascadeDecayRate: Number(cascadeDecayRate.value),
    cascadePerCharacterCap: Number(cascadePerCharacterCap.value),
  });
  cascadeStatus.value = 'Saved.';
}

// Displayed as a percentage (0.2%) rather than a raw 0.002 fraction —
// easier to reason about at these vanishingly small odds.
const textingChancePercent = ref(settings.textingChancePerChar * 100);
const proactiveStatus = ref('');
watch(() => settings.textingChancePerChar, (v) => { textingChancePercent.value = v * 100; });

async function saveProactiveChance() {
  await settings.setTextingChancePerChar(Number(textingChancePercent.value) / 100);
  proactiveStatus.value = 'Saved.';
}
</script>

<template>
  <div class="settings-card">
    <h2>Texting</h2>
    <p class="hint">
      Style instructions for how characters reply when texting (see the Phone tab) — separate from the main roleplay
      prompt, since a text message should read like a text message rather than a scene. Character description,
      personality, relevant memories, and relationships are still fed in automatically, same as a normal reply.
    </p>
    <textarea v-model="text" rows="5"></textarea>
    <div class="form-actions">
      <button class="btn small" @click="save">Save</button>
      <button class="btn secondary small" v-if="settings.textingPromptTemplateIsCustom" @click="reset">Reset to default</button>
      <span class="form-status">{{ status }}</span>
    </div>

    <div class="checkbox-field" style="margin-top:16px;">
      <input
        type="checkbox" id="textingTypingIndicator" v-model="settings.textingTypingIndicator"
        @change="settings.setTextingTypingIndicator(settings.textingTypingIndicator)"
      >
      <label for="textingTypingIndicator">Show a "typing…" indicator while a reply is coming in</label>
    </div>
    <p class="hint" v-if="settings.textingTypingIndicator && !settings.streaming">
      This needs <router-link to="/settings/connection">Streaming</router-link> turned on to do anything — it'll stay
      quietly off until then.
    </p>

    <h3 style="margin-top:18px;">Group text reply cascade</h3>
    <p class="hint">
      When someone sends a group text, other members have a chance to jump in too — each additional reply is less
      likely than the last, so a big group can't run forever. Tune it here; the shipped defaults are already
      calibrated (a 3-person group tends to bounce 3-5 messages total; a 6-person group averages ~0.7-0.8 replies per
      character), so most worlds shouldn't need to touch this.
    </p>
    <div class="endpoint-row">
      <label style="flex-shrink:0;">Base chance (0-1)</label>
      <input type="number" v-model="cascadeBaseChance" min="0" max="1" step="0.01" style="width:90px;">
    </div>
    <div class="endpoint-row">
      <label style="flex-shrink:0;">Decay rate per reply (0-1)</label>
      <input type="number" v-model="cascadeDecayRate" min="0" max="1" step="0.01" style="width:90px;">
    </div>
    <div class="endpoint-row">
      <label style="flex-shrink:0;">Max replies in a row per character</label>
      <input type="number" v-model="cascadePerCharacterCap" min="1" step="1" style="width:90px;">
    </div>
    <p class="hint">
      The default (2) lets a character send a quick follow-up right after their own line, like a real double-text —
      lower it to 1 if you'd rather nobody ever replies to themselves back-to-back.
    </p>
    <div class="form-actions">
      <button class="btn small" @click="saveCascade">Save</button>
      <span class="form-status">{{ cascadeStatus }}</span>
    </div>

    <h3 style="margin-top:18px;">Proactive texts</h3>
    <p class="hint">
      Each time you say something (in a place, or in a text thread), every character not already part of that
      exchange gets an independent, very low chance to text you out of the blue instead — asking for something, or
      sharing news. You can also nudge a specific character to text you right now from the Phone tab, skipping the
      dice entirely.
    </p>
    <div class="endpoint-row">
      <label style="flex-shrink:0;">Chance per character (%)</label>
      <input type="number" v-model="textingChancePercent" min="0" max="100" step="0.1" style="width:90px;">
    </div>
    <div class="form-actions">
      <button class="btn small" @click="saveProactiveChance">Save</button>
      <span class="form-status">{{ proactiveStatus }}</span>
    </div>
  </div>
</template>

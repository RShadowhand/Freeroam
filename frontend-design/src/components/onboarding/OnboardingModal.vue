<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useOnboardingModal } from '../../composables/useOnboardingModal';
import { useSettingsStore } from '../../stores/settings';
import { useWorldsStore } from '../../stores/worlds';
import { useWorldStore } from '../../stores/world';
import { setActivePersona } from '../../api/personas';
import EndpointCard from '../settings/EndpointCard.vue';
import UploadZone from '../cast/UploadZone.vue';
import AddPersonaForm from '../persona/AddPersonaForm.vue';

const onboarding = useOnboardingModal();
const settings = useSettingsStore();
const worlds = useWorldsStore();
const world = useWorldStore();
const router = useRouter();

const STEPS = ['welcome', 'connect', 'starting-point', 'add-character', 'add-persona', 'phone', 'done'];

const chosenStart = ref('demo'); // 'demo' | 'blank'
const blankWorldBusy = ref(false);
const blankWorldError = ref('');
// Captured fresh each time the modal opens (originalWorldId — the world
// active when onboarding started, so "Keep the demo world" can switch back
// to it) and reset (blankWorldId — memoizes the one blank world this pass
// creates, so toggling blank -> demo -> blank again just switches back
// instead of creating a fresh "My World (blank)" every time).
let originalWorldId = null;
const blankWorldId = ref(null);

// EndpointCard/UploadZone are driven entirely by the settings/world stores,
// neither of which is guaranteed loaded yet — SettingsView/SystemView are
// the only other callers of settings.load(), and world.loadWorldState() is
// normally triggered by whichever view the user routes to. This modal can
// render before any of those ever have, so it loads both itself.
watch(() => onboarding.isOpen.value, (open) => {
  if (!open) return;
  settings.load();
  world.loadWorldState();
  originalWorldId = worlds.currentWorldId;
  chosenStart.value = 'demo';
  blankWorldId.value = null;
  blankWorldError.value = '';
}, { immediate: true });

// Picking a card is pure selection — no world is touched yet. The actual
// create/switch only happens once Next is confirmed (goNextFromStartingPoint
// below), so nothing is created just from clicking around between the two options.
function pickStartingPoint(kind) {
  chosenStart.value = kind;
}

const hasCharacters = computed(() => world.charactersList.length > 0);

// AddPersonaForm.vue creates a persona but doesn't activate it (elsewhere
// that's a deliberate separate "Set active" action, e.g. PersonaCard.vue's
// activate()) — but the whole point of this step is escaping "the visitor,"
// so auto-activate whatever's newly added while it's showing.
watch(() => world.personasList.length, async (newLen, oldLen) => {
  if (STEPS[onboarding.currentStep.value] !== 'add-persona' || newLen <= oldLen) return;
  const newest = world.personasList[world.personasList.length - 1];
  const { ok, data } = await setActivePersona(newest.id);
  if (ok) world.activePersonaId = data.activePersonaId;
});

// Deferred until Next is pressed on the starting-point step, and gated on an
// explicit confirm() (same native-confirm convention this app already uses
// for consequential actions — see CharacterModal.vue/PlaceEditRow.vue's
// remove()). Recomputes what would actually happen from current state each
// time, so toggling blank -> demo -> blank never mints a second "My World
// (blank)" — it just re-confirms switching back to the one already made.
async function goNextFromStartingPoint() {
  const needsCreate = chosenStart.value === 'blank' && !blankWorldId.value;
  const targetId = chosenStart.value === 'blank' ? blankWorldId.value : originalWorldId;
  const needsSwitch = !needsCreate && worlds.currentWorldId !== targetId;

  if (needsCreate || needsSwitch) {
    const message = needsCreate
      ? 'A new blank world will be created now. Continue?'
      : chosenStart.value === 'blank'
        ? 'Switch to your blank world. Continue?'
        : 'Switch back to the demo world. Continue?';
    if (!confirm(message)) return; // stay on this step, nothing happens
  }

  if (needsCreate) {
    blankWorldBusy.value = true;
    blankWorldError.value = '';
    const { ok, data } = await worlds.create({ name: 'My World (blank)', mode: 'empty' });
    if (!ok) { blankWorldError.value = data.error || 'Could not create a blank world.'; blankWorldBusy.value = false; return; }
    blankWorldId.value = data.world.id;
    await worlds.switchWorld(data.world.id);
    await world.loadWorldState();
    blankWorldBusy.value = false;
  } else if (needsSwitch) {
    blankWorldBusy.value = true;
    await worlds.switchWorld(targetId);
    await world.loadWorldState();
    blankWorldBusy.value = false;
  }

  next();
}

function next() {
  if (onboarding.currentStep.value < STEPS.length - 1) onboarding.currentStep.value += 1;
}
function back() {
  if (onboarding.currentStep.value > 0) onboarding.currentStep.value -= 1;
}
function skip() {
  onboarding.markDone();
}
function finish() {
  onboarding.markDone();
}
function finishAndGoToCast() {
  onboarding.markDone();
  router.push('/world/cast');
}
</script>

<template>
  <div
    class="modal-overlay" v-if="onboarding.isOpen.value"
    @click="(e) => { if (e.target === e.currentTarget) skip(); }"
  >
    <div class="modal onboarding-modal">
      <div class="modal-head-row">
        <h2>Welcome to Freeroam</h2>
        <button class="modal-close" type="button" @click="skip" title="Skip intro">✕</button>
      </div>

      <div class="onboarding-dots">
        <span v-for="(s, i) in STEPS" :key="s" class="onboarding-dot" :class="{ active: i === onboarding.currentStep.value, done: i < onboarding.currentStep.value }"></span>
      </div>

      <div class="onboarding-step-body">
        <template v-if="STEPS[onboarding.currentStep.value] === 'welcome'">
          <p class="hint">
            Freeroam is a roleplay app — place characters in a world, walk between rooms, and talk to whoever's
            there. There's also a phone for texting and calling characters who aren't around, and characters
            remember past conversations and track relationships with each other. This will only take a minute.
          </p>
        </template>

        <template v-else-if="STEPS[onboarding.currentStep.value] === 'connect'">
          <p class="hint">
            Freeroam talks to an OpenRouter-compatible endpoint to bring characters to life. You can set this up
            now, or skip it and look around on your own first — characters will just stay quiet until you connect,
            and you can always add a key later from Settings.
          </p>
          <EndpointCard />
        </template>

        <template v-else-if="STEPS[onboarding.currentStep.value] === 'starting-point'">
          <p class="hint">Every install starts with a demo world already set up. Keep it to try things out, or start with a blank slate.</p>
          <div class="onboarding-choice-cards">
            <button
              type="button" class="onboarding-choice-card" :class="{ selected: chosenStart === 'demo' }"
              @click="pickStartingPoint('demo')"
            >
              <strong>Keep the demo world</strong>
              <span>4 characters and 9 places, already set up and ready to try.</span>
            </button>
            <button
              type="button" class="onboarding-choice-card" :class="{ selected: chosenStart === 'blank' }"
              @click="pickStartingPoint('blank')"
            >
              <strong>Start blank</strong>
              <span>An empty world — add your own characters and places.</span>
            </button>
          </div>
          <p class="form-status" v-if="blankWorldError">{{ blankWorldError }}</p>
        </template>

        <template v-else-if="STEPS[onboarding.currentStep.value] === 'add-character'">
          <p class="hint">
            <template v-if="chosenStart === 'blank'">Let's add your first character — drop a character card below, or skip and add one later from World → Cast.</template>
            <template v-else>Want to add your own character too? Drop a character card below, or skip — the demo cast is ready to go either way.</template>
          </p>
          <UploadZone />
        </template>

        <template v-else-if="STEPS[onboarding.currentStep.value] === 'add-persona'">
          <p class="hint">
            Your persona is who <em>you</em> are in this world — without one, you'll appear in scenes as "the
            visitor." Set one up now, or skip and add it later from World → Persona.
          </p>
          <p class="hint" v-if="world.activePersona">Playing as <strong>{{ world.activePersona.name }}</strong>.</p>
          <AddPersonaForm />
        </template>

        <template v-else-if="STEPS[onboarding.currentStep.value] === 'phone'">
          <p class="hint">
            The in-game phone (from the Freeroam tab) has three apps: <strong>Wavelength</strong> for voice calls,
            <strong>TypeCast</strong> for 1-on-1 texting, and <strong>Party Line</strong> for group texting.
            Characters can even text you first, unprompted, once in a while.
          </p>
        </template>

        <template v-else-if="STEPS[onboarding.currentStep.value] === 'done'">
          <p class="hint">
            That's everything to get started. For anything else, the FAQ/Manual under Settings → Guides covers
            most questions — and you can replay this tour any time from there.
          </p>
        </template>
      </div>

      <div class="modal-tab-foot onboarding-foot">
        <button class="btn secondary" v-if="onboarding.currentStep.value > 0" :disabled="blankWorldBusy" @click="back">Back</button>
        <button
          class="btn" v-if="STEPS[onboarding.currentStep.value] === 'starting-point'"
          :disabled="blankWorldBusy" @click="goNextFromStartingPoint"
        >{{ blankWorldBusy ? 'Working…' : 'Next' }}</button>
        <button
          class="btn" v-else-if="STEPS[onboarding.currentStep.value] !== 'done'" @click="next"
        >Next</button>
        <template v-else>
          <button class="btn secondary" v-if="!hasCharacters" @click="finishAndGoToCast">Go to Cast to add characters</button>
          <button class="btn" @click="finish">Get started</button>
        </template>
        <button class="btn secondary" v-if="STEPS[onboarding.currentStep.value] !== 'done'" :disabled="blankWorldBusy" @click="skip">Skip intro</button>
      </div>
    </div>
  </div>
</template>

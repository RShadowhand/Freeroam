import { defineStore } from 'pinia';
import { getWorld, saveWorldSetting as apiSaveWorldSetting, postWorldTime, randomizePlacements } from '../api/world';
import { getCharacters } from '../api/characters';
import { getPersonas } from '../api/personas';
import { getPresets } from '../api/presets';
import { getRelationships } from '../api/relationships';

// Standard relationship labels offered in the Relationships editor —
// gendered and neutral, grouped, plus free-text custom entries.
export const RELATIONSHIP_LABELS = {
  Family: ['mother', 'father', 'parent', 'daughter', 'son', 'child', 'sister', 'brother', 'sibling',
    'grandmother', 'grandfather', 'aunt', 'uncle', 'cousin', 'niece', 'nephew', 'guardian', 'ward'],
  Romantic: ['wife', 'husband', 'spouse', 'girlfriend', 'boyfriend', 'partner',
    'ex-wife', 'ex-husband', 'ex-partner', 'fiancé', 'fiancée', 'lover'],
  Social: ['friend', 'best friend', 'rival', 'enemy', 'acquaintance', 'colleague',
    'boss', 'employee', 'mentor', 'student', 'neighbor', 'roommate'],
};

// Shared world state — places / characters / placements / personas /
// presets / relationships — fetched once per view-activation and read by
// whichever view is currently visible. Mirrors the original `state` object
// plus loadWorldState().
export const useWorldStore = defineStore('world', {
  state: () => ({
    places: [],
    charactersList: [],
    charactersById: {},
    placements: {},
    personasList: [],
    activePersonaId: null,
    presetsList: [],
    activePresetId: null,
    time: { day: 1, timeOfDay: 'morning' },
    worldSetting: '',
    relationships: [],
    metCharacterIds: [],
  }),
  getters: {
    activePersona: (state) => state.personasList.find((p) => p.id === state.activePersonaId) || null,
    placeById: (state) => (id) => state.places.find((p) => p.id === id),
    charName: (state) => (id) => state.charactersById[id]?.name || null,
    charsInPlace: (state) => (placeId) => Object.entries(state.placements)
      .filter(([, p]) => p && p.placeId === placeId)
      .map(([cid]) => cid)
      .filter((cid) => state.charactersById[cid]),
    // Active is the default — a placement with no `active` field (every
    // placement made before this feature existed, or a freshly-placed
    // character) counts as active. Mirrors backend/server.js's
    // activeCharIds().
    isActive: (state) => (charId) => state.placements[charId]?.active !== false,
    // A character counts as "known" (and so eligible to show up as a Phone
    // contact) once either the user has actually shared a scene with them
    // (they've spoken in some place's chat log) or the world author has
    // explicitly given them a relationship to the user via Cast — either
    // signal is enough on its own, so this is a union, not an intersection.
    knowsUser: (state) => (charId) => state.metCharacterIds.includes(charId)
      || state.relationships.some((r) => r.character_id === charId && r.target_id === 'user'),
  },
  actions: {
    async loadWorldState() {
      const [worldRes, charsRes, personasRes, presetsRes, relRes] = await Promise.all([
        getWorld(), getCharacters(), getPersonas(), getPresets(), getRelationships(),
      ]);
      const world = worldRes.data;
      const chars = charsRes.data;
      const personas = personasRes.data;
      const presets = presetsRes.data;
      const rel = relRes.data;
      this.places = world.places;
      this.placements = world.placements;
      this.charactersList = chars.characters;
      this.charactersById = {};
      chars.characters.forEach((c) => { this.charactersById[c.id] = c; });
      this.personasList = personas.personas;
      this.activePersonaId = personas.activePersonaId;
      this.presetsList = presets.presets;
      this.activePresetId = presets.activePresetId;
      this.time = world.time || this.time;
      this.worldSetting = world.setting || '';
      this.relationships = rel.relationships || [];
      this.metCharacterIds = world.metCharacterIds || [];
    },
    async saveWorldSetting(setting) {
      const { ok, data } = await apiSaveWorldSetting(setting);
      if (ok) this.worldSetting = data.setting;
      return { ok, data };
    },
    async advanceOrRetreatTime(body) {
      const { ok, data } = await postWorldTime(body);
      if (ok) {
        this.time = data.time;
        if (data.placements) this.placements = data.placements; // scheduled characters may have just moved
      }
      return { ok, data };
    },
    async randomize() {
      const { ok, data } = await randomizePlacements();
      if (ok) this.placements = data.placements;
      return { ok, data };
    },
  },
});

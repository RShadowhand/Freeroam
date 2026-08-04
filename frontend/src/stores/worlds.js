import { defineStore } from 'pinia';
import router from '../router';
import { useChatStore } from './chat';
import { useWorldStore } from './world';
import { usePhoneStore } from './phone';
import { useGroupsStore } from './groups';
import { useUiStore } from './ui';
import { getWorlds, createWorld, renameWorld, deleteWorld, duplicateWorld, exportWorld, importWorld } from '../api/worlds';
import { getStoredWorldId, setStoredWorldId } from '../api/worldId';

// Worlds are save slots — separate casts/places/chat history/memory, never
// mixed. The active one is resolved per-request server-side from the
// X-World-Id header (see api/http.js), read out of localStorage rather than
// this store's state, so it's available to the very first request the app
// makes, before this store has even loaded. This store is the read model
// (the list, for display) plus the CRUD actions; api/worldId.js is the
// actual source of truth for "which world am I in."
export const useWorldsStore = defineStore('worlds', {
  state: () => ({
    list: [],
    defaultWorldId: null,
    currentWorldId: getStoredWorldId(),
    loaded: false,
    switching: false, // true while a switchWorld() is in flight
  }),
  getters: {
    current: (state) => state.list.find((w) => w.id === state.currentWorldId) || null,
  },
  actions: {
    async refresh() {
      const { ok, data } = await getWorlds();
      if (ok) {
        this.list = data.worlds;
        this.defaultWorldId = data.defaultWorldId;
      }
      return ok;
    },

    // Called once at startup (see main.js). If nothing's been chosen yet,
    // or the stored id points at a world that's since been deleted, falls
    // back to the server's default world — never leaves currentWorldId
    // dangling on an id that doesn't exist.
    async init() {
      const ok = await this.refresh();
      if (ok && (!this.currentWorldId || !this.list.some((w) => w.id === this.currentWorldId))) {
        this.setCurrent(this.defaultWorldId);
      }
      this.loaded = true;
    },

    setCurrent(id) {
      this.currentWorldId = id;
      setStoredWorldId(id);
    },

    // Switches the active world: persists the new id (every subsequent
    // request picks it up via api/http.js), clears the other stores' cached
    // state so nothing from the old world lingers on screen, and lands back
    // on Freeroam to re-enter fresh. $reset() re-runs each store's state()
    // factory, which is what actually gives chat's Sets a clean slate again
    // rather than leaving stale entries in an already-constructed Set.
    // Returns true once the world is actually current (including the
    // already-there no-op case), false when the switch didn't happen —
    // callers that have their own "did this succeed" UI step (the boot-time
    // picker closing itself, for one) need this to tell "actually switched"
    // apart from "blocked, nothing changed."
    async switchWorld(id) {
      if (id === this.currentWorldId) return true;
      // Each WorldCard's own "busy" ref is per-component, not shared — it
      // disables that card's own buttons while its switch is in flight, but
      // does nothing to stop a *different* card's Switch button being
      // clicked in the meantime. Without this store-level lock, two
      // overlapping switches interleave their $reset()/setCurrent() calls
      // and initFreeroam() ends up racing against whichever world id
      // happens to be current by the time each one's fetches actually fire.
      if (this.switching) return false;

      // $reset() would wipe chat/phone/groups' own tracking of an in-flight
      // generation (abortController, loadingIds, streamingState) without
      // actually stopping it server-side — the abandoned request's eventual
      // response handler would still fire later and write into whichever
      // store now belongs to the *new* world, corrupting its freshly-reset
      // state with data from the old one. Same idea as chat.js's existing
      // "hang up before going somewhere else" activeCall guard, just for
      // worlds instead of places.
      const chat = useChatStore();
      const phone = usePhoneStore();
      const groups = useGroupsStore();
      if (chat.isGenerating || phone.loadingIds.size > 0 || groups.loadingIds.size > 0) {
        useUiStore().showError('Stop the current generation before switching worlds.');
        return false;
      }

      this.switching = true;
      try {
        this.setCurrent(id);

        chat.$reset();
        useWorldStore().$reset();
        phone.$reset();
        groups.$reset();

        await router.push('/');
        await chat.initFreeroam();
        return true;
      } finally {
        this.switching = false;
      }
    },

    async create(opts) {
      const { ok, data } = await createWorld(opts);
      if (ok) await this.refresh();
      return { ok, data };
    },

    async rename(id, name) {
      const { ok, data } = await renameWorld(id, name);
      if (ok) await this.refresh();
      return { ok, data };
    },

    async duplicate(id, opts) {
      const { ok, data } = await duplicateWorld(id, opts);
      if (ok) await this.refresh();
      return { ok, data };
    },

    async exportWorld(id, includeHistory) {
      return exportWorld(id, includeHistory);
    },

    async importWorld(file, name) {
      const { ok, data } = await importWorld(file, name);
      if (ok) await this.refresh();
      return { ok, data };
    },

    async remove(id) {
      const { ok, data } = await deleteWorld(id);
      if (ok) {
        await this.refresh();
        // The deleted world may have been the active one — the backend's
        // response already tells us where its own defaultWorldId landed.
        if (this.currentWorldId === id) await this.switchWorld(data.defaultWorldId);
      }
      return { ok, data };
    },
  },
});

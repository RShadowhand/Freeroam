import { defineStore } from 'pinia';

// Theme (accent color, avatar shape, formatted-text colors) and message
// formatting-rule toggles — both per-browser only via localStorage, never
// round-tripped to the backend. Applied by setting CSS custom properties
// (see src/styles/shared.css's :root/[data-theme] block) rather than
// swapping stylesheets. An empty fmt*Color means "not customized" — it
// follows the active theme (bold/italic use fixed neutral shades; quote
// follows the accent color) until the user actually picks one.
const THEME_PREFS_KEY = 'freeroam.themePrefs';
const THEME_DEFAULTS = { theme: 'amber', avatarRadius: '50%', fmtBoldColor: '', fmtItalicColor: '', fmtQuoteColor: '' };

const FORMAT_PREFS_KEY = 'freeroam.formatPrefs';
const FORMAT_DEFAULTS = { bold: true, italics: true, quotes: true, hideAngleBrackets: true };

function loadThemePrefs() {
  try { return { ...THEME_DEFAULTS, ...JSON.parse(localStorage.getItem(THEME_PREFS_KEY) || '{}') }; }
  catch { return { ...THEME_DEFAULTS }; }
}

function loadFormatPrefs() {
  try { return { ...FORMAT_DEFAULTS, ...JSON.parse(localStorage.getItem(FORMAT_PREFS_KEY) || '{}') }; }
  catch { return { ...FORMAT_DEFAULTS }; }
}

// Bold/italic have no theme-dependent default (bold just inherits the
// bubble's own text color; italic is a fixed neutral dim shade) — these
// literals are only what the color picker shows until customized, not
// what actually renders (that's --fmt-bold-color/--fmt-italic-color).
export const FMT_BOLD_PICKER_DEFAULT = '#ede6da';
export const FMT_ITALIC_PICKER_DEFAULT = '#a79fb0';

export const useThemeStore = defineStore('theme', {
  state: () => ({
    theme: loadThemePrefs(),
    format: loadFormatPrefs(),
  }),
  actions: {
    // Sets the CSS custom properties the whole app's styling reads from.
    // Called as early as possible (before mount) and any time a theme
    // field changes.
    apply() {
      const root = document.documentElement;
      root.dataset.theme = this.theme.theme;
      root.style.setProperty('--avatar-radius', this.theme.avatarRadius);
      root.style.setProperty('--fmt-bold-color', this.theme.fmtBoldColor || 'inherit');
      root.style.setProperty('--fmt-italic-color', this.theme.fmtItalicColor || 'var(--dim)');
      root.style.setProperty('--fmt-quote-color', this.theme.fmtQuoteColor || 'var(--accent)');
    },
    persistTheme() {
      localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(this.theme));
    },
    persistFormat() {
      localStorage.setItem(FORMAT_PREFS_KEY, JSON.stringify(this.format));
    },
    setTheme(name) {
      this.theme.theme = name;
      this.persistTheme();
      this.apply();
    },
    setAvatarRadius(radius) {
      this.theme.avatarRadius = radius;
      this.persistTheme();
      this.apply();
    },
    setFmtColor(key, value) {
      this.theme[key] = value;
      this.persistTheme();
      this.apply();
    },
    resetFmtColors() {
      this.theme.fmtBoldColor = '';
      this.theme.fmtItalicColor = '';
      this.theme.fmtQuoteColor = '';
      this.persistTheme();
      this.apply();
    },
    setFormatFlag(key, value) {
      this.format[key] = value;
      this.persistFormat();
    },
    // Reads back what a CSS custom property currently resolves to (post
    // data-theme application) — only meaningful for vars that are always a
    // literal hex at the root, like --accent; used to seed the quote-color
    // picker with the active theme's own accent instead of hand-duplicating
    // the hex values from shared.css here.
    resolvedVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    },
  },
});

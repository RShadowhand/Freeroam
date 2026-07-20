// The in-world clock — mirrors backend/lib/context.js's TIMES_OF_DAY/WEEKDAYS.
// Day 1 is a Monday; weekday is always derived from the day count, never
// stored separately, so jumping the day directly (including backward, for
// time-travel scenarios) keeps a consistent weekday.
export const TIMES_OF_DAY = ['sunrise', 'morning', 'noon', 'afternoon', 'evening', 'sunset', 'night'];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// For compact headers (the schedule table on mobile) where "sunrise" and
// "sunset" can't both be abbreviated to "sun" — each glyph is a visually
// distinct silhouette, not just a lighter/darker sun, so columns stay
// tellable apart at a glance even at small table-cell sizes.
const TIME_OF_DAY_EMOJI = {
  sunrise: '🌅',
  morning: '🌞',
  noon: '☀️',
  afternoon: '🌤️',
  evening: '🌆',
  sunset: '🌇',
  night: '🌙',
};
export function timeOfDayEmoji(t) {
  return TIME_OF_DAY_EMOJI[t] || '';
}

export function weekdayFor(day) {
  if (!Number.isInteger(day)) return null;
  const idx = ((day - 1) % 7 + 7) % 7;
  return WEEKDAYS[idx];
}

// The next time-of-day slot after {day, timeOfDay} (wrapping into the next
// day at night->sunrise) — mirrors backend/server.js's nextTimeSlot.
export function nextTimeSlot(day, timeOfDay) {
  const idx = TIMES_OF_DAY.indexOf(timeOfDay);
  const nextIdx = (idx + 1) % TIMES_OF_DAY.length;
  return { day: nextIdx === 0 ? day + 1 : day, timeOfDay: TIMES_OF_DAY[nextIdx] };
}

// A character's own schedule slot for a given day/time-of-day, or null.
export function scheduledSlotFor(character, day, timeOfDay) {
  const weekday = weekdayFor(day);
  return character?.schedule?.[weekday]?.[timeOfDay] || null;
}

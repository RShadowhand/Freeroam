// The in-world clock — mirrors backend/lib/context.js's TIMES_OF_DAY/WEEKDAYS.
// Day 1 is a Monday; weekday is always derived from the day count, never
// stored separately, so jumping the day directly (including backward, for
// time-travel scenarios) keeps a consistent weekday.
export const TIMES_OF_DAY = ['sunrise', 'morning', 'noon', 'afternoon', 'evening', 'sunset', 'night'];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

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

// "Day N (Weekday) · timeOfDay" — same phrasing TimeWidget.vue uses for the
// world clock, reused for the date dividers in PhoneThread.vue/GroupThread.vue.
export function formatDayTime(day, timeOfDay) {
  const weekday = weekdayFor(day);
  return `Day ${day}${weekday ? ` (${weekday})` : ''} · ${timeOfDay}`;
}

// A parallel array of divider labels (or null), one per entry in `log` — a
// non-null label at index i means "show a date divider right before this
// entry." A texting/group conversation (unlike one scene visit) can span
// many in-world days, so PhoneThread.vue/GroupThread.vue render one of
// these wherever day/timeOfDay actually changes from the previous *stamped*
// entry, iMessage-style, rather than repeating it on every line. Entries
// from before this feature existed carry no day/timeOfDay at all and are
// simply skipped — no divider, no retroactive backfill.
export function dayDividerLabels(log) {
  const labels = new Array(log.length).fill(null);
  let lastKey = null;
  log.forEach((entry, i) => {
    if (entry.day == null || entry.timeOfDay == null) return;
    const key = `${entry.day}|${entry.timeOfDay}`;
    if (key !== lastKey) labels[i] = formatDayTime(entry.day, entry.timeOfDay);
    lastKey = key;
  });
  return labels;
}

# Freeroam Board

## To Do

### Feature: Date/Time Divider for area chats

- priority: medium
- workload: Easy
    ```md
    Need a divider in area chats with date/time information that shows the previous block and the current block. User has no way of knowing when a last message was sent when they enter a new room. Something like:
    <old messages here>
    --- Monday 1, afternoon ---
    --- Monday 1, sunset ---
    [user input box]
    ```

### Fix: Save last area per persona

- priority: high
    ```md
    Last visited area should be saved on the server side per user persona per world, so when they come back to the world (either by switch from other worlds, or from starting a whole new session after a few real life hours), they don't have to remember where they left off last.
    ```

## In Progress

## Needs Human Testing

### Feature: per-contact unread badge in TypeCast

- priority: medium
- workload: Normal
- steps:
  - [x] Backend: `countUnreadProactiveTexts(w)` returns `{ total, byCharacterId }`; `GET /api/texts/unread` updated to match
  - [x] Frontend: `phone.js` store tracks `unreadByCharacterId`; badge added to `PhoneContacts.vue`'s `#trailing` slot via `TypeCastApp.vue`
  - [x] Backend tests updated, 696/696 passing; frontend build clean
  - [ ] Manual: trigger a proactive text for one contact (high `textingChancePerChar` in Settings), confirm only that contact shows the badge in TypeCast's contacts list, and it clears once the thread is opened
    ```md
    Replaces the single global unread count/badge with a per-contact
    breakdown, so the user doesn't have to open every conversation to find
    out who actually texted.
    ```

### Feature: day/time stamps on 1-on-1 and group texts

- priority: medium
- workload: Normal
- steps:
  - [x] Backend: every new texting/group entry (user lines, char replies, proactive texts, cascade replies) carries `day`/`timeOfDay`
  - [x] Frontend: `utils/time.js`'s `dayDividerLabels()` + a "Day N (Weekday) · timeOfDay" divider rendered in `PhoneThread.vue`/`GroupThread.vue`
  - [x] Backend tests added, 696/696 passing; frontend build clean; no retroactive backfill for existing history
  - [ ] Manual: send messages across a day/time-of-day change (via the Freeroam time-jump control), confirm a divider appears at the right point in both a 1-on-1 and a group thread, and pre-existing history renders unchanged (no divider)
    ```md
    A texting conversation can span many in-world days, unlike a single scene
    visit, but nothing showed when a message was actually sent.
    ```

### Feature: world picker on boot + backend-persisted onboarding flag

- priority: medium
- workload: Normal
- steps:
  - [x] Backend: `onboarded` flag added to `config.json`/`publicConfig()`/`POST /api/settings`
  - [x] Frontend: `useOnboardingModal.js` moved off `localStorage` onto the backend flag
  - [x] Frontend: new `useWorldPicker.js` + `WorldPickerOverlay.vue`, shown once per boot when 2+ worlds exist, suppressed while onboarding is open
  - [x] Frontend build clean
  - [ ] Manual: with 2+ worlds, hard-reload and confirm the picker appears/switches correctly and stays suppressed while onboarding is open
  - [ ] Manual: confirm onboarding does NOT reappear in a fresh private/incognito window
    ```md
    The onboarding flag lived in localStorage, which doesn't persist across a
    fresh private-browsing session, so the tour kept reappearing there.
    There was also no way to see/pick which world (save slot) is active
    without already knowing about the small chip in MainNav.vue.
    ```


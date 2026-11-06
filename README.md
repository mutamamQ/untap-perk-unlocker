# Untap.in Perk Unlocker

A Tampermonkey/Violentmonkey userscript for [untap.in](https://untap.in) that
restores free-account quality-of-life features and adds a lobby helper panel.

## Features

Everything is reachable from a small **green dot** in the bottom-left corner.
Click the dot to open/collapse a menu; drag it to move. The menu holds a status
line plus one button per feature — nothing is keybind-only (the lobby helper
also still answers `F8` as a shortcut).

- **Perk unlock** — forces `hasPerks` on the account state so perk-gated
  quality-of-life features (deck slots, etc.) are usable on a free account.
  `tier` is left untouched on purpose: every gate keys off `hasPerks`, and
  forging `tier` only risks mismatched entitlement UI.
- **Deck slot unlock** — clears the `locked` flag on locked deck slots.
- **Re-login aware** — re-applies unlocks whenever the account store updates,
  so it survives logout/login without a page reload.
- **Lobby helper** (menu button, or `F8`) — a floating panel listing rooms with
  access controls (password / friends-only / patron-only) and a join button. It
  mirrors the app's own list filter (hides blocked/started/full rooms) and
  never joins anything automatically.
- **Custom card sleeve / card back** (menu button) — pick an image to set as
  your deck's card back via the per-deck `update-deck-back` RPC (served from the
  ungated `/cardimg/<deck_uid>/deck_back` route rather than the tier-gated
  account-level sleeve). **Note:** this did not render in testing, so it may not
  actually work; the button is left in place in case the path works on another
  account/setup. The account-level sleeve route is server-side tier-gated and
  can't be unlocked.
- **Local playmat** (menu buttons: set / clear) — pick an image to use as your
  board background. **Local-only: you see it, opponents do not.** The real
  playmat (`/playmat/<username>`) is served only to Powered-Up accounts (free
  accounts get HTTP 410), and each opponent's client fetches that gated URL
  independently, so there is no way to show a custom playmat to opponents
  without a subscription. This paints your own board via injected CSS and
  persists in `localStorage`.
- **Create multi-seat game** (menu button) — create a deck-vs-deck table where
  you play every seat yourself (2–6 of your own decks). This is the free path to
  the paid multi-seat capability: `create-game-ge2` accepts `deckvdeck:true`
  from a free account (the in-app toggle is only client-gated), seating you in
  all slots at once. **It's a solo/self-play table — no second human can join**
  (the direct "claim a second seat in someone's game" action is enforced
  server-side and cannot be unlocked).
- **Download summary CSV** (menu button) — your overall record
  (wins/draws/losses/unrecorded/hours/win-rate) plus a **per-opponent W/L/D**
  table built from `get-game-stats` (your own recorded games; multi-player games
  credit the single result against each opponent; "Don't Record" games excluded).
- **Download game history CSV** (menu button) — one row per game from your
  replay list: game_uid, created, format, title, opponents, rounds, duration,
  event_count, private. Instant.
- **Download rich history CSV (slow!)** (menu button) — same as the history CSV
  but also fetches and decodes **every** replay to add the winner and each
  player's deck_uid per game. Prompts for confirmation first because it is one
  download + gunzip + parse per game (slow for large histories; replays older
  than ~60 days may be unavailable).
- **Status line** — shows `UNLOCKED (client-side)` / `LOCKED` and deck count.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open `untap-perk-unlocker.user.js` and let the extension pick up the
   userscript header, or create a new script and paste the file contents.
3. Load `https://untap.in` — the green dot appears bottom-left; click it for the
   menu.

## Friends-only join

untap.in's `onlyFriends` list is a client-side filter only — the join RPC does
not enforce it server-side. Joining fails only because of stale seats: the
server allows multiple simultaneous seats, and a stale seat pins the game store
so new games get dropped. The script fixes this by leaving every stale seat
(`state-request FINISH+LEAVE` to each `engineHost`) before joining.

## Notes

- `gamePass` is broadcast in plaintext to every client, but the server **does**
  validate it on join, so a wrong password still fails.
- An account with an unvalidated email cannot join via `gamesStore.joinGame`.

## License

MIT

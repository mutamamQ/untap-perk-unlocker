# Untap.in Perk Unlocker

A Tampermonkey/Violentmonkey userscript for [untap.in](https://untap.in) that
restores free-account quality-of-life features and adds a lobby helper panel.

## Features

- **Perk unlock** — forces `hasPerks` on the account state so perk-gated
  quality-of-life features (deck slots, etc.) are usable on a free account.
  `tier` is left untouched on purpose: every gate keys off `hasPerks`, and
  forging `tier` only risks mismatched entitlement UI.
- **Deck slot unlock** — clears the `locked` flag on locked deck slots.
- **Re-login aware** — re-applies unlocks whenever the account store updates,
  so it survives logout/login without a page reload.
- **Lobby helper (press `F8`)** — a floating panel listing rooms with access
  controls (password / friends-only / patron-only) and a join button. It
  mirrors the app's own list filter (hides blocked/started/full rooms) and
  never joins anything automatically.
- **Second-seat claim (press `F9` in a game)** — claim an extra seat in the
  same game, the perk-gated "Play a second seat" / "Play another seat" action.
  `Shift+F9` releases a seat. The store action (`claim-alt-seat`) has no perk
  check; F9 drives it directly so it works even before the button renders, and
  only fires when a claim is actually legal (PENDING game, you're a seated
  player, room not full, under the 8-seat cap). Results are logged to the
  console; nothing happens silently.
- **Status chip** — a small draggable indicator showing script state.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open `untap-perk-unlocker.user.js` and let the extension pick up the
   userscript header, or create a new script and paste the file contents.
3. Load `https://untap.in` — the status chip appears bottom-left, `F8` toggles
   the lobby panel.

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

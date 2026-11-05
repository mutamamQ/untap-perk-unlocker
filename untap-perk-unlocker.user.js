// ==UserScript==
// @name         Untap.in Perk Unlocker
// @namespace    untap-recon
// @version      0.12.0
// @description  Free-account quality-of-life unlocks + lobby helper (F8) + second-seat claim (F9) in-game
// @match        https://untap.in/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==
(function () {
  'use strict';

  const LOG = '[UT-UNLOCK]';
  const log = (...a) => console.log(LOG, ...a);
  const warn = (...a) => console.warn(LOG, ...a);

  // Fields we force on the account state every time it changes.
  // NOTE: tier is deliberately NOT forced — every perk gate keys off hasPerks;
  // tier is display-only and forging it risks mismatched entitlement UI
  // (isGifted, upgrade modal, Ya[tier]||Ya.community).
  const UNLOCK_FIELDS = { hasPerks: true };

  const state = {
    pollTimer: null,
    watchdog: null,
    accountStore: null,
    patchedUpdateAccount: false,
    chip: null,
    chipInterval: null,
    lobby: null,
    lobbyBody: null,
    lobbyOpen: false,
    lobbyTimer: null,
    lobbyStatus: null,
    joining: null,
  };

  function applyUnlockFields(account) {
    if (!account) return;
    let changed = false;
    for (const k of Object.keys(UNLOCK_FIELDS)) {
      if (account[k] !== UNLOCK_FIELDS[k]) {
        account[k] = UNLOCK_FIELDS[k];
        changed = true;
      }
    }
    return changed;
  }

  function unlockDeckSlots(accountStore) {
    try {
      const pinia = accountStore._p;
      const stores = pinia && pinia._s;
      if (!stores || typeof stores.get !== 'function') {
        warn('pinia._s map not found; cannot reach deckStore');
        return { total: 0, unlocked: 0 };
      }
      const deckStore = stores.get('deckStore');
      if (!deckStore || !Array.isArray(deckStore.deckListStore)) {
        warn('deckStore.deckListStore not found');
        return { total: 0, unlocked: 0 };
      }
      let unlocked = 0;
      for (const deck of deckStore.deckListStore) {
        if (deck && deck.locked) {
          deck.locked = false;
          unlocked++;
        }
      }
      if (unlocked > 0) log(`unlocked ${unlocked} deck slot(s)`);
      return { total: deckStore.deckListStore.length, unlocked };
    } catch (e) {
      warn('unlockDeckSlots failed', e);
      return { total: 0, unlocked: 0 };
    }
  }

  // Wrap updateAccount so that after the server merges real (free) account
  // data over our patched state, we immediately re-apply the unlock fields.
  function patchUpdateAccount(store) {
    if (state.patchedUpdateAccount) return;
    if (!Object.prototype.hasOwnProperty.call(store, 'updateAccount') &&
        typeof store.updateAccount !== 'function') {
      warn('store.updateAccount not found as instance property; cannot patch merge path');
      return;
    }
    if (typeof store.updateAccount !== 'function') {
      warn('store.updateAccount is not a function; skipping patch');
      return;
    }
    const original = store.updateAccount.bind(store);
    store.updateAccount = function wrappedUpdateAccount(...args) {
      const result = original(...args);
      // Re-apply unlock fields after the real merge runs (sync or async).
      const reapply = () => {
        if (applyUnlockFields(store.account)) {
          log('re-applied unlock fields after ws-user-account merge');
        }
        unlockDeckSlots(store);
        updateChip();
      };
      if (result && typeof result.then === 'function') {
        result.then(reapply, reapply);
      } else {
        reapply();
      }
      return result;
    };
    state.patchedUpdateAccount = true;
    log('patched accountStore.updateAccount to survive ws-user-account merges');
  }

  function applyAll() {
    const accountStore = window.accountStore;
    if (!accountStore || !accountStore.account) return false;

    // Wrap the merge path as soon as the store exists — the FIRST
    // ws-user-account push supplies the username, and it must already be
    // wrapped when it lands (otherwise the merge runs unwrapped and gated
    // UI flashes locked for up to a poll interval).
    patchUpdateAccount(accountStore);

    if (!accountStore.account.username) return false; // not logged in yet

    state.accountStore = accountStore;

    const changed = applyUnlockFields(accountStore.account);
    if (changed) log('patched account.hasPerks=true');

    unlockDeckSlots(accountStore);
    updateChip();
    return true;
  }

  function anyLockedDeck() {
    try {
      const stores = window.accountStore._p && window.accountStore._p._s;
      const decks = stores && stores.get('deckStore');
      const list = decks && decks.deckListStore;
      if (!Array.isArray(list)) return false;
      for (const d of list) if (d && d.locked) return true;
      return false;
    } catch (e) { return false; }
  }

  function startPolling() {
    if (state.pollTimer) return;
    const start = Date.now();
    log('polling for window.accountStore ...');
    state.pollTimer = setInterval(() => {
      const ok = applyAll();
      if (ok) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        log('initial unlock applied; polling stopped');
        ensureReloginWatcher();
        return;
      }
      if (Date.now() - start > 30000) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        // Never go fully dead: fall back to the 1s watchdog so a login that
        // happens after 30s (slow boot, slept tab, PayPal return) still
        // gets unlocked automatically.
        warn('no login after 30s; falling back to background watchdog (1s)');
        ensureReloginWatcher();
      }
    }, 500);
  }

  // Background watchdog: re-applies unlocks after $reset()/re-login and
  // unlocks deck items that arrive locked from later server pushes.
  // Runs at 1s (not 3s): deckStore re-locks decks via Be.set(l,"locked",...)
  // on ws-deck-updated/reconcile paths that the updateAccount wrap does NOT
  // cover — the watchdog is the only defense there, so keep the locked-flag
  // window short. The scan is a cheap array walk.
  function ensureReloginWatcher() {
    if (state.watchdog) return;
    state.watchdog = setInterval(() => {
      const accountStore = window.accountStore;
      if (!accountStore || !accountStore.account || !accountStore.account.username) return;
      if (accountStore !== state.accountStore) {
        state.accountStore = accountStore;
        state.patchedUpdateAccount = false; // new instance, re-patch
      }
      // Cheap no-op guard: if the account object and its perk flags are already what we want
      // and no deck is locked, skip the whole tick (no allocation, no DOM writes).
      const acct = accountStore.account;
      if (acct.hasPerks === true && acct.hasPremium === true && !anyLockedDeck()) return;
      applyAll();
    }, 1500);
  }

  // ---- status chip ----
  const CHIP_POS_KEY = 'ut-unlock-chip-pos';

  function loadChipPos() {
    try { return JSON.parse(localStorage.getItem(CHIP_POS_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveChipPos(x, y) {
    try { localStorage.setItem(CHIP_POS_KEY, JSON.stringify({ x, y })); } catch (e) { /* ignore */ }
  }

  function buildChip() {
    // Only trust the cache while the node is actually in the document;
    // a detached chip (removed by the app or body not yet ready) must be rebuilt.
    if (state.chip && state.chip.isConnected) return state.chip;
    state.chip = null;
    // v0.6.0: the chip is a tiny dot in the TOP-LEFT corner, invisible until hovered,
    // and it never intercepts clicks except on the dot itself. This keeps it away from
    // the in-game bottom-right HUD (commander damage / life counters).
    const container = document.createElement('div');
    container.id = 'ut-unlock-chip';
    container.style.cssText = [
      'position:fixed', 'left:4px', 'bottom:4px', 'z-index:2147483647',
      'pointer-events:none', 'font-family:sans-serif', 'font-size:11px',
      'display:flex', 'align-items:center', 'gap:4px',
      'background:transparent', 'color:#0f0', 'padding:0',
      'border:none', 'opacity:0.35',
    ].join(';');
    // restore a saved position (drag) if present
    const saved = loadChipPos();
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.left = saved.x + 'px';
      container.style.top = saved.y + 'px';
    }

    const label = document.createElement('span');
    label.id = 'ut-unlock-chip-label';
    label.textContent = 'UT-UNLOCK: initializing...';
    label.style.cssText = 'pointer-events:none;display:none;background:rgba(20,20,20,0.9);border:1px solid #0f0;border-radius:4px;padding:2px 6px;white-space:nowrap;';

    // Minimal UI: a single tiny dot. Hovering shows the status; clicking the dot
    // toggles "always show the label". Nothing else is clickable, so the chip can
    // never eat a click meant for the game board.
    const dot = document.createElement('span');
    dot.id = 'ut-unlock-dot';
    dot.textContent = '\u25CF';
    dot.style.cssText = 'pointer-events:auto;cursor:pointer;color:#0f0;font-size:8px;line-height:1;opacity:0.6;';
    dot.title = 'UT-UNLOCK';

    const PIN_KEY = 'ut-unlock-chip-pinned';
    let pinned = false;
    try { pinned = localStorage.getItem(PIN_KEY) === '1'; } catch (e) { /* ignore */ }

    const applyPinned = () => {
      label.style.display = pinned ? '' : 'none';
      container.style.opacity = pinned ? '1' : '0.35';
    };

    container.addEventListener('mouseenter', () => { label.style.display = ''; container.style.opacity = '1'; });
    container.addEventListener('mouseleave', () => { applyPinned(); });
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pinned = !pinned;
      try { localStorage.setItem(PIN_KEY, pinned ? '1' : ''); } catch (e) { /* ignore */ }
      applyPinned();
    });

    // Dragging the dot repositions the chip (saved across reloads).
    dot.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const startX = ev.clientX, startY = ev.clientY;
      const rect = container.getBoundingClientRect();
      const startLeft = rect.left, startTop = rect.top;
      let moved = false;
      const onMove = (e) => {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) moved = true;
        if (!moved) return;
        const x = Math.max(0, Math.min(window.innerWidth - 20, startLeft + (e.clientX - startX)));
        const y = Math.max(0, Math.min(window.innerHeight - 20, startTop + (e.clientY - startY)));
        container.style.right = 'auto'; container.style.bottom = 'auto';
        container.style.left = x + 'px'; container.style.top = y + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (moved) {
          const r = container.getBoundingClientRect();
          saveChipPos(r.left, r.top);
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    container.appendChild(dot);
    container.appendChild(label);
    applyPinned();

    if (document.body) {
      document.body.appendChild(container);
      state.chip = container;
    }
    return container;
  }

  function updateChip() {
    if (state.chip && state.chip.isConnected && state.lastChipText) { /* set below */ }
    const container = buildChip();
    if (!container) return;
    const label = container.querySelector('#ut-unlock-chip-label');
    const dotEl = container.querySelector('#ut-unlock-dot');
    const accountStore = window.accountStore;
    const account = accountStore && accountStore.account;
    const hasPerks = !!(account && account.hasPerks);

    let deckInfo = '';
    try {
      const stores = accountStore && accountStore._p && accountStore._p._s;
      const deckStore = stores && stores.get && stores.get('deckStore');
      if (deckStore && Array.isArray(deckStore.deckListStore)) {
        const total = deckStore.deckListStore.length;
        const unlockedCount = deckStore.deckListStore.filter(d => !d.locked).length;
        deckInfo = ` | decks ${unlockedCount}/${total}`;
      }
    } catch (e) { /* ignore */ }

    // Only write to the DOM when the rendered text actually changed — the chip sits inside the
    // app's layout, so a redundant textContent write can cost a style recalc.
    const text = (hasPerks ? 'UNLOCKED (client-side)' : 'LOCKED') + deckInfo;
    if (label && state.lastChipText !== text) {
      state.lastChipText = text;
      label.textContent = text;
      label.style.color = hasPerks ? '#0f0' : '#f55';
    }
    const dotColor = hasPerks ? '#0f0' : '#f55';
    if (dotEl && state.lastDotColor !== dotColor) {
      state.lastDotColor = dotColor;
      dotEl.style.color = dotColor;
    }
  }

  function ensureChipMounted() {
    if (!state.chipInterval) {
      state.chipInterval = setInterval(() => {
        if (!document.body) return;
        if (state.chip && !state.chip.isConnected) {
          // chip was removed (SPA rerender / body swap): re-append the cached node
          document.body.appendChild(state.chip);
          updateChip();
        } else if (!document.getElementById('ut-unlock-chip')) {
          buildChip();
          updateChip();
        }
      }, 2000);
    }
  }

  // =====================================================================
  // Lobby helper (F8): lists rooms whose access control leaks or isn't
  // enforced server-side. Off by default; nothing is joined automatically.
  //
  // Evidence (live-verified):
  //  - options.gamePass is broadcast in plaintext to every client, but the
  //    server DOES validate it on join (wrong pass -> "Unable to join").
  //  - options.onlyFriends is a client-side filter only; the join RPC does
  //    not check it (joined a stranger's friends-only room).
  //  - options.onlyPatrons is hidden from the list for non-perks accounts;
  //    with hasPerks patched they appear (server check untested).
  // =====================================================================
  const LOBBY_KEY = 'ut-unlock-lobby-open';

  function storeMap() {
    const a = window.accountStore;
    return a && a._p && a._p._s ? a._p._s : null;
  }

  function callRpc(name, payload) {
    const stores = storeMap();
    const api = stores && stores.get('apiStore');
    if (api && typeof api.send === 'function') return api.send(name, payload);
    // fallback: the accountStore holds the same bound api in its actions
    if (window.apiStore) return window.apiStore.send(name, payload);
    throw new Error('no apiStore handle (open the site with ?debug, or wait for login)');
  }


  // Every game row in gamesStore where we appear as a player.
  function staleSeats(me) {
    const stores = storeMap();
    const games = stores && stores.get('gamesStore');
    if (!games || !me) return [];
    return (games.gamesStore || []).filter(g => {
      const ks = g.__keys || Object.keys(g);
      return ks.indexOf('_player_' + me) !== -1;
    });
  }

  // Leave each seat with the app's own payload shape (myGameStore.do -> wsSnubGame), then let the
  // server eject us. FINISH+LEAVE is the state the app sends; the eject is asynchronous.
  async function leaveSeats(seats) {
    const stores = storeMap();
    const api = stores && stores.get('apiStore');
    if (!api) return;
    for (const g of seats) {
      if (!g.engineHost) continue;
      try {
        await api.send(g.engineHost, {
          gameUid: g.gameUid,
          action: 'state-request',
          data: { state: 'FINISH+LEAVE' },
          seat: 0,
          bizarro: false,
        });
        log('left stale seat', g.title || g.gameUid);
      } catch (e) {
        warn('leave failed', g.title, e);
      }
    }
  }

  function gameRows(raw) {
    const rows = [];
    // Mirror the app's own list getter: never surface rooms we're blocked from, rooms whose
    // creator we blocked, started rooms, or full rooms. Listing those is a privacy leak and
    // a join attempt against them is the actual harm.
    const acct = (window.accountStore && window.accountStore.account) || {};
    const me = acct.username;
    const myBlocks = Array.isArray(acct.blocks) ? acct.blocks : [];
    for (const g of raw || []) {
      if (!g || !g.options) continue;
      const blocked = Array.isArray(g.options.blockedUsers) && me && g.options.blockedUsers.indexOf(me) !== -1;
      if (blocked) continue;
      if (g.creator && myBlocks.indexOf(g.creator) !== -1) continue;
      if (g.started) continue;
      const seats = Object.keys(g).filter(k => k.startsWith('_player_')).length;
      const max = g.maxPlayers || 0;
      if (max && seats >= max) continue;
      const pass = g.options.gamePass || null;
      const friends = Array.isArray(g.options.onlyFriends) ? g.options.onlyFriends : null;
      const patrons = !!g.options.onlyPatrons;
      if (!pass && !friends && !patrons) continue;
      rows.push({
        uid: g.gameUid,
        engine: g.engineHost || null,
        title: g.title || '(untitled)',
        creator: g.creator || '?',
        ccg: g.ccg || '',
        seats, max: g.maxPlayers || 0,
        started: !!g.started,
        pass, friends, patrons,
        raw: g,
      });
    }
    return rows;
  }

  function el(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildLobby() {
    if (state.lobby && state.lobby.isConnected) return state.lobby;
    state.lobby = null;

    const panel = el('div', [
      'position:fixed', 'right:10px', 'top:10px', 'width:430px', 'max-height:70vh',
      'overflow:auto', 'z-index:2147483646', 'background:rgba(18,18,18,0.96)',
      'border:1px solid #0f0', 'border-radius:6px', 'color:#ddd',
      'font-family:monospace', 'font-size:11px', 'padding:8px', 'box-shadow:0 4px 16px rgba(0,0,0,0.6)',
    ].join(';'));
    panel.id = 'ut-lobby-panel';

    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;');
    head.appendChild(el('b', 'color:#0f0;', 'UT lobby helper'));
    const closeBtn = el('button', 'cursor:pointer;background:#333;color:#ddd;border:1px solid #555;border-radius:3px;padding:1px 6px;', 'close');
    closeBtn.onclick = () => toggleLobby(false);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const status = el('div', 'color:#ffd24a;min-height:14px;margin-bottom:4px;');
    status.id = 'ut-lobby-status';
    panel.appendChild(status);
    state.lobbyStatus = status;

    const body = el('div', '');
    body.id = 'ut-lobby-body';
    panel.appendChild(body);
    state.lobbyBody = body;

    if (document.body) {
      document.body.appendChild(panel);
      state.lobby = panel;
    }
    return panel;
  }

  function waitFor(fn, timeoutMs) {
    return new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = !!fn(); } catch (e) { ok = false; }
        if (ok) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(tick, 350);
      };
      tick();
    });
  }

  function setLobbyStatus(msg) {
    if (state.lobbyStatus) state.lobbyStatus.textContent = msg || '';
  }

  function renderLobby(rows, err) {
    if (!state.lobbyOpen) return;
    const body = state.lobbyBody;
    if (!body) return;
    if (state.joining) return; // don't yank the row out from under an in-flight join
    // Skip the rebuild when nothing the panel shows has changed: this used to throw away and
    // recreate every row (and re-run layout) once per poll even on an idle lobby.
    const sig = err ? 'E' + err : rows.map(r => [r.uid, r.seats, r.max, r.pass, r.started, r.patrons,
      r.friends ? r.friends.length : 0].join('~')).join('|');
    if (sig === state.lobbySig && body.childElementCount) return;
    state.lobbySig = sig;
    body.textContent = '';
    if (err) {
      body.appendChild(el('div', 'color:#f55;', String(err).slice(0, 300)));
      return;
    }
    if (!rows.length) {
      body.appendChild(el('div', 'color:#888;', 'No password / friends-only / patron-only rooms in the list right now.'));
      return;
    }
    body.appendChild(el('div', 'color:#888;margin-bottom:4px;',
      rows.length + ' restricted room(s) — password values are broadcast in plaintext; friends-only is not server-checked.'));
    for (const r of rows) {
      const row = el('div', 'border-top:1px solid #333;padding:4px 0;');
      const line1 = el('div', 'color:#fff;');
      line1.textContent = r.title + '  [' + r.ccg + ']  ' + r.seats + '/' + r.max + (r.started ? '  (started)' : '');
      row.appendChild(line1);
      const line2 = el('div', 'color:#888;');
      line2.textContent = 'by ' + r.creator;
      row.appendChild(line2);
      const tags = [];
      if (r.pass) tags.push('password: ' + r.pass);
      if (r.friends) tags.push('friends-only (' + r.friends.length + ' allowed)');
      if (r.patrons) tags.push('patrons-only');
      const tagLine = el('div', 'color:#ffd24a;');
      tagLine.textContent = tags.join(' · ');
      row.appendChild(tagLine);
      if (r.friends) {
        const f = el('div', 'color:#666;', r.friends.join(', ').slice(0, 300));
        row.appendChild(f);
      }
      const btn = el('button', 'margin-top:3px;cursor:pointer;background:#0f0;color:#000;border:none;border-radius:3px;padding:1px 8px;font-size:11px;', 'join');
      btn.onclick = async () => {
        // Join through the app's own action (gamesStore.joinGame), then keep the room
        // visible to the client-side list getter, which filters friends-only rooms
        // (h.creator!==me && onlyFriends && !onlyFriends.includes(me)) and blockedUsers
        // even for rows where we are seated. Without the patch myGameStore.obj never
        // resolves and the seat exists server-side but is invisible to us.
        const stores = storeMap();
        const games = stores && stores.get('gamesStore');
        const myGame = stores && stores.get('myGameStore');
        if (!games || typeof games.joinGame !== 'function') {
          btn.textContent = 'unavailable';
          setLobbyStatus('gamesStore.joinGame unavailable');
          return;
        }
        const acct = window.accountStore && window.accountStore.account;
        if (!acct || !acct.email_valid) {
          btn.textContent = 'validate email first';
          setLobbyStatus('account email is not validated — join blocked');
          return;
        }
        if (state.joining) { btn.textContent = 'busy'; return; }

        // The server allows several simultaneous seats and gamesStore.upsertGame silently drops any
        // game whose gameUid !== myGame.obj.gameUid, so a stale seat anywhere makes every new join
        // invisible. Leave ALL stale seats (except the target) before joining.
        const stale = staleSeats(acct.username).filter(g => g.gameUid !== r.uid);
        if (stale.length) {
          const names = stale.map(g => '"' + (g.title || g.gameUid) + '"').join(', ');
          if (!window.confirm('You are still seated at ' + names + '. Leave to join "' + r.title + '"?')) {
            btn.textContent = 'join';
            return;
          }
          btn.textContent = 'leaving old seats...';
          await leaveSeats(stale);
          if (!(await waitFor(() => staleSeats(acct.username).filter(g => g.gameUid !== r.uid).length === 0, 6000))) {
            btn.textContent = 'join';
            setLobbyStatus('could not leave a stale seat — reload untap and retry');
            return;
          }
        }

        if (!window.confirm('Join "' + r.title + '" by ' + r.creator + '?')) { btn.textContent = 'join'; return; }

        state.joining = r.uid;
        btn.textContent = 'joining...';
        try {
          await games.joinGame(r.raw);
          const me = acct.username;
          // Touch only the row we joined, by index, and never call games.list here: that getter maps
          // every room in the store through its filters, and this used to run twice a second.
          const patch = () => {
            const store = games.gamesStore || [];
            for (let i = 0; i < store.length; i++) {
              const g = store[i];
              if (g.gameUid !== r.uid || !g.options) continue;
              if (Array.isArray(g.options.onlyFriends) && g.options.onlyFriends.indexOf(me) === -1) {
                g.options.onlyFriends.push(me);
              }
              if (Array.isArray(g.options.blockedUsers)) {
                g.options.blockedUsers = g.options.blockedUsers.filter(u => u !== me);
              }
              return;
            }
          };
          patch();
          const patcher = setInterval(patch, 1000);
          const ok = await waitFor(() => {
            patch();
            return !!(myGame && myGame.obj && myGame.obj.gameUid === r.uid);
          }, 6000);
          clearInterval(patcher);
          state.joining = null;
          if (ok) {
            try { myGame.enterGame('ut-lobby'); } catch (e) { /* ignore */ }
            setLobbyStatus('joined: ' + r.title);
            log('lobby join confirmed', r.title);
            toggleLobby(false);
          } else {
            btn.textContent = 'unconfirmed';
            setLobbyStatus('join not confirmed — check the app notice');
            log('lobby join unconfirmed', r.title);
          }
        } catch (e) {
          state.joining = null;
          btn.textContent = 'error';
          setLobbyStatus('join failed: ' + String((e && e.message) || e).slice(0, 120));
          log('lobby join error', e);
        }
      };
      row.appendChild(btn);
      body.appendChild(row);
    }
  }

  async function refreshLobby() {
    if (!state.lobbyOpen) return;
    if (document.hidden) return; // don't poll a background tab
    const account = window.accountStore && window.accountStore.account;
    if (!account || !account.username) {
      renderLobby([], 'Log in to use the lobby helper.');
      return;
    }
    const stores = storeMap();
    const myGame = stores && stores.get('myGameStore');
    if (myGame && myGame.inGame) {
      renderLobby([], 'In a game — leave it to use the lobby helper.');
      return;
    }
    const api = stores && stores.get('apiStore');
    if (api && api.socketConnected === false) {
      renderLobby([], 'Waiting for the game socket to connect...');
      return;
    }
    // The app already broadcasts games-list-ge2 to every connected client, so the store is the cheap
    // source of truth. Requesting the list over the socket costs ~150-190ms of blocking (the app
    // re-renders its own 100+ room lobby from the push), so only ask when the store is empty, and
    // otherwise poll it on a 30s timer.
    const games = stores && stores.get('gamesStore');
    const cached = games && Array.isArray(games.gamesStore) ? games.gamesStore : null;
    const fresh = state.lobbyFetchedAt && Date.now() - state.lobbyFetchedAt < 30000;
    if (cached && cached.length && fresh) {
      renderLobby(gameRows(cached), null);
      return;
    }
    try {
      const raw = await callRpc('games-list-ge2', null);
      state.lobbyFetchedAt = Date.now();
      renderLobby(gameRows(raw), null);
    } catch (e) {
      if (cached && cached.length) renderLobby(gameRows(cached), null);
      else renderLobby([], e);
    }
  }

  function toggleLobby(force) {
    const next = typeof force === 'boolean' ? force : !state.lobbyOpen;
    state.lobbyOpen = next;
    try { localStorage.setItem(LOBBY_KEY, next ? '1' : ''); } catch (e) { /* ignore */ }
    if (next) {
      buildLobby();
      state.lobbyFetchedAt = 0;
      refreshLobby();
      if (!state.lobbyTimer) {
        state.lobbyTimer = setInterval(() => {
          // body may not have existed when the panel was first built, or the app replaced it
          if (document.body && (!state.lobby || !state.lobby.isConnected)) buildLobby();
          refreshLobby();
        }, 5000);
      }
    } else {
      state.lobbySig = null;
      if (state.lobbyTimer) { clearInterval(state.lobbyTimer); state.lobbyTimer = null; }
      if (state.lobby && state.lobby.parentNode) state.lobby.parentNode.removeChild(state.lobby);
      state.lobby = null;
    }
  }

  // =====================================================================
  // Second-seat claim (F9): the app lets you play more than one seat in the
  // same game (claimSeatLabel: "Play a second seat" / "Play another seat"),
  // but gates the button behind auths.perks — secondSeat()/claimSeat() both
  // open the upgrade modal when !$account.auths.perks. The underlying store
  // action myGameStore.claimAltSeat() -> do('claim-alt-seat',{}) carries NO
  // perk check, so with hasPerks already patched the UI button works too; F9
  // just drives the same store action directly so it works even if the button
  // isn't rendered yet. releaseAltSeat() -> do('release-alt-seat') undoes it.
  //
  // Guards mirror the app's own showClaimSeat/canSecondSeat getters so we only
  // fire when a claim is actually legal (avoids a wasted RPC + server reject):
  //   - must be in a game, as a player (not spectator)
  //   - gameType 'game', not a deckvdeck table
  //   - game state PENDING, room not full, haven't played yet
  //   - current seat count below the app's max (8 — the alt-seat prefix list
  //     "","bizarro-","clone-","alt-","echo-","shadow-","twin-","ghost-")
  // =====================================================================
  const MAX_SEATS = 8;

  function seatState() {
    const stores = storeMap();
    const myGame = stores && stores.get('myGameStore');
    const g = myGame && myGame.obj;
    const acct = (window.accountStore && window.accountStore.account) || {};
    const me = acct.username;
    if (!myGame || !g || !me) return { myGame: null, g: null, reason: 'not in a game' };
    const seats = (g.mySeats || []).length;
    return { myGame, g, me, seats };
  }

  function canClaimSeat(st) {
    const { g, me } = st;
    if (!g) return 'not in a game';
    if (g.isSpectator) return 'spectating — not a player';
    if (g.gameType !== 'game') return 'not a standard game';
    if (g.gameOptions && g.gameOptions.deckvdeck) return 'deck-vs-deck table';
    if (!(g.playerUsernames || []).includes(me)) return 'not seated in this game';
    if (g.currentGame && g.currentGame.state !== 'PENDING') return 'game already started';
    if ((g.gamesPlayed || []).length > 1) return 'already played here';
    const max = g.maxPlayers || 0;
    if (max && (g.players || []).length >= max) return 'room is full';
    if ((g.mySeats || []).length >= MAX_SEATS) return 'already at the seat limit (' + MAX_SEATS + ')';
    return null; // ok
  }

  function claimSecondSeat() {
    const st = seatState();
    if (!st.myGame) { setLobbyStatus(''); log('F9: not in a game'); return; }
    const before = st.seats;
    const why = canClaimSeat(st);
    if (why) { log('F9: cannot claim second seat —', why); return; }
    log('F9: claiming second seat (current seats: ' + before + ')');
    try {
      st.myGame.claimAltSeat();
    } catch (e) {
      warn('F9: claimAltSeat threw', e);
      return;
    }
    // The claim is confirmed asynchronously (server pushes a new _player_ row
    // into gamesStore, obj recomputes mySeats). Poll briefly to log the result.
    const start = Date.now();
    const poll = setInterval(() => {
      const now = seatState();
      if (!now.myGame) { clearInterval(poll); return; }
      if (now.seats > before) {
        clearInterval(poll);
        log('F9: second seat confirmed (seats: ' + now.seats + ')');
      } else if (Date.now() - start > 6000) {
        clearInterval(poll);
        warn('F9: second seat not confirmed within 6s (seats still ' + now.seats + ')');
      }
    }, 300);
  }

  function releaseSecondSeat() {
    const st = seatState();
    if (!st.myGame) { log('F9: not in a game'); return; }
    if (st.seats <= 1) { log('Shift+F9: only one seat — nothing to release'); return; }
    log('Shift+F9: releasing a seat (current seats: ' + st.seats + ')');
    try {
      st.myGame.releaseAltSeat();
    } catch (e) {
      warn('Shift+F9: releaseAltSeat threw', e);
    }
  }

  function bindLobbyHotkey() {
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.repeat) return;
      if (e.key === 'F8' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleLobby();
      }
      if (e.key === 'F9' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (e.shiftKey) releaseSecondSeat();
        else claimSecondSeat();
      }
    });
  }

  // Double-injection guard: a second copy in the same realm must not wrap twice.
  if (window.__utUnlockActive) return;
  window.__utUnlockActive = true;

  function init() {
    log('script loaded');
    ensureChipMounted();
    startPolling();
    bindLobbyHotkey();
    try { if (localStorage.getItem(LOBBY_KEY) === '1') toggleLobby(true); } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();

// ==UserScript==
// @name         Untap.in Perk Unlocker
// @namespace    untap-recon
// @version      1.2.0
// @description  Free-account QoL unlocks with a collapsible green-dot menu: lobby, card sleeve, local playmat, multi-seat game, stats CSV, deck export
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
    menu: null,
    menuOpen: false,
    chipInterval: null,
    lobby: null,
    lobbyBody: null,
    lobbyOpen: false,
    lobbyTimer: null,
    lobbyStatus: null,
    joining: null,
    matStyleEl: null,
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

  // ---- green-dot menu ----
  // A tiny draggable green dot in the corner. Clicking it opens a collapsible
  // panel with the status line and a button per feature; nothing is keybind-only.
  const CHIP_POS_KEY = 'ut-unlock-chip-pos';
  const MENU_OPEN_KEY = 'ut-unlock-menu-open';

  function loadChipPos() {
    try { return JSON.parse(localStorage.getItem(CHIP_POS_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveChipPos(x, y) {
    try { localStorage.setItem(CHIP_POS_KEY, JSON.stringify({ x, y })); } catch (e) { /* ignore */ }
  }

  function menuBtn(text, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = [
      'display:block', 'width:100%', 'text-align:left', 'margin:3px 0',
      'padding:5px 8px', 'cursor:pointer', 'background:#1b1b1b', 'color:#ddd',
      'border:1px solid #0a0', 'border-radius:4px', 'font-size:11px',
      'font-family:sans-serif', 'white-space:nowrap',
    ].join(';');
    b.addEventListener('mouseenter', () => { b.style.background = '#262626'; });
    b.addEventListener('mouseleave', () => { b.style.background = '#1b1b1b'; });
    b.addEventListener('click', (ev) => { ev.stopPropagation(); try { onClick(); } catch (e) { warn('menu action failed', e); } });
    return b;
  }

  function setMenuOpen(open) {
    state.menuOpen = open;
    try { localStorage.setItem(MENU_OPEN_KEY, open ? '1' : ''); } catch (e) { /* ignore */ }
    if (state.menu) state.menu.style.display = open ? 'block' : 'none';
    if (state.chip) state.chip.style.opacity = open ? '1' : '0.5';
  }

  function buildChip() {
    // Only trust the cache while the node is actually in the document;
    // a detached chip (removed by the app or body not yet ready) must be rebuilt.
    if (state.chip && state.chip.isConnected) return state.chip;
    state.chip = null;

    const container = document.createElement('div');
    container.id = 'ut-unlock-chip';
    container.style.cssText = [
      'position:fixed', 'left:6px', 'bottom:6px', 'z-index:2147483647',
      'font-family:sans-serif', 'display:flex', 'align-items:flex-end', 'gap:6px',
      'opacity:0.5',
    ].join(';');
    const saved = loadChipPos();
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      container.style.right = 'auto'; container.style.bottom = 'auto';
      container.style.left = saved.x + 'px'; container.style.top = saved.y + 'px';
    }

    // The dot: click toggles the menu (collapse), drag repositions.
    const dot = document.createElement('span');
    dot.id = 'ut-unlock-dot';
    dot.textContent = '\u25CF';
    dot.style.cssText = 'cursor:pointer;color:#0f0;font-size:12px;line-height:1;user-select:none;';
    dot.title = 'UT-UNLOCK menu (click to open/close, drag to move)';

    // The collapsible menu panel.
    const menu = document.createElement('div');
    menu.id = 'ut-unlock-menu';
    menu.style.cssText = [
      'display:none', 'background:rgba(16,16,16,0.96)', 'border:1px solid #0a0',
      'border-radius:6px', 'padding:8px', 'min-width:210px', 'max-width:260px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.6)', 'color:#ddd', 'font-size:11px',
    ].join(';');

    const status = document.createElement('div');
    status.id = 'ut-unlock-status';
    status.style.cssText = 'margin-bottom:6px;font-weight:bold;white-space:nowrap;';
    status.textContent = 'initializing...';
    menu.appendChild(status);

    menu.appendChild(menuBtn('Lobby helper (locked rooms)', () => toggleLobby()));
    menu.appendChild(menuBtn('Set card sleeve (deck back)*', () => setCardSleeve()));
    menu.appendChild(menuBtn('Set local playmat (you only)', () => setLocalMat()));
    menu.appendChild(menuBtn('Clear local playmat', () => clearLocalMat()));
    menu.appendChild(menuBtn('Create multi-seat game', () => createMultiSeatGame()));
    menu.appendChild(menuBtn('Download summary CSV', () => downloadSummaryCsv()));
    menu.appendChild(menuBtn('Download game history CSV', () => downloadHistoryCsv()));
    menu.appendChild(menuBtn('Download rich history CSV (slow!)', () => downloadHistoryRichCsv()));
    menu.appendChild(menuBtn('Export player decks (public)', () => exportPlayerDecks()));

    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;color:#888;font-size:10px;line-height:1.3;white-space:normal;';
    note.textContent = 'Multi-seat = deck-vs-deck: you play every seat yourself (no second human). Playmat shows to you only. *Card sleeve may not render.';
    menu.appendChild(note);

    dot.addEventListener('click', (ev) => { ev.stopPropagation(); setMenuOpen(!state.menuOpen); });

    // Dragging the dot repositions the whole chip (saved across reloads).
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
        if (moved) { const r = container.getBoundingClientRect(); saveChipPos(r.left, r.top); }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    container.appendChild(dot);
    container.appendChild(menu);
    state.menu = menu;
    if (document.body) {
      document.body.appendChild(container);
      state.chip = container;
    }
    // restore collapse state
    let open = false;
    try { open = localStorage.getItem(MENU_OPEN_KEY) === '1'; } catch (e) { /* ignore */ }
    setMenuOpen(open);
    return container;
  }

  function updateChip() {
    const container = buildChip();
    if (!container) return;
    const status = container.querySelector('#ut-unlock-status');
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

    const text = (hasPerks ? 'UNLOCKED (client-side)' : 'LOCKED') + deckInfo;
    if (status && state.lastChipText !== text) {
      state.lastChipText = text;
      status.textContent = text;
      status.style.color = hasPerks ? '#0f0' : '#f55';
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
  // Stats export (CSV). Read-only RPCs:
  //  - get-game-summary {username} -> {wins,draws,losses,noRecord,time}
  //  - get-game-stats null -> [{start_time,duration,title,players[],winner,
  //      recorded}, ...] for YOUR OWN account (winner === me counts as a win;
  //      winner "draw"/empty = draw; any other winner = loss). This is the cheap
  //      route to real per-opponent W/L — one RPC, no replay downloads.
  //  - get-profile-replays {username} -> [{game_uid,ccg,title,rounds,start_time,
  //      end_time,event_count,created,size,views,private,players[]}, ...]
  //  - POST /api/replay-fetch {username,token,gameUid} -> {meta, blob}; blob is
  //      base64(gzip(JSON {meta,events})). events carry gameWinner + per-seat
  //      deckUid. Heavy: one fetch + gunzip + parse per game.
  // =====================================================================
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv(filename, rows) {
    const text = rows.map(r => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function msToHMS(ms) {
    if (!(ms > 0)) return '';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
  }

  // Classify a get-game-stats row result from MY perspective (mirrors the app's
  // own chart logic: winner===me -> win; winner "draw"/empty -> draw; else loss).
  function classifyResult(winner, me) {
    if (winner === me) return 'win';
    if (!winner || winner === 'draw') return 'draw';
    return 'loss';
  }

  async function downloadSummaryCsv() {
    const acct = (window.accountStore && window.accountStore.account) || {};
    const me = acct.username;
    if (!me) { log('summary CSV: not logged in'); return; }
    log('summary CSV: fetching...');
    let summary = {}, stats = [];
    try { summary = await callRpc('get-game-summary', me) || {}; }
    catch (e) { warn('summary CSV: get-game-summary failed', e); }
    // get-game-stats carries the per-game winner for YOUR own games.
    try { stats = await callRpc('get-game-stats', null) || []; }
    catch (e) { warn('summary CSV: get-game-stats failed', e); }

    const rows = [];
    rows.push(['section', 'metric', 'value']);
    rows.push(['record', 'wins', summary.wins || 0]);
    rows.push(['record', 'draws', summary.draws || 0]);
    rows.push(['record', 'losses', summary.losses || 0]);
    rows.push(['record', 'unrecorded', summary.noRecord || 0]);
    const totalGames = (summary.wins || 0) + (summary.draws || 0) + (summary.losses || 0) + (summary.noRecord || 0);
    rows.push(['record', 'total_recorded_games', totalGames]);
    rows.push(['record', 'hours_played', summary.time || 0]);
    const decided = (summary.wins || 0) + (summary.losses || 0);
    rows.push(['record', 'win_rate_pct', decided ? (100 * (summary.wins || 0) / decided).toFixed(1) : '']);

    // Per-opponent W/L/D from get-game-stats. For each recorded game, credit the
    // result against every other seat. Multi-player games count the one result
    // against each opponent (noted in the header).
    const vs = {}; // opponent -> {w,l,d,games}
    let usableRows = 0;
    for (const g of stats) {
      if (g.recorded === false) continue; // "Don't Record" games
      const players = g.players || [];
      if (!players.includes(me)) continue;
      const res = classifyResult(g.winner, me);
      usableRows++;
      for (const p of players) {
        if (p === me) continue;
        const o = vs[p] || (vs[p] = { w: 0, l: 0, d: 0, games: 0 });
        o.games++;
        if (res === 'win') o.w++; else if (res === 'loss') o.l++; else o.d++;
      }
    }
    const opps = Object.keys(vs).sort((a, b) => vs[b].games - vs[a].games);
    rows.push([]);
    rows.push(['opponent', 'games', 'wins', 'losses', 'draws', 'win_rate_pct']);
    if (!opps.length) {
      rows.push(['(no recorded games found via get-game-stats)', '', '', '', '', '']);
    } else {
      for (const o of opps) {
        const v = vs[o];
        const dec = v.w + v.l;
        rows.push([o, v.games, v.w, v.l, v.d, dec ? (100 * v.w / dec).toFixed(1) : '']);
      }
    }
    rows.push([]);
    rows.push(['note', 'per-opponent W/L/D is from get-game-stats (your own recorded games only); multi-player games credit the single result against each opponent', '']);

    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv('untap-summary-' + me + '-' + stamp + '.csv', rows);
    log('summary CSV: downloaded (' + opps.length + ' opponents, ' + usableRows + ' recorded games)');
  }

  async function downloadHistoryCsv() {
    const acct = (window.accountStore && window.accountStore.account) || {};
    const me = acct.username;
    if (!me) { log('history CSV: not logged in'); return; }
    log('history CSV: fetching...');
    let replays = [];
    try { replays = await callRpc('get-profile-replays', me) || []; }
    catch (e) { warn('history CSV: get-profile-replays failed', e); return; }

    const rows = [];
    rows.push(['game_uid', 'created', 'format', 'title', 'opponents', 'rounds', 'duration', 'event_count', 'private']);
    const sorted = replays.slice().sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
    for (const r of sorted) {
      const opponents = (r.players || []).filter(p => p !== me).join('; ');
      const dur = (r.end_time && r.start_time) ? msToHMS(r.end_time - r.start_time) : '';
      rows.push([
        r.game_uid, r.created, r.ccg, r.title, opponents,
        r.rounds != null ? r.rounds : '', dur,
        r.event_count != null ? r.event_count : '', r.private ? 'yes' : 'no',
      ]);
    }
    if (!replays.length) rows.push(['(no replays in history)', '', '', '', '', '', '', '', '']);

    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv('untap-history-' + me + '-' + stamp + '.csv', rows);
    log('history CSV: downloaded (' + replays.length + ' games)');
  }

  // Fetch + decode a single replay. Returns {winner, decks:{player:deckUid}} or
  // null on failure. Winner comes from the last ENDED gamesPlayed entry's
  // playerObjs[*].gameWinner; decks from game-deck-insert/update events.
  async function fetchReplayDetail(gameUid) {
    const api = (storeMap() && storeMap().get('apiStore'));
    const auth = (api && api.auth) || {};
    let data;
    try {
      const resp = await fetch('/api/replay-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: auth.username, token: auth.token, gameUid }),
      });
      if (!resp.ok) return null;
      data = await resp.json();
    } catch (e) { return null; }
    if (!data || !data.blob) return null;
    let obj;
    try {
      const bin = Uint8Array.from(atob(data.blob), c => c.charCodeAt(0));
      const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
      const buf = await new Response(stream).arrayBuffer();
      obj = JSON.parse(new TextDecoder().decode(buf));
    } catch (e) { return null; }

    const events = obj.events || [];
    // winner: scan events for gamesPlayed entries, keep the last ENDED one's winner
    let winner = null;
    const scanForWinner = (val) => {
      if (!val || typeof val !== 'object') return;
      if (Array.isArray(val.gamesPlayed)) {
        for (const gp of val.gamesPlayed) {
          if (gp && gp.state === 'ENDED' && gp.playerObjs) {
            for (const u of Object.keys(gp.playerObjs)) {
              const gw = gp.playerObjs[u] && gp.playerObjs[u].gameWinner;
              if (gw) winner = gw;
            }
          }
        }
      }
    };
    const decks = {};
    for (const ev of events) {
      const d = ev && ev.d;
      if (!d) continue;
      if (ev.e === 'game-upsert') scanForWinner(d);
      if (ev.e === 'game-upsert-path' && Array.isArray(d.path) && d.path[0] === 'gamesPlayed') {
        // winner updates arrive as a path write; the full-object scan above
        // usually catches it, but capture a direct gameWinner path too.
        if (d.path.indexOf('gameWinner') !== -1 && d.data) winner = d.data;
      }
      if ((ev.e === 'game-deck-insert' || ev.e === 'game-deck-update') && d.player && d.deckUid) {
        decks[d.player] = d.deckUid;
      }
    }
    return { winner, decks };
  }

  async function downloadHistoryRichCsv() {
    const acct = (window.accountStore && window.accountStore.account) || {};
    const me = acct.username;
    if (!me) { log('rich history CSV: not logged in'); return; }
    let replays = [];
    try { replays = await callRpc('get-profile-replays', me) || []; }
    catch (e) { warn('rich history CSV: get-profile-replays failed', e); return; }
    if (!replays.length) { log('rich history CSV: no replays'); downloadCsv('untap-history-rich-' + me + '.csv', [['(no replays in history)']]); return; }

    const n = replays.length;
    const ok = window.confirm(
      'Rich history export downloads and decodes EVERY replay (' + n + ' games) one by one to\n' +
      'recover the winner and each player\'s deck. This is SLOW — roughly ' +
      Math.ceil(n * 0.7) + '-' + Math.ceil(n * 1.5) + ' seconds, possibly much longer for big games.\n\n' +
      'Replays older than ~60 days may no longer be fetchable. Continue?'
    );
    if (!ok) { log('rich history CSV: cancelled'); return; }

    log('rich history CSV: fetching ' + n + ' replays (this is slow)...');
    const sorted = replays.slice().sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
    const rows = [];
    rows.push(['game_uid', 'created', 'format', 'title', 'opponents', 'winner', 'my_result', 'my_deck_uid', 'player_decks', 'rounds', 'duration', 'event_count']);
    let done = 0, failed = 0;
    for (const r of sorted) {
      const opponents = (r.players || []).filter(p => p !== me).join('; ');
      const dur = (r.end_time && r.start_time) ? msToHMS(r.end_time - r.start_time) : '';
      let winner = '', myResult = '', myDeck = '', playerDecks = '';
      const detail = await fetchReplayDetail(r.game_uid);
      if (detail) {
        winner = detail.winner || '';
        myResult = detail.winner ? classifyResult(detail.winner, me) : '';
        myDeck = detail.decks[me] || '';
        playerDecks = Object.keys(detail.decks).map(p => p + '=' + detail.decks[p]).join('; ');
      } else {
        failed++;
      }
      rows.push([
        r.game_uid, r.created, r.ccg, r.title, opponents, winner, myResult, myDeck, playerDecks,
        r.rounds != null ? r.rounds : '', dur, r.event_count != null ? r.event_count : '',
      ]);
      done++;
      if (done % 5 === 0) log('rich history CSV: ' + done + '/' + n + ' done');
    }

    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv('untap-history-rich-' + me + '-' + stamp + '.csv', rows);
    log('rich history CSV: downloaded (' + done + ' games, ' + failed + ' could not be fetched)');
  }

  // =====================================================================
  // Player deck export (PUBLIC decks only). Given a username, list that user's
  // public decks (get-profile) and their public replays (get-profile-replays),
  // pull the deckUids each replay used (replay-fetch -> game-deck-update
  // .deckUid), then get-deck each PUBLIC one and write a decklist export.
  //
  // We deliberately skip decks the profile marks visibility:"private" (uid is
  // null there anyway). A private deck whose uid leaks via a replay is
  // technically fetchable (get-deck has no ownership check) but exporting
  // someone's private deck is not something this script does.
  // =====================================================================
  const CARD_ZONES = ['deck-1', 'play-1', 'maybe-1'];

  function deckMeta(deck) {
    // Commander = cards in play-1; bracket isn't stored by untap, so we derive a
    // rough Bracket estimate from game-changers/land count when format=commander.
    const cards = deck.cards || [];
    const commanders = cards.filter(c => c.zone === 'play-1').map(c => c.title);
    const total = cards.filter(c => c.zone === 'deck-1').reduce((n, c) => n + (c.qty || 1), 0);
    return {
      title: deck.title || '',
      format: deck.format || '',
      commanders,
      cardCount: total,
      tags: deck.tags || [],
      description: deck.description || '',
    };
  }

  function deckToTxt(deck, owner) {
    const meta = deckMeta(deck);
    const lines = [];
    lines.push('# ' + (meta.title || 'Untitled') + ' — ' + owner);
    if (meta.format) lines.push('# Format: ' + meta.format);
    if (meta.commanders.length) lines.push('# Commander: ' + meta.commanders.join(', '));
    lines.push('# Cards: ' + meta.cardCount);
    lines.push('');
    if (meta.commanders.length) {
      lines.push('// Commander');
      for (const c of deck.cards.filter(x => x.zone === 'play-1')) lines.push('1 ' + c.title);
      lines.push('');
    }
    lines.push('// Deck');
    for (const c of deck.cards.filter(x => x.zone === 'deck-1')) lines.push((c.qty || 1) + ' ' + c.title);
    const maybe = deck.cards.filter(x => x.zone === 'maybe-1');
    if (maybe.length) {
      lines.push('');
      lines.push('// Maybeboard');
      for (const c of maybe) lines.push((c.qty || 1) + ' ' + c.title);
    }
    return lines.join('\n');
  }

  async function exportPlayerDecks() {
    const raw = window.prompt('Export public decks for which username?', '');
    if (!raw) { log('deck export: cancelled'); return; }
    const target = String(raw).trim();
    if (!target) return;
    log('deck export: fetching profile for', target);

    let profile, replays = [];
    try { profile = await callRpc('get-profile', target); }
    catch (e) { warn('deck export: get-profile failed', e); return; }
    try { replays = await callRpc('get-profile-replays', target) || []; }
    catch (e) { warn('deck export: get-profile-replays failed', e); }

    // 1. Public decks straight off the profile (private ones have deck_uid null).
    const publicDecks = ((profile && profile.decks) || []).filter(d => d && d.deck_uid && d.visibility === 'public');
    const seen = new Set(publicDecks.map(d => d.deck_uid));

    // 2. deckUids used in their public replays that aren't already on the profile.
    //    Only keep ones the profile confirms as public (owner+visibility check).
    const byUid = {};
    for (const d of publicDecks) byUid[d.deck_uid] = d;
    let extra = 0;
    if (replays.length) {
      log('deck export: scanning ' + replays.length + ' replays for deck uids...');
      const limit = Math.min(replays.length, 25); // cap: replay-fetch is heavy
      for (let i = 0; i < limit; i++) {
        const detail = await fetchReplayDetail(replays[i].game_uid);
        if (!detail || !detail.decks) continue;
        for (const player of Object.keys(detail.decks)) {
          if (player !== target) continue;
          const uid = detail.decks[player];
          if (!uid || seen.has(uid)) continue;
          seen.add(uid);
          // only export if the profile lists it as public
          const meta = ((profile.decks || []).find(x => x && x.deck_uid === uid));
          if (meta && meta.visibility === 'public') { byUid[uid] = meta; extra++; }
        }
      }
    }

    const uids = Object.keys(byUid);
    if (!uids.length) {
      log('deck export: no public decks found for ' + target);
      downloadCsv('untap-decks-' + target + '.csv', [['username', 'title', 'format', 'commander', 'cards', 'visibility']].concat([['(no public decks)', '', '', '', '', '']]));
      return;
    }

    log('deck export: fetching ' + uids.length + ' public decks...');
    const index = [['username', 'title', 'format', 'commander', 'cards', 'visibility', 'tags']];
    const bundle = [];
    let ok = 0, failed = 0;
    for (const uid of uids) {
      let full;
      try { full = await callRpc('get-deck', uid); }
      catch (e) { failed++; continue; }
      if (!full || full.visibility !== 'public') { failed++; continue; }
      ok++;
      const meta = deckMeta(full);
      index.push([target, meta.title, meta.format, meta.commanders.join('; '), meta.cardCount, 'public', meta.tags.join('; ')]);
      bundle.push(deckToTxt(full, target));
    }

    // CSV index of all their public decks + one .txt per deck in a single bundle.
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv('untap-decks-' + target + '-' + stamp + '.csv', index);
    const all = bundle.join('\n\n' + '='.repeat(60) + '\n\n');
    const blob = new Blob([all], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'untap-decklists-' + target + '-' + stamp + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    log('deck export: ' + ok + ' public decks exported' + (failed ? ', ' + failed + ' skipped' : '') + (extra ? ', ' + extra + ' found via replays' : ''));
  }

  // =====================================================================
  // Multi-seat game (deck-vs-deck): the paid "play multiple seats yourself"
  // capability. The direct claim-alt-seat action is SERVER-enforced (a free
  // account gets ["Claiming a second seat is a Powered-Up perk.", ...]), so it
  // cannot be unlocked. BUT the deck-vs-deck game mode seats you in every slot
  // at creation and never calls claim-alt-seat — and create-game-ge2 accepts
  // deckvdeck:true from a free account (the UI toggle is client-gated only).
  // Confirmed live: created with deckvdeck:true, deckvdeckSeats:N as a free
  // account -> you control all N seats (mySeats = [you, bizarro-you, ...]).
  //
  // Caveat: deck-vs-deck is a SOLO table (players:1, maxPlayers===seats, all
  // seats filled by you) — no second human can join. It's self-play across
  // your own decks, which is the multi-seat experience, not a shared lobby.
  // =====================================================================
  async function createMultiSeatGame() {
    const stores = storeMap();
    const api = stores && stores.get('apiStore');
    if (!api || typeof api.send !== 'function') { warn('multi-seat: no apiStore'); return; }
    const acct = (window.accountStore && window.accountStore.account) || {};
    if (!acct.username) { log('multi-seat: not logged in'); return; }

    const raw = window.prompt('How many seats (decks) do you want to play? (2-6)', '2');
    if (raw == null) return;
    let seats = parseInt(raw, 10);
    if (!(seats >= 2 && seats <= 6)) { log('multi-seat: seat count must be 2-6'); return; }

    // Pick a game type from the user's decks (ccg/type must match a deck they own).
    const decks = myDecks();
    const type = decks.length ? (decks[0].type || 'mtg') : 'mtg';

    const payload = {
      gameType: 'game', title: 'multi-seat', engine: 'ge2', type, ccg: type,
      format: null, players: 1, blocks: (acct.blocks || []), gamePass: null,
      maxDeckValue: null, mirror: false, deckvdeck: true, deckvdeckSeats: seats,
      teamPlay: false, allowSpectators: true, privateReplay: false,
      onlyDraftDecks: false, onlyFriends: false, onlySportsmanship: false,
      onlyPatrons: false,
    };
    log('multi-seat: creating deck-vs-deck game with', seats, 'seats');
    try {
      const resp = await api.send('create-game-ge2', payload);
      // success: [null, "Game created.", "G-xxxx"]
      if (Array.isArray(resp) && resp[0]) { warn('multi-seat: rejected —', resp[0]); return; }
      const uid = Array.isArray(resp) ? resp[2] : null;
      if (uid) {
        log('multi-seat: created', uid, '— opening');
        window.location.href = '/' + uid;
      } else {
        log('multi-seat: created (no uid in reply)', resp);
      }
    } catch (e) {
      warn('multi-seat: create-game-ge2 failed', e);
    }
  }

  // =====================================================================
  // Custom card sleeve / card back: pushes a per-deck sleeve via update-deck-back
  // (served from the ungated /cardimg/<deck_uid>/deck_back route, unlike the
  // tier-gated account-level set-user-image type:'deck' -> /sleeve/<username>).
  // The RPC is accepted and the uid persists, but in testing the sleeve did NOT
  // render in-game, so this may not actually work — kept in case the path works
  // on another account/setup. We pick an image file locally and push it.
  // =====================================================================
  const SLEEVE_W = 223, SLEEVE_H = 310; // untap's recommended sleeve size

  function pickImageFile(maxW, maxH) {
    // Returns a Promise<dataUri> for a user-chosen image, rescaled to fit maxW x maxH.
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) { reject(new Error('no file')); return; }
        const fr = new FileReader();
        fr.onload = () => {
          const img = new Image();
          img.onload = () => {
            // scale down to fit the target box, keep aspect, never upscale
            const scale = Math.min(1, maxW / img.width, maxH / img.height);
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            try { resolve(c.toDataURL('image/png')); }
            catch (e) { reject(e); }
          };
          img.onerror = () => reject(new Error('bad image'));
          img.src = fr.result;
        };
        fr.onerror = () => reject(new Error('read failed'));
        fr.readAsDataURL(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function myDecks() {
    const stores = storeMap();
    const ds = stores && stores.get('deckStore');
    return (ds && Array.isArray(ds.deckListStore)) ? ds.deckListStore : [];
  }

  // Resolve which deck to set the sleeve on: the deck loaded in the current game
  // if we're in one, else the only deck, else ask.
  function targetDeckUid() {
    const stores = storeMap();
    const myGame = stores && stores.get('myGameStore');
    const g = myGame && myGame.obj;
    if (g && g.my && g.my.deck && g.my.deck.deck_uid) return g.my.deck.deck_uid;
    const decks = myDecks();
    if (decks.length === 1) return decks[0].deck_uid;
    if (decks.length > 1) {
      const titles = decks.map((d, i) => (i + 1) + ') ' + (d.title || d.deck_uid));
      const pick = window.prompt('Which deck gets the sleeve?\n' + titles.join('\n') + '\n\nEnter a number:', '1');
      const idx = parseInt(pick, 10) - 1;
      if (idx >= 0 && idx < decks.length) return decks[idx].deck_uid;
      return null;
    }
    return null;
  }

  async function setCardSleeve() {
    const deckUid = targetDeckUid();
    if (!deckUid) { log('sleeve: no deck to set a sleeve on'); return; }
    let dataUri;
    try { dataUri = await pickImageFile(SLEEVE_W, SLEEVE_H); }
    catch (e) { log('sleeve: image pick cancelled'); return; }
    log('sleeve: uploading to deck', deckUid);
    try {
      const resp = await callRpc('update-deck-back', { deck_uid: deckUid, dataUri, zone: 'deck-1' });
      // success reply is [null, "Success, card sleeve updated."]; error is [msg, ...]
      if (Array.isArray(resp) && resp[0]) { warn('sleeve rejected —', resp[0]); return; }
      // The RPC persists the uid, but the app caches card images by [uid,set] and
      // won't re-fetch an already-loaded default back. Bust the cardStore cache
      // (what the deck editor itself does via rmCardCache) and poke deck.deck_back
      // so the sleeve actually shows without a reload.
      try {
        const stores = storeMap();
        const cardStore = stores && stores.get('cardStore');
        const bust = (cardStore && (cardStore.rmCardCache || cardStore.removeBusCard));
        if (cardStore && typeof cardStore.rmCardCache === 'function') {
          cardStore.rmCardCache(deckUid, 'deck_back');
          cardStore.rmCardCache(deckUid, 'deck_back_2');
        }
        const ds = stores && stores.get('deckStore');
        const deck = ds && Array.isArray(ds.deckListStore) && ds.deckListStore.find(d => d && d.deck_uid === deckUid);
        if (deck) deck.deck_back = 'new' + Date.now();
        // Drop any HTTP-cached copy too.
        try { fetch('/cardimg/' + deckUid + '/deck_back?', { cache: 'reload' }); } catch (e) { /* ignore */ }
      } catch (e) { warn('sleeve: cache-bust failed (sleeve still saved server-side)', e); }
      log('sleeve set (served via /cardimg/' + deckUid + '/deck_back). If already in a game, reload to see it.');
    } catch (e) {
      warn('sleeve: update-deck-back failed', e);
    }
  }

  // =====================================================================
  // Local playmat: board background, LOCAL-ONLY (visible to you, not to
  // opponents). The real playmat is served from /playmat/<username>?<uid>,
  // which the server refuses (410) for free accounts and which every opponent's
  // own client fetches independently — so there is no way to make a custom mat
  // opponent-visible without a Powered-Up account. This paints your own board
  // via an injected !important stylesheet and persists the image in localStorage.
  // =====================================================================
  const MAT_KEY = 'ut-unlock-local-mat';

  function applyLocalMat(dataUri) {
    if (!state.matStyleEl) {
      state.matStyleEl = document.createElement('style');
      state.matStyleEl.id = 'ut-unlock-mat-style';
      document.head.appendChild(state.matStyleEl);
    }
    if (!dataUri) { state.matStyleEl.textContent = ''; return; }
    // .playmat.mine is our own board layer; force our image over the default and
    // raise opacity (default playmatOpacity is 0.1) so it's actually visible.
    state.matStyleEl.textContent =
      '.playmat.mine{background-image:url("' + dataUri + '")!important;' +
      'background-size:cover!important;background-position:center!important;opacity:1!important;}';
  }

  function restoreLocalMat() {
    let saved = null;
    try { saved = localStorage.getItem(MAT_KEY); } catch (e) { /* ignore */ }
    if (saved) applyLocalMat(saved);
  }

  async function setLocalMat() {
    let dataUri;
    try { dataUri = await pickImageFile(1208, 340); } // 2x the recommended 604x170
    catch (e) { log('playmat: image pick cancelled'); return; }
    try { localStorage.setItem(MAT_KEY, dataUri); } catch (e) { warn('playmat: could not persist (too large?)'); }
    applyLocalMat(dataUri);
    log('playmat: local mat applied (visible to you only, not opponents)');
  }

  function clearLocalMat() {
    try { localStorage.removeItem(MAT_KEY); } catch (e) { /* ignore */ }
    applyLocalMat(null);
    log('playmat: local mat cleared');
  }

  // F8 is a convenience hotkey for the lobby helper; every feature is also in
  // the green-dot menu, so nothing is keybind-only.
  function bindLobbyHotkey() {
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.repeat) return;
      if (e.key === 'F8' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleLobby();
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
    restoreLocalMat();
    try { if (localStorage.getItem(LOBBY_KEY) === '1') toggleLobby(true); } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();

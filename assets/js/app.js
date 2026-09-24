/* Secret Santa - participant app.
 *
 * Flow: token -> record id -> decrypt your record -> you now hold your own
 * mailbox keys and your giftee's mailbox keys, and nothing else.
 */
(function () {
  'use strict';

  var DATA_URL = 'data/santa.json';
  var SESSION_KEY = 'ss.token';
  var REFRESH_MS = 60000;

  var state = {
    data: null,
    api: null,
    token: null,
    record: null,
    refreshTimer: null
  };

  var $ = function (id) { return document.getElementById(id); };

  function show(el, visible) { el.hidden = !visible; }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (text && kind ? ' ' + kind : '');
  }

  function session(action, value) {
    try {
      if (action === 'get') return sessionStorage.getItem(SESSION_KEY);
      if (action === 'set') sessionStorage.setItem(SESSION_KEY, value);
      if (action === 'clear') sessionStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private mode, or storage blocked - just don't persist */ }
    return null;
  }

  // A background refresh that succeeds should take down a stale "couldn't reach
  // the server" notice, but leave a "Saved." confirmation alone.
  function clearIfError(el) {
    if (el.classList.contains('error')) setMsg(el, '', '');
  }

  // A sign-in link carries the token in the fragment: .../#t=XXXXX-XXXXX-...
  // Fragments are never sent to the server, so the token stays out of GitHub's
  // logs, out of Referer headers, and out of any link-preview fetch a messaging
  // app makes. It is wiped from the address bar the instant it is read, so it
  // does not linger on screen or in a screenshot.
  function takeTokenFromUrl() {
    var match = (location.hash || '').match(/[#&]t=([^&]*)/);
    if (!match) return null;

    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      location.hash = '';
    }

    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }

  function when(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /* ---- boot ------------------------------------------------------------ */

  function boot() {
    // Read this before the fetch resolves, so the token is out of the address
    // bar immediately rather than after a network round trip.
    var linkToken = takeTokenFromUrl();

    fetch(DATA_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('missing');
        return r.json();
      })
      .then(function (data) {
        state.data = data;
        state.api = new SantaApi(data.api);
        if (data.event) {
          $('event-name').textContent = data.event;
          $('event-label').textContent = data.event;
        }
        if (!data.records || Object.keys(data.records).length === 0) {
          setMsg($('login-error'), 'This Secret Santa has not been set up yet.', 'warn');
          $('unlock').disabled = true;
          return;
        }
        // A link beats a leftover session: if someone opens their own link on a
        // shared device, they should land in their own account, not whoever
        // used it last. A bad link reports the error rather than failing quietly.
        if (linkToken) {
          unlock(linkToken, false);
          return;
        }
        var saved = session('get');
        if (saved) unlock(saved, true);
      })
      .catch(function () {
        setMsg($('login-error'), 'Could not load the draw data. Try again in a moment.', 'error');
      });

    $('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      unlock($('token').value, false);
    });

    $('logout').addEventListener('click', signOut);

    // Opening a sign-in link while this page is already loaded changes only the
    // fragment, so the browser does a same-document navigation and boot() never
    // runs again. Without this the tap appears to do nothing and the token is
    // left sitting in the address bar.
    window.addEventListener('hashchange', function () {
      var token = takeTokenFromUrl();
      if (token) unlock(token, false);
    });

    $('tab-giftee').addEventListener('click', function () { selectTab('giftee'); });
    $('tab-mine').addEventListener('click', function () { selectTab('mine'); });

    $('wishlist-save').addEventListener('click', saveWishlist);
    $('mine-send').addEventListener('click', function () { sendMessage('mine'); });
    $('giftee-send').addEventListener('click', function () { sendMessage('giftee'); });
    $('mine-refresh').addEventListener('click', function () { refreshAll(true); });
    $('giftee-refresh').addEventListener('click', function () { refreshAll(true); });
  }

  function selectTab(which) {
    var giftee = which === 'giftee';
    $('tab-giftee').setAttribute('aria-selected', String(giftee));
    $('tab-mine').setAttribute('aria-selected', String(!giftee));
    show($('panel-giftee'), giftee);
    show($('panel-mine'), !giftee);
  }

  /* ---- unlocking ------------------------------------------------------- */

  function unlock(rawToken, silent) {
    var token = SSCrypto.normalizeToken(rawToken);
    if (!token) {
      setMsg($('login-error'), 'Enter your access token.', 'error');
      return;
    }

    $('unlock').disabled = true;
    if (!silent) setMsg($('login-error'), 'Checking…', '');

    var kdf = state.data.kdf || {};
    SSCrypto.recordId(state.data.salt, token)
      .then(function (id) {
        var blob = state.data.records[id];
        if (!blob) throw new Error('unknown_token');
        return SSCrypto.deriveRecordKey(token, state.data.salt, kdf.iterations)
          .then(function (key) { return SSCrypto.decryptJson(key, blob); });
      })
      .then(function (record) {
        state.token = token;
        state.record = record;
        session('set', token);
        setMsg($('login-error'), '', '');
        $('token').value = '';
        renderApp();
      })
      .catch(function (err) {
        // A failed attempt must not leave someone looking at an account they
        // are no longer signed in to - drop all the way back to the login card.
        var wasSignedIn = !!state.record;
        signOut();

        if (err && err.message === 'unknown_token') {
          setMsg($('login-error'), wasSignedIn
            ? 'That link was not recognised, so you have been signed out. Sign in again below.'
            : 'That token is not recognised. Check for typos, or ask whoever set this up.', 'error');
        } else {
          setMsg($('login-error'), 'Could not unlock with that token.', 'error');
        }
      })
      .then(function () { $('unlock').disabled = false; });
  }

  function signOut() {
    session('clear');
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    state.token = null;
    state.record = null;
    // Clear anything decrypted out of the DOM before showing the login screen.
    $('giftee-name').textContent = '…';
    $('giftee-wishlist').innerHTML = '';
    $('giftee-thread').innerHTML = '';
    $('mine-thread').innerHTML = '';
    $('wishlist-items').value = '';
    $('wishlist-note').value = '';
    show($('app'), false);
    show($('login'), true);
  }

  function renderApp() {
    // Signing in again without signing out first (a second link on the same
    // page) would otherwise stack up refresh timers.
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;

    show($('login'), false);
    show($('app'), true);
    selectTab('giftee');

    $('greeting').textContent = 'Hello, ' + state.record.name;
    $('giftee-name').textContent = state.record.giftee.name;

    var online = state.api.enabled();
    Array.prototype.forEach.call(
      document.querySelectorAll('#wishlist-save, #mine-send, #giftee-send, #mine-refresh, #giftee-refresh'),
      function (b) { b.disabled = !online; }
    );

    if (!online) {
      setMsg($('api-warning'),
        'Wishlists and messaging are switched off for this draw. Your assignment above is still correct.',
        'warn');
      return;
    }
    setMsg($('api-warning'), '', '');
    refreshAll(false);
    state.refreshTimer = setInterval(function () { refreshAll(false); }, REFRESH_MS);
  }

  /* ---- mailboxes ------------------------------------------------------- */

  function loadMailbox(box) {
    return state.api.getMailbox(box.mailboxId, box.mailboxSecret)
      .then(function (payload) {
        return SSCrypto.importAesKey(box.mailboxKey).then(function (key) {
          var jobs = [];
          var result = { wishlist: null, messages: [] };

          if (payload && payload.wishlist && payload.wishlist.ct) {
            jobs.push(SSCrypto.decryptJson(key, payload.wishlist.ct)
              .then(function (w) { result.wishlist = w; })
              .catch(function () { /* unreadable - ignore */ }));
          }
          (payload && payload.messages ? payload.messages : []).forEach(function (m) {
            jobs.push(SSCrypto.decryptJson(key, m.ct)
              .then(function (body) { result.messages.push({ ts: m.ts, body: body }); })
              .catch(function () { /* unreadable - ignore */ }));
          });

          return Promise.all(jobs).then(function () {
            result.messages.sort(function (a, b) { return a.ts - b.ts; });
            return result;
          });
        });
      });
  }

  function refreshAll(loud) {
    if (!state.record || !state.api.enabled()) return;
    if (loud) {
      setMsg($('mine-status'), 'Refreshing…', '');
      setMsg($('giftee-status'), 'Refreshing…', '');
    }

    loadMailbox(state.record.mine)
      .then(function (box) {
        renderOwnWishlist(box.wishlist);
        renderThread($('mine-thread'), $('mine-thread-empty'), box.messages, 'owner',
          'You', 'Your Secret Santa');
        if (loud) setMsg($('mine-status'), '', '');
        else clearIfError($('mine-status'));
      })
      .catch(function () { setMsg($('mine-status'), 'Could not reach the server.', 'error'); });

    loadMailbox(state.record.giftee)
      .then(function (box) {
        renderGifteeWishlist(box.wishlist);
        renderThread($('giftee-thread'), $('giftee-thread-empty'), box.messages, 'santa',
          'You', state.record.giftee.name);
        if (loud) setMsg($('giftee-status'), '', '');
        else clearIfError($('giftee-status'));
      })
      .catch(function () { setMsg($('giftee-status'), 'Could not reach the server.', 'error'); });
  }

  // Only overwrite the editor when the user is not mid-edit, so a background
  // refresh cannot eat what they are typing.
  function renderOwnWishlist(wishlist) {
    var items = $('wishlist-items');
    var note = $('wishlist-note');
    if (document.activeElement === items || document.activeElement === note) return;
    if (items.dataset.dirty === '1') return;
    items.value = (wishlist && wishlist.items ? wishlist.items : []).join('\n');
    note.value = (wishlist && wishlist.note) || '';
  }

  function renderGifteeWishlist(wishlist) {
    var list = $('giftee-wishlist');
    var items = (wishlist && wishlist.items) || [];
    list.innerHTML = '';
    items.forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    });
    show($('giftee-wishlist-empty'), items.length === 0);

    var noteEl = $('giftee-note');
    if (wishlist && wishlist.note) {
      noteEl.textContent = wishlist.note;
      show(noteEl, true);
    } else {
      show(noteEl, false);
    }
  }

  function renderThread(container, emptyEl, messages, myRole, myLabel, theirLabel) {
    container.innerHTML = '';
    messages.forEach(function (m) {
      var mine = m.body.from === myRole;
      var div = document.createElement('div');
      div.className = 'bubble' + (mine ? ' mine' : '');

      var who = document.createElement('div');
      who.className = 'who';
      who.textContent = mine ? myLabel : theirLabel;

      var body = document.createElement('div');
      body.className = 'body';
      body.textContent = m.body.text;

      var ts = document.createElement('div');
      ts.className = 'when';
      ts.textContent = when(m.ts);

      div.appendChild(who);
      div.appendChild(body);
      div.appendChild(ts);
      container.appendChild(div);
    });
    show(emptyEl, messages.length === 0);
  }

  /* ---- writing --------------------------------------------------------- */

  function saveWishlist() {
    var items = $('wishlist-items').value.split('\n')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    var payload = { v: 1, items: items, note: $('wishlist-note').value.trim() };

    $('wishlist-save').disabled = true;
    setMsg($('wishlist-status'), 'Saving…', '');

    var box = state.record.mine;
    SSCrypto.importAesKey(box.mailboxKey)
      .then(function (key) { return SSCrypto.encryptJson(key, payload); })
      .then(function (ct) { return state.api.putWishlist(box.mailboxId, box.mailboxSecret, ct); })
      .then(function () {
        $('wishlist-items').dataset.dirty = '0';
        setMsg($('wishlist-status'), 'Saved. Your Secret Santa will see it next time they look.', 'ok');
      })
      .catch(function () { setMsg($('wishlist-status'), 'Could not save. Try again in a moment.', 'error'); })
      .then(function () { $('wishlist-save').disabled = false; });
  }

  function sendMessage(which) {
    var giftee = which === 'giftee';
    var box = giftee ? state.record.giftee : state.record.mine;
    var role = giftee ? 'santa' : 'owner';   // who you are relative to that mailbox
    var field = $(which + '-compose');
    var statusEl = $(which + '-status');
    var button = $(which + '-send');

    var text = field.value.trim();
    if (!text) { setMsg(statusEl, 'Write something first.', 'error'); return; }

    button.disabled = true;
    setMsg(statusEl, 'Sending…', '');

    SSCrypto.importAesKey(box.mailboxKey)
      .then(function (key) { return SSCrypto.encryptJson(key, { v: 1, from: role, text: text }); })
      .then(function (ct) { return state.api.postMessage(box.mailboxId, box.mailboxSecret, ct); })
      .then(function () {
        field.value = '';
        setMsg(statusEl, 'Sent.', 'ok');
        refreshAll(false);
      })
      .catch(function () { setMsg(statusEl, 'Could not send. Try again in a moment.', 'error'); })
      .then(function () { button.disabled = false; });
  }

  document.addEventListener('DOMContentLoaded', function () {
    ['wishlist-items', 'wishlist-note'].forEach(function (id) {
      $(id).addEventListener('input', function () { $('wishlist-items').dataset.dirty = '1'; });
    });
    boot();
  });
})();

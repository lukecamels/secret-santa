/* Secret Santa - setup tool.
 *
 * Runs entirely in the browser. Produces two things:
 *   - data/santa.json, safe to publish: salts, hashes and ciphertext only.
 *   - a list of tokens, shown once, never stored.
 *
 * The tool deliberately never displays who is buying for whom, so whoever runs
 * the draw can still take part.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var people = [];          // [{ uid, name }]
  var exclusions = new Set();  // "uidA|uidB", uids sorted
  var lastResult = null;    // { json, tokens: [{name, token}] }
  var nextUid = 1;

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (text && kind ? ' ' + kind : '');
  }

  /* ---- sign-in links --------------------------------------------------- */

  // The token rides in the fragment, which browsers never send to the server.
  function signInLink(token) {
    var base = $('site').value.trim();
    if (!base) return null;
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    return base.replace(/[#?].*$/, '').replace(/\/*$/, '/') + '#t=' + encodeURIComponent(token);
  }

  function findPerson(uid) {
    return people.filter(function (p) { return String(p.uid) === String(uid); })[0];
  }

  /* ---- people ---------------------------------------------------------- */

  function addNames(raw) {
    var added = 0;
    String(raw).split(/[\r\n,]+/).forEach(function (chunk) {
      var name = chunk.trim().replace(/\s+/g, ' ');
      if (!name) return;
      var clash = people.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); });
      if (clash) return;
      people.push({ uid: nextUid++, name: name });
      added++;
    });
    if (added) renderPeople();
    return added;
  }

  function removePerson(uid) {
    people = people.filter(function (p) { return p.uid !== uid; });
    Array.from(exclusions).forEach(function (k) {
      var parts = k.split('|');
      if (parts[0] === String(uid) || parts[1] === String(uid)) exclusions.delete(k);
    });
    renderPeople();
  }

  function renderPeople() {
    var list = $('people');
    list.innerHTML = '';
    people.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'chip';
      var span = document.createElement('span');
      span.textContent = p.name;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remove ' + p.name);
      btn.addEventListener('click', function () { removePerson(p.uid); });
      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    });
    $('people-empty').hidden = people.length > 0;
    renderSelects();
    renderExclusions();
  }

  /* ---- exclusions ------------------------------------------------------ */

  function renderSelects() {
    ['excl-a', 'excl-b'].forEach(function (id) {
      var sel = $(id);
      var previous = sel.value;
      sel.innerHTML = '';
      people.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = String(p.uid);
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      if (previous && findPerson(previous)) sel.value = previous;
    });
  }

  function renderExclusions() {
    var list = $('exclusions');
    list.innerHTML = '';
    Array.from(exclusions).forEach(function (k) {
      var parts = k.split('|');
      var a = findPerson(parts[0]);
      var b = findPerson(parts[1]);
      if (!a || !b) return;
      var li = document.createElement('li');
      li.className = 'chip';
      var span = document.createElement('span');
      span.textContent = a.name + ' ↔ ' + b.name;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remove link between ' + a.name + ' and ' + b.name);
      btn.addEventListener('click', function () { exclusions.delete(k); renderExclusions(); });
      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    });
    $('exclusions-empty').hidden = list.children.length > 0;
  }

  /* ---- the draw -------------------------------------------------------- */

  function runDraw() {
    var status = $('draw-status');

    if (people.length < 3) {
      setMsg(status, 'Add at least three people.', 'error');
      return;
    }

    // Exclusions are stored against uids; the solver works on positions.
    var indexOf = {};
    people.forEach(function (p, i) { indexOf[p.uid] = i; });
    var byIndex = new Set();
    exclusions.forEach(function (k) {
      var parts = k.split('|');
      if (indexOf[parts[0]] === undefined || indexOf[parts[1]] === undefined) return;
      byIndex.add(SSDraw.pairKey(indexOf[parts[0]], indexOf[parts[1]]));
    });

    var singleLoop = $('single-loop').checked;
    var assignment = SSDraw.draw(people.length, byIndex, { singleLoop: singleLoop });

    if (!assignment) {
      setMsg(status, singleLoop
        ? 'No single chain fits those links. Try again with the chain option turned off, or remove a link.'
        : 'Those links make a draw impossible. Remove one and try again.', 'error');
      return;
    }

    setMsg(status, 'Drawing and encrypting…', '');
    $('draw').disabled = true;

    build(assignment)
      .then(function (result) {
        lastResult = result;
        renderResults(result);
        setMsg(status, 'Done. Two things left: publish the file, and hand out the tokens.', 'ok');
      })
      .catch(function (err) {
        setMsg(status, 'Something went wrong: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      })
      .then(function () { $('draw').disabled = false; });
  }

  function build(assignment) {
    var salt = SSCrypto.b64uEncode(SSCrypto.randomBytes(16));

    // Per person: an access token, and a mailbox that they and their Santa share.
    var boxes = people.map(function () {
      return {
        mailboxId: SSCrypto.generateMailboxId(),
        mailboxSecret: SSCrypto.generateSecret(),
        mailboxKey: SSCrypto.generateSecret()
      };
    });
    // Tokens are shown with dashes for readability, but every derivation runs
    // on the normalised form - the same thing the login page computes from
    // whatever the person types.
    var tokens = people.map(function () { return SSCrypto.generateToken(); });
    var keys = tokens.map(SSCrypto.normalizeToken);

    var data = {
      version: 1,
      event: $('event').value.trim() || 'Secret Santa',
      createdAt: new Date().toISOString(),
      api: $('api').value.trim().replace(/\/+$/, ''),
      salt: salt,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: SSCrypto.PBKDF2_ITERATIONS },
      records: {},
      mailboxes: {}
    };

    var jobs = people.map(function (person, i) {
      var giftee = people[assignment[i]];
      var plaintext = {
        v: 1,
        name: person.name,
        mine: boxes[i],
        giftee: {
          name: giftee.name,
          mailboxId: boxes[assignment[i]].mailboxId,
          mailboxSecret: boxes[assignment[i]].mailboxSecret,
          mailboxKey: boxes[assignment[i]].mailboxKey
        }
      };
      return Promise.all([
        SSCrypto.recordId(salt, keys[i]),
        SSCrypto.deriveRecordKey(keys[i], salt, SSCrypto.PBKDF2_ITERATIONS)
          .then(function (key) { return SSCrypto.encryptJson(key, plaintext); }),
        SSCrypto.authHash(boxes[i].mailboxSecret)
      ]).then(function (out) {
        return { id: out[0], blob: out[1], mailboxId: boxes[i].mailboxId, authHash: out[2] };
      });
    });

    return Promise.all(jobs).then(function (entries) {
      // Shuffle before writing so the order of keys in the published file says
      // nothing about the order people were entered in.
      shuffle(entries).forEach(function (e) { data.records[e.id] = e.blob; });
      shuffle(entries.slice()).forEach(function (e) { data.mailboxes[e.mailboxId] = e.authHash; });

      return {
        json: JSON.stringify(data, null, 2),
        tokens: people.map(function (p, i) { return { name: p.name, token: tokens[i] }; })
      };
    });
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ---- results --------------------------------------------------------- */

  function renderResults(result) {
    $('results').hidden = false;
    $('json-preview').textContent = result.json;

    var slips = $('slips');
    slips.innerHTML = '';
    result.tokens.forEach(function (entry) {
      var div = document.createElement('div');
      div.className = 'slip';

      var title = document.createElement('div');
      title.className = 'name';
      title.textContent = entry.name;

      var note = document.createElement('div');
      note.className = 'hint';
      note.style.margin = '2px 0 6px';
      note.textContent = 'Tap your link to sign in';

      var link = document.createElement('div');
      link.className = 'tok';
      link.style.fontSize = '0.8rem';
      link.textContent = signInLink(entry.token) || '(set the site address above)';

      var orNote = document.createElement('div');
      orNote.className = 'hint';
      orNote.style.margin = '8px 0 0';
      orNote.textContent = 'or type this code:';

      var tok = document.createElement('div');
      tok.className = 'tok';
      tok.textContent = entry.token;

      div.appendChild(title);
      div.appendChild(note);
      div.appendChild(link);
      div.appendChild(orNote);
      div.appendChild(tok);
      slips.appendChild(div);
    });

    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function download() {
    var blob = new Blob([lastResult.json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'santa.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function copy(text, statusEl, okMessage) {
    var done = function () { setMsg(statusEl, okMessage, 'ok'); };
    var failed = function () { setMsg(statusEl, 'Could not copy — select the text and copy it manually.', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, failed);
    } else {
      failed();
    }
  }

  /* ---- rebuilding links for a draw that already happened --------------- */

  function buildLinksFromCodes() {
    var lines = $('relink-input').value.split('\n');
    var out = [];
    var skipped = 0;

    lines.forEach(function (line) {
      if (!line.trim()) return;

      // "Name: CODE", "Name - CODE" or a bare code. Split on the LAST separator
      // so names containing one still work.
      var name = '';
      var code = line.trim();
      var sep = Math.max(code.lastIndexOf(':'), code.lastIndexOf('\u2014'), code.lastIndexOf(' - '));
      if (sep > -1) {
        name = code.slice(0, sep).replace(/[\s:\u2014-]+$/, '').trim();
        code = code.slice(sep + 1).trim();
      }

      // Must be exactly a token's worth of characters. Anything else is a typo
      // or a stray line, and turning it into a plausible-looking link would
      // just mean sending somebody a dud.
      var normalised = SSCrypto.normalizeToken(code);
      if (normalised.length !== SSCrypto.TOKEN_LENGTH) { skipped++; return; }

      out.push((name ? name + ': ' : '') + signInLink(SSCrypto.formatToken(normalised)));
    });

    $('relink-output').textContent = out.join('\n');

    var skipNote = skipped
      ? ' ' + skipped + ' line' + (skipped === 1 ? '' : 's') + ' skipped — a code is ' +
        SSCrypto.TOKEN_LENGTH + ' characters, so check for a typo or a missing character.'
      : '';

    if (out.length === 0) {
      setMsg($('relink-status'),
        'No usable codes found. One per line, e.g. "Ada: 9QM4C-KAK7S-1A0MK-SEXGB".' + skipNote, 'error');
    } else {
      setMsg($('relink-status'),
        'Built ' + out.length + ' link' + (out.length === 1 ? '' : 's') + '.' + skipNote,
        skipped ? 'warn' : 'ok');
    }
  }

  /* ---- wiring ---------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    $('add-person-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (addNames($('person').value)) $('person').value = '';
      $('person').focus();
    });

    // Pasting a whole list into a single-line input would otherwise collapse
    // into one long name.
    $('person').addEventListener('paste', function (e) {
      var text = (e.clipboardData || window.clipboardData).getData('text');
      if (!/[\r\n,]/.test(text)) return;
      e.preventDefault();
      addNames(text);
      $('person').value = '';
    });

    $('add-exclusion').addEventListener('click', function () {
      var a = $('excl-a').value;
      var b = $('excl-b').value;
      if (!a || !b || a === b) {
        setMsg($('draw-status'), 'Pick two different people to link.', 'error');
        return;
      }
      exclusions.add(pairKey(a, b));
      setMsg($('draw-status'), '', '');
      renderExclusions();
    });

    $('draw').addEventListener('click', runDraw);
    $('download').addEventListener('click', download);
    $('print').addEventListener('click', function () { window.print(); });

    $('copy-json').addEventListener('click', function () {
      copy(lastResult.json, $('publish-status'), 'Copied. Paste it into data/santa.json.');
    });

    $('copy-tokens').addEventListener('click', function () {
      var text = lastResult.tokens.map(function (t) { return t.name + ': ' + t.token; }).join('\n');
      copy(text, $('publish-status'), 'Codes copied. Paste them somewhere safe before closing this tab.');
    });

    $('copy-links').addEventListener('click', function () {
      var text = lastResult.tokens.map(function (t) {
        return t.name + ': ' + signInLink(t.token);
      }).join('\n');
      copy(text, $('publish-status'), 'Links copied. Send each person only their own.');
    });

    $('relink').addEventListener('click', buildLinksFromCodes);
    $('relink-copy').addEventListener('click', function () {
      var text = $('relink-output').textContent;
      if (!text) { setMsg($('relink-status'), 'Build the links first.', 'error'); return; }
      copy(text, $('relink-status'), 'Copied. Send each person only their own.');
    });

    window.addEventListener('beforeunload', function (e) {
      if (!lastResult) return;
      e.preventDefault();
      e.returnValue = '';
    });

    renderPeople();
  });
})();

/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Settings — Buraco bet limits, broadcast thresholds and the leaderboard's
 * fair-play rules on wlive-api.
 *
 * Contract (wlive-api, branches feat/buraco-points-bets + feat/buraco-fair-play):
 *   GET api/buraco/admin/settings → {success, data: {bet_min, bet_max,
 *       winner_broadcast_min_bet, room_created_broadcast_min_bet,
 *       collusion_streak_threshold, same_network_rule, partner_cap_games,
 *       lineup_cap_games, repeat_cap_window_hours, defaults, overrides}}
 *   PUT api/buraco/admin/settings  partial update → the full effective settings;
 *       422 {success:false, error:{code, message, details:{field:[msg]}}}
 *
 * The known fields get labels, hints and client checks. Anything else the
 * endpoint returns is still shown (number / switch / text by its type) so a new
 * setting does not need a console change; `*_at` / `*_by` keys are read-only.
 * The fair-play switch is an integer on the wire (1 / 0), never a boolean.
 */
(function () {
  'use strict';
  var A = window.BuracoAdmin;
  if (!A) return;
  var h = A.h;

  var KNOWN = [
    {
      key: 'bet_min',
      label: 'Minimum bet',
      hint: 'A staked table needs a bet of at least this. A bet of 0 — a free table — is always allowed.',
    },
    {
      key: 'bet_max',
      label: 'Maximum bet',
      hint: 'The most one table can stake.',
    },
    {
      key: 'winner_broadcast_min_bet',
      label: 'Winner broadcast — from bet',
      hint: 'A finished paid game is announced to everyone when its bet is at least this.',
    },
    {
      key: 'room_created_broadcast_min_bet',
      label: '"Table opened" broadcast — from bet',
      hint: 'A new public table is announced (the banner in live rooms) when its bet is at least this.',
    },
  ];
  var KNOWN_KEYS = KNOWN.map(function (k) {
    return k.key;
  });

  // The leaderboard's fair-play rules (wlive-api LeaderboardService + FairPlayService).
  var WINDOW_PRESETS = [
    { hours: 24, label: '24 h' },
    { hours: 168, label: '7 days' },
    { hours: 720, label: '30 days' },
    { hours: 0, label: 'Ever' },
  ];
  var FAIR = [
    {
      key: 'collusion_streak_threshold',
      label: 'Streak flag',
      min: 2,
      max: 100,
      unit: 'wins in a row',
      hint: "Wins in a row over the same opponent that flag the pair: the streak's points are voided and the pair is frozen until you decide on Review.",
    },
    {
      key: 'same_network_rule',
      label: 'Same local network',
      kind: 'switch',
      hint: 'Players on one network (one public IPv4, or one IPv6 /64) never score off each other: opponents neither gain nor lose; partners who win score nobody, their loss counts. The players are told in the lobby.',
    },
    {
      key: 'partner_cap_games',
      label: 'Partner cap — 2 vs 2',
      min: 0,
      max: 1000,
      unit: 'games',
      hint: 'The same two partners score in this many games together per window; after that their win scores nobody (their loss counts). 0 = no cap.',
    },
    {
      key: 'lineup_cap_games',
      label: 'Line-up cap — 2 vs 2',
      min: 0,
      max: 1000,
      unit: 'games',
      hint: 'The same four players in the same two teams score in this many games per window; after that the game scores nobody. 0 = no cap.',
    },
    {
      key: 'repeat_cap_window_hours',
      label: 'Cap window',
      kind: 'window',
      min: 0,
      max: 8760,
      unit: 'hours',
      hint: 'How far back both caps count games together, in hours. 0 = ever.',
    },
  ];
  var FAIR_KEYS = FAIR.map(function (k) {
    return k.key;
  });

  var st = { data: null, error: null, saving: false, serverErrors: {} };
  var ui = { fields: {}, inputs: {} };

  function isMeta(key) {
    return key === 'id' || /(_at|_by)$/.test(key);
  }

  // wlive-api's real answer also carries `defaults` (the shipped value of every
  // key) and `overrides` ({key: {value, updated_by, updated_at}} for the keys an
  // admin has set). They describe the fields rather than being settings, so they
  // feed each field's hint and the per-field "Use default" instead of being
  // listed under "Other settings".
  var DESCRIPTOR_KEYS = ['defaults', 'overrides'];

  /** A fair-play value as an admin reads it. */
  function fairText(k, v) {
    if (v == null) return 'none';
    if (k.kind === 'switch') return Number(v) === 1 ? 'on' : 'off';
    if (k.kind === 'window') return windowText(v);
    return A.fmtInt(v) + (k.unit ? ' ' + k.unit : '');
  }

  function windowText(hours) {
    var n = Number(hours) || 0;
    if (!n) return 'ever';
    if (n % 24 === 0) return n === 24 ? '24 hours' : n / 24 + ' days';
    return n + ' hours';
  }

  function fieldHint(k, d) {
    var parts = [k.hint];
    var def = d.defaults && typeof d.defaults === 'object' ? d.defaults[k.key] : undefined;
    var ov = d.overrides && typeof d.overrides === 'object' ? d.overrides[k.key] : undefined;
    if (def !== undefined)
      parts.push(
        'Default: ' +
          (FAIR_KEYS.indexOf(k.key) !== -1
            ? fairText(k, def)
            : def == null
              ? 'none'
              : A.fmtNumber
                ? A.fmtNumber(def)
                : def) +
          '.'
      );
    if (ov && typeof ov === 'object') {
      parts.push(
        'Set' +
          (ov.updated_by ? ' by ' + ov.updated_by : '') +
          (ov.updated_at ? ' ' + A.relTime(ov.updated_at) : '') +
          '.'
      );
    } else if (d.overrides && typeof d.overrides === 'object') {
      parts.push('Using the default.');
    }
    return parts.join(' ');
  }

  /** PUT {key: null}: wlive-api drops the override and the default applies. */
  function useDefault(key) {
    if (st.saving) return;
    st.saving = true;
    var body = {};
    body[key] = null;
    A.api.put('settings', body).then(
      function (res) {
        st.saving = false;
        if (res.data && typeof res.data === 'object') st.data = res.data;
        A.toast(key + ' is back to its default');
        render();
      },
      function (err) {
        st.saving = false;
        A.showErrors(err, ui.fields, ui.errBox, { clearOnInput: false });
      }
    );
  }

  function mount(root) {
    ui.refresh = h('button', { class: 'small', text: 'Reload', on: { click: load } });
    root.appendChild(
      A.pageHead(
        'Settings',
        "Bet limits, broadcast thresholds and the leaderboard's fair-play rules, stored on wlive-api. Changes apply to tables opened (and games settled) from now on.",
        [ui.refresh]
      )
    );
    ui.body = h('div');
    root.appendChild(ui.body);
  }

  function load() {
    ui.refresh.disabled = true;
    if (!st.data) render();
    A.api
      .get('settings')
      .then(
        function (res) {
          st.error = null;
          st.data = res.data && typeof res.data === 'object' ? res.data : {};
        },
        function (err) {
          st.error = err;
        }
      )
      .then(function () {
        ui.refresh.disabled = false;
        render();
      });
  }

  /** The label of a known field, with its key and a "Use default" while overridden. */
  function labelFor(k, d) {
    var ov = d.overrides && typeof d.overrides === 'object' ? d.overrides[k.key] : undefined;
    return h(
      'span',
      null,
      k.label,
      h('span', { class: 'hint', text: '  ' + k.key }),
      ov && typeof ov === 'object'
        ? h('button', {
            class: 'small ghost',
            style: { marginLeft: '8px' },
            text: 'Use default',
            on: {
              click: function (ev) {
                ev.preventDefault();
                useDefault(k.key);
              },
            },
          })
        : null
    );
  }

  /** The fair-play fields, or a note when this wlive-api predates them. */
  function fairSection(d) {
    var wrap = h('div');
    wrap.appendChild(
      h(
        'div',
        { class: 'fp-head' },
        h('div', { class: 'sec-title', text: 'Fair play' }),
        h('span', {
          class: 'hint',
          text: "The leaderboard's anti-collusion rules. Every game they judge is on the Audit page.",
        })
      )
    );
    var known = FAIR.filter(function (k) {
      return k.key in d;
    });
    if (!known.length) {
      wrap.appendChild(
        h('div', {
          class: 'hint',
          text: 'This wlive-api has no fair-play settings yet: they ship with the wlive-api branch feat/buraco-fair-play.',
        })
      );
      return wrap;
    }
    ui.fairSummary = h('div', { class: 'banner' });
    wrap.appendChild(ui.fairSummary);
    var grid = h('div', { class: 'settings-grid' });
    known.forEach(function (k) {
      var control;
      if (k.kind === 'switch') {
        var box = h('input', { type: 'checkbox', checked: Number(d[k.key]) === 1 });
        box.onchange = function () {
          sync(k.key);
        };
        ui.inputs[k.key] = box;
        ui.kinds[k.key] = 'switch01';
        var state = h('span', { text: box.checked ? 'On' : 'Off' });
        box.addEventListener('change', function () {
          state.textContent = box.checked ? 'On' : 'Off';
        });
        control = h('label', { class: 'switch' }, box, state);
      } else {
        var input = A.numberInput(d[k.key], { min: k.min, max: k.max });
        input.oninput = function () {
          sync(k.key);
        };
        ui.inputs[k.key] = input;
        control = input;
        if (k.kind === 'window') {
          ui.windowChips = WINDOW_PRESETS.map(function (p) {
            return h('button', {
              type: 'button',
              class: 'ov-chip',
              text: p.label,
              data: { hours: String(p.hours) },
              on: {
                click: function () {
                  input.value = String(p.hours);
                  sync(k.key);
                },
              },
            });
          });
          control = h('div', { class: 'fp-window' }, input, h('span', { class: 'hint', text: 'hours' }), ui.windowChips);
        }
      }
      ui.fields[k.key] = A.field(labelFor(k, d), control, { hint: fieldHint(k, d), lbl: true });
      grid.appendChild(ui.fields[k.key].root);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function render() {
    var box = A.clear(ui.body);
    ui.fields = {};
    ui.inputs = {};
    ui.kinds = {};
    ui.fairSummary = null;
    ui.windowChips = null;
    ui.save = null;
    st.serverErrors = {};
    if (st.error) {
      if (st.error.status === 404 || st.error.status === 405) {
        box.appendChild(
          A.stateBox({
            icon: 'plug',
            title: 'This wlive-api has no Buraco settings endpoint yet',
            text:
              'GET /api/buraco/admin/settings answered ' +
              st.error.status +
              '. It ships with the wlive-api branch feat/buraco-points-bets; deploy that, then reload.',
            action: h('button', { class: 'small', text: 'Reload', on: { click: load } }),
          })
        );
      } else {
        box.appendChild(A.errorBox(st.error, load));
      }
      return;
    }
    if (!st.data) {
      box.appendChild(A.loadingBox(260));
      return;
    }

    var d = st.data;
    var card = h('div', { class: 'card' });
    ui.summary = h('div', { class: 'banner' });
    card.appendChild(ui.summary);

    var grid = h('div', { class: 'settings-grid' });
    KNOWN.forEach(function (k) {
      var input = A.numberInput(d[k.key], {
        min: 0,
        placeholder: d[k.key] == null ? 'not set' : '',
      });
      input.oninput = function () {
        sync(k.key);
      };
      ui.inputs[k.key] = input;
      ui.fields[k.key] = A.field(labelFor(k, d), input, { hint: fieldHint(k, d), lbl: true });
      grid.appendChild(ui.fields[k.key].root);
    });
    card.appendChild(grid);
    card.appendChild(fairSection(d));

    var extras = Object.keys(d).filter(function (key) {
      return (
        KNOWN_KEYS.indexOf(key) === -1 &&
        FAIR_KEYS.indexOf(key) === -1 &&
        DESCRIPTOR_KEYS.indexOf(key) === -1 &&
        !isMeta(key)
      );
    });
    if (extras.length) {
      card.appendChild(
        h('div', { class: 'sec-title', style: { margin: '18px 0 10px' }, text: 'Other settings' })
      );
      var grid2 = h('div', { class: 'settings-grid' });
      extras.forEach(function (key) {
        var v = d[key];
        var input;
        if (typeof v === 'boolean') {
          input = h('input', { type: 'checkbox', checked: v });
          input.onchange = function () {
            sync(key);
          };
          ui.inputs[key] = input;
          ui.fields[key] = A.field(key, h('label', { class: 'switch' }, input, 'on'));
        } else if (typeof v === 'number') {
          input = A.numberInput(v, { step: Number.isInteger(v) ? 1 : 'any' });
          input.oninput = function () {
            sync(key);
          };
          ui.inputs[key] = input;
          ui.fields[key] = A.field(key, input);
        } else if (v === null || typeof v === 'string') {
          input = h('input', { type: 'text', value: v == null ? '' : v });
          input.oninput = function () {
            sync(key);
          };
          ui.inputs[key] = input;
          ui.fields[key] = A.field(key, input, { hint: v == null ? 'empty on the server' : null });
        } else {
          ui.fields[key] = A.field(key, h('code', { class: 'tag', text: JSON.stringify(v) }), {
            hint: 'shown as returned; not editable here',
          });
        }
        grid2.appendChild(ui.fields[key].root);
      });
      card.appendChild(grid2);
    }

    var meta = Object.keys(d).filter(isMeta);
    if (meta.length) {
      card.appendChild(
        h('div', {
          class: 'hint',
          style: { marginTop: '12px' },
          text: meta
            .map(function (k) {
              return (
                k.replace(/_/g, ' ') +
                ': ' +
                (/_at$/.test(k) && d[k]
                  ? A.fmtDate(d[k]) + ' (' + A.relTime(d[k]) + ')'
                  : String(d[k]))
              );
            })
            .join(' · '),
        })
      );
    }

    ui.errBox = h('div', { class: 'form-error', style: { marginTop: '12px' } });
    card.appendChild(ui.errBox);
    ui.save = h('button', { class: 'primary', text: 'Save', on: { click: save } });
    ui.reset = h('button', { class: 'ghost', text: 'Undo changes', on: { click: render } });
    ui.dirty = h('span', { class: 'hint' });
    card.appendChild(
      h('div', { class: 'form-actions', style: { marginTop: '14px' } }, ui.save, ui.reset, ui.dirty)
    );
    box.appendChild(card);
    sync();
  }

  /** The value an input holds, typed like the loaded one; undefined = invalid. */
  function readValue(key) {
    var input = ui.inputs[key];
    var orig = st.data[key];
    if (!input) return orig;
    if (ui.kinds[key] === 'switch01') return input.checked ? 1 : 0;
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number') {
      if (input.value === '') return orig == null ? null : undefined;
      var n = Number(input.value);
      return Number.isFinite(n) ? n : undefined;
    }
    return input.value === '' && orig == null ? null : input.value;
  }

  function changes() {
    var out = {};
    Object.keys(ui.inputs).forEach(function (key) {
      var v = readValue(key);
      if (v !== undefined && v !== st.data[key]) out[key] = v;
    });
    return out;
  }

  /** Client checks for the known fields: {key: message}. */
  function problems() {
    var out = {};
    KNOWN_KEYS.forEach(function (key) {
      var input = ui.inputs[key];
      if (!input) return;
      if (input.value === '') {
        if (st.data[key] != null) out[key] = 'Required.';
        return;
      }
      if (!/^\d+$/.test(input.value)) out[key] = 'A whole number of coins, 0 or more.';
    });
    FAIR.forEach(function (k) {
      var input = ui.inputs[k.key];
      if (!input || k.kind === 'switch') return;
      if (input.value === '') {
        if (st.data[k.key] != null) out[k.key] = 'Required.';
        return;
      }
      var n = Number(input.value);
      if (!/^\d+$/.test(input.value) || n < k.min || n > k.max)
        out[k.key] =
          'A whole number from ' + A.fmtInt(k.min) + ' to ' + A.fmtInt(k.max) + (k.unit ? ' ' + k.unit : '') + '.';
    });
    var min = readValue('bet_min');
    var max = readValue('bet_max');
    if (
      !out.bet_min &&
      !out.bet_max &&
      typeof min === 'number' &&
      typeof max === 'number' &&
      max < min
    ) {
      out.bet_max = 'Must be at least the minimum bet (' + A.fmtInt(min) + ').';
    }
    return out;
  }

  // A server error stays on its field until that field is edited.
  function sync(editedKey) {
    if (!ui.save) return;
    if (typeof editedKey === 'string') delete st.serverErrors[editedKey];
    var bad = problems();
    Object.keys(ui.fields).forEach(function (key) {
      ui.fields[key].setError(bad[key] || st.serverErrors[key] || null);
    });
    var diff = changes();
    var n = Object.keys(diff).length;
    ui.save.disabled = !!Object.keys(bad).length || !n || st.saving;
    ui.save.textContent = n ? 'Save ' + n + ' change' + (n === 1 ? '' : 's') : 'Save';
    ui.dirty.textContent = n ? 'Unsaved: ' + Object.keys(diff).join(', ') : 'No unsaved changes';
    paintSummary();
    paintFairSummary();
  }

  function paintFairSummary() {
    if (ui.windowChips) {
      var hours = ui.inputs.repeat_cap_window_hours ? ui.inputs.repeat_cap_window_hours.value : '';
      ui.windowChips.forEach(function (c) {
        c.classList.toggle('on', hours !== '' && c.dataset.hours === String(Number(hours)));
      });
    }
    if (!ui.fairSummary) return;
    // A value the field refuses reads as unknown, not as "no cap".
    var bad = problems();
    var valid = function (key) {
      var v = readValue(key);
      return bad[key] || typeof v !== 'number' ? undefined : v;
    };
    var streak = valid('collusion_streak_threshold');
    var network = readValue('same_network_rule');
    var partners = valid('partner_cap_games');
    var lineup = valid('lineup_cap_games');
    var hours = valid('repeat_cap_window_hours');
    var per = typeof hours === 'number' ? (hours ? 'per ' + windowText(hours) : 'ever') : 'per ? hours';
    var cap = function (n, label) {
      return typeof n !== 'number' ? h('b', { text: '?' }) : h('b', { text: A.fmtInt(n) + ' ' + label });
    };
    var lines = h('div', { class: 'grow settings-summary' });
    if (network !== undefined)
      lines.appendChild(
        h(
          'div',
          null,
          'Same local network: ',
          h('b', { text: Number(network) === 1 ? 'on' : 'off' }),
          Number(network) === 1
            ? ' — opponents on one network neither gain nor lose; partners on one network who win score nobody.'
            : ' — players on one network score as anyone else.'
        )
      );
    if (ui.inputs.collusion_streak_threshold)
      lines.appendChild(
        h('div', null, 'A pair is flagged after ', cap(streak, 'wins in a row'), ' over the same opponent.')
      );
    if (ui.inputs.partner_cap_games || ui.inputs.lineup_cap_games) {
      lines.appendChild(
        h(
          'div',
          null,
          partners === 0
            ? 'Partners have no cap; '
            : ['The same partners score in their first ', cap(partners, 'games'), ' together ' + per + '; '],
          lineup === 0
            ? 'the same four have no cap.'
            : ['the same four in the same teams in their first ', cap(lineup, 'games'), ' ' + per + '.']
        )
      );
    }
    A.clear(ui.fairSummary).appendChild(lines);
  }

  function paintSummary() {
    var min = readValue('bet_min');
    var max = readValue('bet_max');
    var win = readValue('winner_broadcast_min_bet');
    var opened = readValue('room_created_broadcast_min_bet');
    var box = A.clear(ui.summary);
    var lines = h('div', { class: 'grow settings-summary' });
    var num = function (v) {
      return typeof v === 'number' ? A.fmtInt(v) : '?';
    };
    lines.appendChild(
      h(
        'div',
        null,
        'A table can be ',
        h('b', { text: 'free (bet 0)' }),
        ' or stake ',
        h('b', {
          text: (typeof min === 'number' && min > 0 ? num(min) : '1') + ' – ' + num(max) + ' coins',
        }),
        '.'
      )
    );
    if (typeof win === 'number') {
      lines.appendChild(
        h(
          'div',
          null,
          'Winners are announced from a bet of ',
          h('b', { text: num(win) }),
          typeof min === 'number' && win <= min
            ? h('span', {
                class: 'muted',
                text: ' — at or below the minimum bet, so every staked win is announced',
              })
            : null,
          '.'
        )
      );
    }
    if (typeof opened === 'number') {
      lines.appendChild(
        h(
          'div',
          null,
          'New public tables are announced from a bet of ',
          h('b', { text: num(opened) }),
          '.'
        )
      );
    }
    box.appendChild(lines);
  }

  function save() {
    var diff = changes();
    if (!Object.keys(diff).length) return;
    var bad = problems();
    if (Object.keys(bad).length) return;
    st.saving = true;
    st.serverErrors = {};
    A.showErrors(null, ui.fields, ui.errBox, { clearOnInput: false });
    A.busy(ui.save, 'Saving…', function () {
      return A.api.put('settings', diff);
    }).then(
      function (res) {
        st.data =
          res.data && typeof res.data === 'object' ? res.data : Object.assign({}, st.data, diff);
        st.saving = false;
        A.toast('Settings saved — ' + Object.keys(diff).join(', '));
        render();
      },
      function (err) {
        st.saving = false;
        A.showErrors(err, ui.fields, ui.errBox, { clearOnInput: false });
        if (err && err.fields) {
          Object.keys(err.fields).forEach(function (key) {
            if (!ui.fields[key]) return;
            var msgs = err.fields[key];
            st.serverErrors[key] = Array.isArray(msgs) ? msgs.join(' ') : String(msgs);
          });
        }
        sync();
      }
    );
  }

  A.registerPage('settings', { mount: mount, show: load });
})();

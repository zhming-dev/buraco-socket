/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Settings — Buraco bet limits and broadcast thresholds on wlive-api.
 *
 * Contract (wlive-api, branch feat/buraco-points-bets):
 *   GET api/buraco/admin/settings → {success, data: {bet_min, bet_max,
 *       winner_broadcast_min_bet, room_created_broadcast_min_bet, ...}}
 *   PUT api/buraco/admin/settings  partial update → the full effective settings;
 *       422 {success:false, error:{code, message, details:{field:[msg]}}}
 *
 * The four known fields get labels, hints and client checks. Anything else the
 * endpoint returns is still shown (number / switch / text by its type) so a new
 * setting does not need a console change; `*_at` / `*_by` keys are read-only.
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

  function fieldHint(k, d) {
    var parts = [k.hint];
    var def = d.defaults && typeof d.defaults === 'object' ? d.defaults[k.key] : undefined;
    var ov = d.overrides && typeof d.overrides === 'object' ? d.overrides[k.key] : undefined;
    if (def !== undefined) parts.push('Default: ' + (def == null ? 'none' : A.fmtNumber ? A.fmtNumber(def) : def) + '.');
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
        'Bet limits and broadcast thresholds for Buraco tables, stored on wlive-api. Changes apply to tables opened (and games settled) from now on.',
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

  function render() {
    var box = A.clear(ui.body);
    ui.fields = {};
    ui.inputs = {};
    ui.save = null;
    st.serverErrors = {};
    if (st.error) {
      if (st.error.status === 404 || st.error.status === 405) {
        box.appendChild(
          A.stateBox({
            icon: '🧩',
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
      var ov = d.overrides && typeof d.overrides === 'object' ? d.overrides[k.key] : undefined;
      ui.fields[k.key] = A.field(
        h(
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
        ),
        input,
        { hint: fieldHint(k, d) }
      );
      grid.appendChild(ui.fields[k.key].root);
    });
    card.appendChild(grid);

    var extras = Object.keys(d).filter(function (key) {
      return KNOWN_KEYS.indexOf(key) === -1 && DESCRIPTOR_KEYS.indexOf(key) === -1 && !isMeta(key);
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

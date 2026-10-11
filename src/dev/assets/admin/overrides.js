/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Overrides — push a look onto live tables; players see it mid-game (the
 * socket sends `skins_updated`, nobody rejoins).
 *
 * Two scopes, deliberately different in lifetime:
 *   - one table: dies with that GAME (not the round) — the next game the
 *     players start is back on their own skins;
 *   - every table: carries a duration; when it lapses the socket reverts on
 *     its own (this page shows the countdown).
 *
 * Images (table, card back, background) are UPLOADED with the override —
 * there is no URL to type; a catalog skin can prefill them.
 *
 * wlive-api: GET rooms, GET skins, GET skin-tokens, POST (multipart) / DELETE
 * skin-override.
 */
(function () {
  'use strict';
  var A = window.BuracoAdmin;
  var L = window.SkinLook;
  if (!A || !L) return;
  var h = A.h;

  var SOURCE = {
    admin_room: { text: 'Admin — this game', cls: 'info' },
    admin_global: { text: 'Admin — all games', cls: 'info' },
    owner: { text: "Room owner's skin", cls: 'gold' },
    none: { text: "Players' own", cls: 'neutral' },
  };
  var TOKEN_SLOTS = [
    ['table_theme', 'Table theme'],
    ['card_back_style', 'Card back'],
    ['card_face_style', 'Card face'],
    ['background_style', 'Background'],
  ];
  var MB = 1024 * 1024;
  // Same limits wlive-api enforces on `<key>_file`.
  var IMAGE_SLOTS = [
    {
      key: 'table_skin',
      label: 'Table image',
      max: 8 * MB,
      wide: true,
      hint: 'PNG, JPEG or WebP, up to 8 MB. Shown on the felt instead of the theme colour.',
    },
    {
      key: 'card_skin',
      label: 'Card back image',
      max: 4 * MB,
      hint: 'Up to 4 MB. Replaces the generated back.',
    },
    {
      key: 'background_skin',
      label: 'Background image',
      max: 8 * MB,
      wide: true,
      hint: 'Up to 8 MB. Fills the screen around the table instead of the background colours.',
    },
  ];

  var st = {
    page: null, // {socket_reachable, global_override, rooms}
    catalog: [],
    tokens: null,
    error: null,
    loading: false,
    scope: 'room',
    roomId: '',
    duration: '60',
    draft: {}, // tokens, plus image URLs a catalog skin filled in
  };
  var ui = {};
  var ticker = null;

  function liveRooms() {
    return ((st.page && st.page.rooms) || []).filter(function (r) {
      return r.live;
    });
  }

  function roomLabel(r) {
    return r.name || r.code || r.room_id;
  }

  /** What would be sent as `skins[...]`: tokens + image URLs not being replaced by an upload. */
  function draftSkins() {
    var out = {};
    L.WIRE_KEYS.forEach(function (k) {
      if (pickedFile(k)) return;
      var v = st.draft[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    });
    return out;
  }

  function pickedFile(key) {
    var p = ui.pickers && ui.pickers[key];
    return p ? p.file() : null;
  }

  /** The look as it will land, a picked file shown from its local preview. */
  function previewSkins() {
    var out = draftSkins();
    IMAGE_SLOTS.forEach(function (s) {
      if (pickedFile(s.key)) out[s.key] = ui.pickers[s.key].url();
    });
    return out;
  }

  function audience() {
    if (st.scope === 'global') {
      return liveRooms().reduce(function (n, r) {
        return n + (r.player_count || 0) + (r.spectator_count || 0);
      }, 0);
    }
    var r = liveRooms().find(function (x) {
      return x.room_id === st.roomId;
    });
    return r ? (r.player_count || 0) + (r.spectator_count || 0) : 0;
  }

  function expiryText(iso) {
    if (!iso) return 'no end time — until someone clears it';
    return 'ends ' + A.relTime(iso) + ' (' + A.fmtDate(iso) + ')';
  }

  // ---- layout ----------------------------------------------------------------------

  function mount(root) {
    ui.refresh = h('button', { class: 'small', text: 'Refresh', on: { click: load } });
    root.appendChild(
      A.pageHead(
        'Overrides',
        'Push a look onto live tables. Players see it at once, without rejoining. One table: until that game ends. Every table: until the time is up.',
        [ui.refresh]
      )
    );
    ui.banners = h('div');
    root.appendChild(ui.banners);

    ui.tables = h('div', { class: 'card' });
    ui.form = h('div', { class: 'card sticky-card' });
    root.appendChild(h('div', { class: 'split' }, h('div', null, ui.tables), ui.form));
    buildForm();
  }

  function buildForm() {
    var f = ui.form;
    A.clear(f);
    f.appendChild(h('div', { class: 'card-h' }, h('b', { text: 'New override' })));
    ui.preview = h('div');
    f.appendChild(ui.preview);

    var form = h('div', { class: 'form', style: { marginTop: '12px' } });
    ui.scope = A.seg(
      [
        { value: 'room', label: 'One table' },
        { value: 'global', label: 'Every table' },
      ],
      st.scope,
      function (v) {
        st.scope = v;
        syncForm();
      }
    );
    form.appendChild(A.field('Apply to', ui.scope.root).root);

    ui.roomSelect = A.select([], '', { placeholder: 'Pick a live table' });
    ui.roomSelect.onchange = function () {
      st.roomId = ui.roomSelect.value;
      syncForm();
      renderTables();
    };
    ui.fRoom = A.field('Table', ui.roomSelect);
    form.appendChild(ui.fRoom.root);

    ui.duration = A.numberInput(st.duration, { min: 1, max: 43200, placeholder: 'until cleared' });
    ui.duration.oninput = function () {
      st.duration = ui.duration.value;
      syncForm();
    };
    ui.fDuration = A.field('For how long (minutes)', ui.duration, {
      hint: 'The server reverts on its own when the time is up. Leave empty to keep it until someone clears it (max 30 days).',
    });
    form.appendChild(ui.fDuration.root);

    ui.catalogSelect = A.select([], '', { placeholder: 'Optional' });
    ui.catalogSelect.onchange = function () {
      var skin = st.catalog.find(function (s) {
        return String(s.id) === ui.catalogSelect.value;
      });
      if (skin) {
        st.draft = {
          table_theme: skin.table_theme || '',
          card_back_style: skin.card_back_style || '',
          card_face_style: skin.card_face_style || '',
          background_style: skin.background_style || '',
          table_skin: skin.table_background || '',
          card_skin: skin.card_back || '',
          background_skin: skin.background_image || '',
        };
        resetPickers();
        fillDraftInputs();
        syncForm();
      }
    };
    form.appendChild(
      A.field('Start from a skin', ui.catalogSelect, {
        hint: 'Fills the slots below from a catalog skin; change any of them afterwards.',
      }).root
    );

    ui.tokenFields = {};
    ui.tokenBox = h('div', { class: 'form' });
    form.appendChild(ui.tokenBox);
    buildTokenSelects();

    ui.pickers = {};
    ui.dropImage = {};
    ui.imageFields = {};
    IMAGE_SLOTS.forEach(function (slot) {
      var picker = A.filePicker({
        accept: 'image/png,image/jpeg,image/webp',
        maxBytes: slot.max,
        wide: slot.wide,
        onChange: syncForm,
      });
      // A catalog skin's image can be dropped without uploading another.
      var drop = h('button', {
        type: 'button',
        class: 'small ghost',
        text: 'Remove image',
        hidden: true,
        on: {
          click: function () {
            st.draft[slot.key] = '';
            fillDraftInputs();
            syncForm();
          },
        },
      });
      ui.pickers[slot.key] = picker;
      ui.dropImage[slot.key] = drop;
      ui.imageFields[slot.key] = A.field(slot.label, h('div', null, picker.root, drop), {
        hint: slot.hint,
      });
      form.appendChild(ui.imageFields[slot.key].root);
    });

    ui.lifetime = h('div', { class: 'hint' });
    form.appendChild(ui.lifetime);
    ui.formError = h('div', { class: 'form-error' });
    form.appendChild(ui.formError);
    ui.apply = h('button', { class: 'primary', text: 'Apply', on: { click: apply } });
    ui.reset = h('button', {
      class: 'ghost',
      text: 'Reset',
      on: {
        click: function () {
          st.draft = {};
          ui.catalogSelect.value = '';
          resetPickers();
          fillDraftInputs();
          syncForm();
        },
      },
    });
    form.appendChild(h('div', { class: 'form-actions' }, ui.apply, ui.reset));
    f.appendChild(form);

    ui.fieldMap = {
      room_id: ui.fRoom,
      duration_minutes: ui.fDuration,
    };
    IMAGE_SLOTS.forEach(function (s) {
      ui.fieldMap[s.key] = ui.imageFields[s.key];
      ui.fieldMap[s.key + '_file'] = ui.imageFields[s.key];
    });
    TOKEN_SLOTS.forEach(function (s) {
      ui.fieldMap[s[0]] = ui.tokenFields[s[0]];
    });
    syncForm();
  }

  function buildTokenSelects() {
    A.clear(ui.tokenBox);
    TOKEN_SLOTS.forEach(function (slot) {
      var key = slot[0];
      var sel = A.select(L.options(key, st.tokens), st.draft[key] || '', {
        placeholder: "Keep the player's own",
      });
      sel.onchange = function () {
        st.draft[key] = sel.value;
        syncForm();
      };
      ui.tokenFields[key] = A.field(slot[1], sel);
      ui.tokenBox.appendChild(ui.tokenFields[key].root);
    });
    if (ui.fieldMap)
      TOKEN_SLOTS.forEach(function (s) {
        ui.fieldMap[s[0]] = ui.tokenFields[s[0]];
      });
  }

  function fillDraftInputs() {
    TOKEN_SLOTS.forEach(function (s) {
      var f = ui.tokenFields[s[0]];
      if (!f) return;
      var v = st.draft[s[0]] || '';
      f.control.value = v;
      if (f.control.value !== v) {
        f.control.appendChild(h('option', { value: v, text: v + ' (unknown)' }));
        f.control.value = v;
      }
    });
    IMAGE_SLOTS.forEach(function (s) {
      var url = st.draft[s.key] || null;
      ui.pickers[s.key].setCurrent(url);
      ui.dropImage[s.key].hidden = !url;
    });
  }

  function resetPickers() {
    IMAGE_SLOTS.forEach(function (s) {
      ui.pickers[s.key].reset();
    });
  }

  function syncForm() {
    var global = st.scope === 'global';
    ui.fRoom.root.hidden = global;
    ui.fDuration.root.hidden = !global;
    A.clear(ui.preview).appendChild(L.render(previewSkins()));
    var n = audience();
    var nothing = !Object.keys(previewSkins()).length;
    ui.apply.textContent = 'Apply to ' + A.fmtInt(n) + (n === 1 ? ' person' : ' people');
    ui.apply.disabled = nothing || (!global && !st.roomId);
    var mins = Number(st.duration);
    ui.lifetime.textContent = global
      ? 'Every table switches now' +
        (st.duration && mins > 0
          ? ' and reverts in ' + A.fmtInt(mins) + ' min.'
          : ' and stays that way until someone clears it.') +
        ' Anything left on "keep the player\'s own" stays each player\'s choice.'
      : 'Ends when that GAME ends — the next game uses each player\'s own skin. Slots left on "keep the player\'s own" are untouched.';
    if (nothing) ui.apply.title = 'Pick at least one slot (or a catalog skin)';
    else if (!global && !st.roomId) ui.apply.title = 'Pick a table';
    else ui.apply.title = '';
  }

  function fillRoomSelect() {
    var rooms = liveRooms();
    var sel = ui.roomSelect;
    A.clear(sel);
    sel.appendChild(
      h('option', {
        value: '',
        text: rooms.length ? 'Pick a live table' : 'No live table right now',
      })
    );
    rooms.forEach(function (r) {
      sel.appendChild(
        h('option', {
          value: r.room_id,
          text:
            roomLabel(r) + ' · ' + ((r.player_count || 0) + (r.spectator_count || 0)) + ' people',
        })
      );
    });
    if (
      st.roomId &&
      !rooms.some(function (r) {
        return r.room_id === st.roomId;
      })
    )
      st.roomId = '';
    sel.value = st.roomId;
  }

  function fillCatalogSelect() {
    var sel = ui.catalogSelect;
    var keep = sel.value;
    A.clear(sel);
    sel.appendChild(
      h('option', { value: '', text: st.catalog.length ? 'Optional' : 'No skins in the catalog' })
    );
    st.catalog.forEach(function (s) {
      sel.appendChild(
        h('option', { value: String(s.id), text: s.name + (s.is_active ? '' : ' (inactive)') })
      );
    });
    sel.value = keep;
  }

  // ---- tables ------------------------------------------------------------------------

  function renderBanners() {
    A.clear(ui.banners);
    var p = st.page;
    if (!p) return;
    if (!p.socket_reachable) {
      ui.banners.appendChild(
        h(
          'div',
          { class: 'banner warn' },
          h(
            'div',
            { class: 'grow' },
            h('b', { text: 'wlive-api cannot reach the game server. ' }),
            h('span', {
              class: 'muted',
              text: 'The list below is its database only, and an override cannot be applied right now.',
            })
          )
        )
      );
    }
    var g = p.global_override;
    if (g) {
      var clearBtn = h('button', { class: 'small', text: 'Clear' });
      clearBtn.onclick = function () {
        A.busy(clearBtn, 'Clearing…', function () {
          return A.api.del('skin-override', { scope: 'global' });
        })
          .then(function () {
            A.toast('Override cleared for every table');
            load();
          })
          .catch(function (e) {
            A.toastError('Clear failed', e);
          });
      };
      ui.globalExpiry = h('span', { class: 'muted', text: '— ' + expiryText(g.expiresAt) });
      ui.globalExpiryIso = g.expiresAt || null;
      ui.banners.appendChild(
        h(
          'div',
          { class: 'banner' },
          h(
            'div',
            { class: 'grow' },
            h(
              'div',
              { class: 'global-on' },
              h('b', { text: '🌐 An override is on for every table' }),
              ui.globalExpiry,
              g.setBy ? h('span', { class: 'muted', text: '· set by ' + g.setBy }) : null
            ),
            h(
              'div',
              { style: { marginTop: '8px', maxWidth: '420px' } },
              L.render(g.skins || {}, { small: true })
            )
          ),
          clearBtn
        )
      );
    } else {
      ui.globalExpiry = null;
    }
  }

  function renderTables() {
    var box = ui.tables;
    A.clear(box);
    box.appendChild(
      h(
        'div',
        { class: 'card-h' },
        h('b', { text: 'Live tables' }),
        st.page
          ? h('span', {
              text:
                '· ' +
                liveRooms().length +
                ' on the socket' +
                ((st.page.rooms || []).length > liveRooms().length
                  ? ', ' + ((st.page.rooms || []).length - liveRooms().length) + ' not started'
                  : ''),
            })
          : null
      )
    );
    if (st.error) {
      box.appendChild(A.errorBox(st.error, load));
      return;
    }
    if (!st.page) {
      box.appendChild(A.loadingBox(180));
      return;
    }
    var rooms = st.page.rooms || [];
    if (!rooms.length) {
      box.appendChild(
        A.stateBox({
          icon: '🃏',
          title: 'No tables right now',
          text: 'An override for one table needs a game that is being played. You can still set one for every table.',
        })
      );
      return;
    }
    var tbody = h('tbody');
    rooms.forEach(function (r) {
      var picked = r.room_id === st.roomId && st.scope === 'room';
      var src = SOURCE[r.skins_source] || SOURCE.none;
      var players = (r.players || []).slice().sort(function (a, b) {
        return (a.seat || 0) - (b.seat || 0);
      });
      var acts = h('td', { class: 'acts' });
      if (r.live) {
        acts.appendChild(
          h('button', {
            class: 'small',
            text: picked ? 'Selected' : 'Select',
            disabled: picked,
            on: {
              click: function () {
                st.scope = 'room';
                ui.scope.set('room');
                st.roomId = r.room_id;
                ui.roomSelect.value = r.room_id;
                syncForm();
                renderTables();
              },
            },
          })
        );
        acts.appendChild(
          h('button', {
            class: 'small ghost',
            text: 'Open',
            title: 'Watch this table in Live rooms',
            on: {
              click: function () {
                A.console.openRoom(r.room_id);
              },
            },
          })
        );
      }
      if (r.skin_override) {
        var clr = h('button', {
          class: 'small ghost',
          text: 'Clear',
          title: 'Back to the next source (global override, room owner, players)',
        });
        clr.onclick = function () {
          A.busy(clr, '…', function () {
            return A.api.del('skin-override', { scope: 'room', room_id: r.room_id });
          })
            .then(function () {
              A.toast('Override cleared on ' + roomLabel(r));
              load();
            })
            .catch(function (e) {
              A.toastError('Clear failed', e);
            });
        };
        acts.appendChild(clr);
      }
      var sub = [
        r.host && r.host.name ? 'host ' + r.host.name : 'no host',
        r.bet ? '🪙 ' + A.fmtInt(r.bet) : 'free',
        r.status || null,
        r.live ? null : 'not on the socket',
      ];
      tbody.appendChild(
        h(
          'tr',
          { class: (picked ? 'picked ' : '') + (r.live ? '' : 'off') },
          h(
            'td',
            null,
            h('div', { class: 'rname', text: roomLabel(r) }),
            h('div', { class: 'hint', text: sub.filter(Boolean).join(' · ') }),
            h(
              'div',
              { class: 'players' },
              players.map(function (p) {
                return h('span', {
                  class: 'pl' + (p.connected === false ? ' off' : ''),
                  title: (p.player_id || '') + (p.connected === false ? ' · offline' : ''),
                  text: (p.name || p.player_id || '?') + (p.is_bot ? ' 🤖' : ''),
                });
              })
            )
          ),
          h(
            'td',
            { class: 'nowrap num' },
            h('div', { text: '👥 ' + (r.player_count || 0) + '/' + (r.max_players || '?') }),
            h('div', { class: 'hint', text: '👁 ' + (r.spectator_count || 0) })
          ),
          h(
            'td',
            null,
            h('span', { class: 'badge ' + src.cls, text: src.text }),
            r.skins_expires_at
              ? h('div', { class: 'hint', text: expiryText(r.skins_expires_at) })
              : null,
            r.skin_override && r.skin_override.setBy
              ? h('div', { class: 'hint', text: 'set by ' + r.skin_override.setBy })
              : null,
            Object.keys(r.skins || {}).length
              ? h(
                  'div',
                  { style: { marginTop: '6px', width: '190px' } },
                  L.render(r.skins, { small: true, chips: false })
                )
              : null
          ),
          acts
        )
      );
    });
    box.appendChild(
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'rooms-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { text: 'Table' }),
              h('th', { text: 'People' }),
              h('th', { text: 'Look now' }),
              h('th')
            )
          ),
          tbody
        )
      )
    );
  }

  // ---- data -------------------------------------------------------------------------

  function load() {
    if (st.loading) return;
    st.loading = true;
    ui.refresh.disabled = true;
    Promise.all([
      A.api.get('rooms'),
      A.api.get('skins').catch(function (e) {
        return { error: e };
      }),
      st.tokens
        ? Promise.resolve({ data: st.tokens })
        : A.api.get('skin-tokens').catch(function (e) {
            return { error: e };
          }),
    ])
      .then(
        function (out) {
          st.error = null;
          st.page = out[0].data || { rooms: [] };
          st.catalog = Array.isArray(out[1].data) ? out[1].data : [];
          if (out[2].data && !st.tokens) {
            st.tokens = out[2].data;
            buildTokenSelects();
            fillDraftInputs();
          }
        },
        function (err) {
          st.error = err;
          st.page = null;
        }
      )
      .then(function () {
        st.loading = false;
        ui.refresh.disabled = false;
        fillRoomSelect();
        fillCatalogSelect();
        renderBanners();
        renderTables();
        syncForm();
      });
  }

  function apply() {
    var skins = draftSkins();
    var shown = previewSkins();
    if (!Object.keys(shown).length) return;
    var global = st.scope === 'global';
    if (!global && !st.roomId) return;
    var mins = Number(st.duration);
    var durationMinutes =
      global && st.duration !== '' && Number.isFinite(mins) && mins > 0 ? Math.round(mins) : null;
    // Multipart: picked images travel as files; wlive-api stores them and
    // pushes their URLs to the socket.
    var body = new FormData();
    body.append('scope', st.scope);
    if (!global) body.append('room_id', st.roomId);
    if (durationMinutes) body.append('duration_minutes', String(durationMinutes));
    Object.keys(skins).forEach(function (k) {
      body.append('skins[' + k + ']', skins[k]);
    });
    var uploads = [];
    IMAGE_SLOTS.forEach(function (s) {
      var f = pickedFile(s.key);
      if (f) {
        body.append(s.key + '_file', f, f.name);
        uploads.push(s.key);
      }
    });
    var n = audience();
    var ask = global
      ? A.confirmDialog({
          title: 'Override every table?',
          confirmText: 'Apply to every table',
          body: [
            h('div', {
              text:
                'Every live table switches to this look now' +
                (durationMinutes
                  ? ' for ' + A.fmtInt(durationMinutes) + ' minutes.'
                  : ', until someone clears it.'),
            }),
            h(
              'ul',
              { class: 'confirm-list' },
              h(
                'li',
                null,
                h('b', { text: A.fmtInt(n) + ' people' }),
                ' are at a table right now; tables that open later get it too.'
              ),
              h('li', null, 'Slots left on "keep the player\'s own" stay each player\'s choice.'),
              h('li', null, 'A one-table override still wins on its own table.')
            ),
            h('div', { style: { marginTop: '10px' } }, L.render(shown, { small: true })),
          ],
        })
      : Promise.resolve(true);
    ask
      .then(function (ok) {
        if (!ok) return;
        A.showErrors(null, ui.fieldMap, ui.formError);
        return A.busy(ui.apply, uploads.length ? 'Uploading…' : 'Applying…', function () {
          return A.api.upload('skin-override', body);
        }).then(function (res) {
          var d = res.data || {};
          // The uploads are stored now: keep their URLs so applying the same
          // look again (another table) does not upload them a second time.
          uploads.forEach(function (k) {
            if (d.skins && d.skins[k]) st.draft[k] = d.skins[k];
          });
          if (uploads.length) {
            resetPickers();
            fillDraftInputs();
          }
          A.toast(
            'Override applied — ' +
              A.fmtInt(n) +
              (n === 1 ? ' person is' : ' people are') +
              ' seeing it now' +
              (d.expires_at ? ' (ends ' + A.relTime(d.expires_at) + ')' : '')
          );
          load();
        });
      })
      .catch(function (err) {
        A.showErrors(err, ui.fieldMap, ui.formError);
        if (err && err.code !== 'ACTOR_REQUIRED') A.toastError('Override not applied', err);
      });
  }

  A.registerPage('overrides', {
    mount: mount,
    show: function () {
      load();
      if (!ticker) {
        ticker = setInterval(function () {
          if (ui.globalExpiry && ui.globalExpiryIso)
            ui.globalExpiry.textContent = '— ' + expiryText(ui.globalExpiryIso);
        }, 30000);
      }
    },
    hide: function () {
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    },
  });
})();

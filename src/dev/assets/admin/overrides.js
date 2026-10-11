/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Overrides — push a look onto live tables; players see it mid-game (the
 * socket sends `skins_updated`, nobody rejoins).
 *
 * The page reads top to bottom as the job does:
 *   1. Where — one live table (until that GAME ends) or every table (for a
 *      while, or until cleared);
 *   2. Look — per slot (table, background, card back, card face): leave the
 *      player's own, pick a built-in look from its swatches, or UPLOAD an
 *      image (no URLs to type; a catalog skin can prefill everything);
 * and the preview + Apply stay in view on the right.
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
  var icon = A.icon;

  var MB = 1024 * 1024;
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  // One section per thing a player sees. `imageKey` slots can take an upload
  // (wlive-api `<imageKey>_file`, same size limits as here).
  var SLOTS = [
    {
      id: 'table',
      title: 'Table',
      desc: 'The felt the cards sit on.',
      tokenKey: 'table_theme',
      imageKey: 'table_skin',
      presetLabel: 'Colour',
      maxBytes: 8 * MB,
      shape: 'wide',
      imageHint: 'Covers the felt. Landscape PNG, JPEG or WebP, up to 8 MB.',
      catalogImage: 'table_background',
    },
    {
      id: 'background',
      title: 'Background',
      desc: 'The screen around the table.',
      tokenKey: 'background_style',
      imageKey: 'background_skin',
      presetLabel: 'Colour',
      maxBytes: 8 * MB,
      shape: 'wide',
      imageHint: 'Fills the screen around the table. Landscape, up to 8 MB.',
      catalogImage: 'background_image',
    },
    {
      id: 'back',
      title: 'Card back',
      desc: 'What every face-down card shows.',
      tokenKey: 'card_back_style',
      imageKey: 'card_skin',
      presetLabel: 'Design',
      maxBytes: 4 * MB,
      shape: 'card',
      imageHint: 'Portrait card art, up to 4 MB.',
      catalogImage: 'card_back',
    },
    {
      id: 'face',
      title: 'Card face',
      desc: 'How ranks and suits are printed.',
      tokenKey: 'card_face_style',
      imageKey: null,
      presetLabel: 'Design',
    },
  ];
  // Slots an older wlive-api does not know: it drops them without an error,
  // so the page checks first (GET skin-tokens lists background_style).
  var NEEDS_NEW_API = { background: true };

  var SOURCE = {
    admin_room: { text: 'Admin, this game', cls: 'info' },
    admin_global: { text: 'Admin, every table', cls: 'info' },
    owner: { text: "Room owner's skin", cls: 'gold' },
    none: { text: "Players' own", cls: 'neutral' },
  };
  var DURATIONS = [
    { value: '30', label: '30 min' },
    { value: '60', label: '1 hour' },
    { value: '180', label: '3 hours' },
    { value: '1440', label: '1 day' },
    { value: '', label: 'Until cleared' },
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
    catalogId: '',
    slots: null,
  };
  var ui = {};
  var ticker = null;

  function emptySlots() {
    var out = {};
    SLOTS.forEach(function (s) {
      out[s.id] = { mode: 'own', token: '', url: '', file: null, objectUrl: null, from: null };
    });
    return out;
  }
  st.slots = emptySlots();

  /** The wlive-api behind the proxy knows the background slot and takes uploads. */
  function apiIsCurrent() {
    return !st.tokens || Array.isArray(st.tokens.background_style);
  }

  function slotDisabled(s) {
    return !!NEEDS_NEW_API[s.id] && !apiIsCurrent();
  }

  function liveRooms() {
    return ((st.page && st.page.rooms) || []).filter(function (r) {
      return r.live;
    });
  }

  function pickedRoom() {
    return (
      liveRooms().find(function (r) {
        return r.room_id === st.roomId;
      }) || null
    );
  }

  function roomLabel(r) {
    return r.name || r.code || r.room_id;
  }

  function people(r) {
    return (r.player_count || 0) + (r.spectator_count || 0);
  }

  function audience() {
    if (st.scope === 'global') {
      return liveRooms().reduce(function (n, r) {
        return n + people(r);
      }, 0);
    }
    var r = pickedRoom();
    return r ? people(r) : 0;
  }

  function expiryText(iso) {
    if (!iso) return 'no end time, until someone clears it';
    return 'ends ' + A.relTime(iso) + ' (' + A.fmtDate(iso) + ')';
  }

  function tokenLabel(s, value) {
    var list = (st.tokens && st.tokens[s.tokenKey]) || [];
    var t = list.find(function (x) {
      return x.value === value;
    });
    return t ? t.label : L.label(s.tokenKey, value);
  }

  function fileSize(bytes) {
    return bytes >= MB
      ? Math.round((bytes / MB) * 10) / 10 + ' MB'
      : Math.round(bytes / 1024) + ' KB';
  }

  // ---- the draft -------------------------------------------------------------------

  /** A slot's state in words, and whether it is ready to send. */
  function slotStatus(s) {
    var v = st.slots[s.id];
    if (v.mode === 'preset') {
      return v.token
        ? { ok: true, text: tokenLabel(s, v.token) }
        : { ok: false, text: 'pick a ' + s.presetLabel.toLowerCase() };
    }
    if (v.mode === 'image') {
      if (v.file) return { ok: true, text: 'image · ' + v.file.name };
      if (v.url) return { ok: true, text: 'image' + (v.from ? ' from ' + v.from : '') };
      return { ok: false, text: 'choose an image' };
    }
    return { ok: true, own: true, text: "player's own" };
  }

  /** The look as it will land (a picked file shown from its local copy). */
  function previewSkins() {
    var out = {};
    SLOTS.forEach(function (s) {
      var v = st.slots[s.id];
      if (v.mode === 'preset' && v.token) out[s.tokenKey] = v.token;
      if (v.mode === 'image') {
        var u = v.file ? v.objectUrl : v.url;
        if (u) out[s.imageKey] = u;
      }
    });
    return out;
  }

  function changedSlots() {
    return SLOTS.filter(function (s) {
      return !slotDisabled(s) && st.slots[s.id].mode !== 'own';
    });
  }

  /** Why Apply is not possible right now, or null. */
  function blocker() {
    if (!st.page) return 'Loading the tables…';
    if (!st.page.socket_reachable) return 'wlive-api cannot reach the game server.';
    if (st.scope === 'room' && !pickedRoom()) return 'Pick a table in step 1.';
    var changed = changedSlots();
    if (!changed.length) return 'Change at least one thing in step 2.';
    for (var i = 0; i < changed.length; i++) {
      var stt = slotStatus(changed[i]);
      if (!stt.ok) return changed[i].title + ': ' + stt.text + '.';
    }
    return null;
  }

  function setFile(s, file) {
    var v = st.slots[s.id];
    if (v.objectUrl) URL.revokeObjectURL(v.objectUrl);
    v.file = file;
    v.objectUrl = file ? URL.createObjectURL(file) : null;
    if (file) v.from = null;
  }

  function resetDraft() {
    SLOTS.forEach(function (s) {
      setFile(s, null);
    });
    st.slots = emptySlots();
    st.catalogId = '';
  }

  /** A catalog skin fills every slot it has; the rest stay the player's own. */
  function fromCatalog(skin) {
    resetDraft();
    st.catalogId = String(skin.id);
    SLOTS.forEach(function (s) {
      if (slotDisabled(s)) return;
      var v = st.slots[s.id];
      var img = s.catalogImage && apiIsCurrent() ? skin[s.catalogImage] : null;
      var tok = skin[s.tokenKey];
      if (img) {
        v.mode = 'image';
        v.url = img;
        v.from = '“' + skin.name + '”';
      } else if (tok) {
        v.mode = 'preset';
        v.token = tok;
      }
    });
  }

  // ---- layout ----------------------------------------------------------------------

  function mount(root) {
    ui.refresh = h('button', { class: 'small', on: { click: load } }, icon('refresh'), 'Refresh');
    root.appendChild(
      A.pageHead(
        'Overrides',
        'Change how live tables look. Players see it at once, without rejoining.',
        [ui.refresh]
      )
    );
    ui.banners = h('div');
    root.appendChild(ui.banners);

    ui.where = h('div', { class: 'card' });
    ui.look = h('div', { class: 'card' });
    ui.apply = h('div', { class: 'card ov-apply' });
    root.appendChild(h('div', { class: 'ov-layout' }, h('div', null, ui.where, ui.look), ui.apply));

    buildWhere();
    buildLook();
    buildApply();
  }

  function stepHead(n, title, tools) {
    return h(
      'div',
      { class: 'ov-card-h' },
      h('span', { class: 'ov-step', text: String(n) }),
      h('b', { text: title }),
      h('span', { class: 'spacer' }),
      tools || null
    );
  }

  // ---- 1. where ----------------------------------------------------------------------

  function buildWhere() {
    A.clear(ui.where);
    ui.where.appendChild(stepHead(1, 'Where'));
    ui.scope = A.seg(
      [
        { value: 'room', label: 'One table' },
        { value: 'global', label: 'Every table' },
      ],
      st.scope,
      function (v) {
        st.scope = v;
        renderWhere();
        syncApply();
      }
    );
    ui.scopeNote = h('span', { class: 'note' });
    ui.where.appendChild(h('div', { class: 'ov-scope' }, ui.scope.root, ui.scopeNote));

    ui.durationInput = A.numberInput(st.duration, { min: 1, max: 43200, placeholder: 'minutes' });
    ui.durationInput.oninput = function () {
      st.duration = ui.durationInput.value;
      paintDurationChips();
      syncApply();
    };
    ui.durationChips = DURATIONS.map(function (d) {
      return h('button', {
        type: 'button',
        class: 'ov-chip',
        text: d.label,
        on: {
          click: function () {
            st.duration = d.value;
            ui.durationInput.value = d.value;
            paintDurationChips();
            syncApply();
          },
        },
      });
    });
    ui.durationErr = h('span', { style: { color: '#ff9b9b', fontSize: '12px' } });
    ui.duration = h(
      'div',
      { class: 'ov-duration' },
      h('span', { class: 'lbl', text: 'For' }),
      ui.durationChips,
      ui.durationInput,
      h('span', { class: 'lbl', text: 'min' }),
      ui.durationErr
    );
    ui.where.appendChild(ui.duration);
    ui.roomList = h('div', { class: 'ov-rooms' });
    ui.where.appendChild(ui.roomList);
    renderWhere();
  }

  function paintDurationChips() {
    DURATIONS.forEach(function (d, i) {
      ui.durationChips[i].classList.toggle('on', st.duration === d.value);
    });
  }

  function renderWhere() {
    var global = st.scope === 'global';
    ui.scope.set(st.scope);
    ui.duration.hidden = !global;
    paintDurationChips();
    ui.scopeNote.textContent = global
      ? 'Every live table switches now, and tables that open later get it too.'
      : 'Lasts until that game ends; the next game is back on each player’s own look.';
    renderRooms();
  }

  /** Small tiles of the slots a skins map holds (or null when it holds none). */
  function heldStrip(skins) {
    var out = h('div', { class: 'ov-held' });
    SLOTS.forEach(function (s) {
      var img = s.imageKey ? A.safeUrl(skins[s.imageKey]) : null;
      if (img) {
        out.appendChild(
          h('span', {
            class: 'ov-thumb',
            title: s.title + ': image',
            style: { backgroundImage: A.cssUrl(img) },
          })
        );
      } else if (skins[s.tokenKey]) {
        var sw = L.swatch(s.tokenKey, skins[s.tokenKey]);
        sw.title = s.title + ': ' + tokenLabel(s, skins[s.tokenKey]);
        out.appendChild(sw);
      }
    });
    return out.childNodes.length ? out : null;
  }

  function clearRoomButton(r) {
    var clr = h('button', {
      class: 'small',
      text: 'Clear override',
      title: 'Back to the next source (every-table override, room owner, players)',
    });
    clr.onclick = function (e) {
      e.stopPropagation();
      A.busy(clr, 'Clearing…', function () {
        return A.api.del('skin-override', { scope: 'room', room_id: r.room_id });
      })
        .then(function () {
          A.toast('Override cleared on ' + roomLabel(r));
          load();
        })
        .catch(function (err) {
          A.toastError('Clear failed', err);
        });
    };
    return clr;
  }

  function renderRooms() {
    var box = ui.roomList;
    A.clear(box);
    if (st.error) {
      box.appendChild(A.errorBox(st.error, load));
      return;
    }
    if (!st.page) {
      box.appendChild(A.loadingBox(120));
      return;
    }
    var rooms = st.page.rooms || [];
    var global = st.scope === 'global';
    if (!rooms.length) {
      box.appendChild(
        A.stateBox({
          icon: 'cards',
          title: 'No tables right now',
          text: global
            ? 'Tables that open while the override is on get it too.'
            : 'One table needs a game that is being played. "Every table" works without one.',
        })
      );
      return;
    }
    rooms.forEach(function (r) {
      var pickable = !global && r.live;
      var picked = pickable && r.room_id === st.roomId;
      var src = SOURCE[r.skins_source] || SOURCE.none;
      var players = (r.players || []).slice().sort(function (a, b) {
        return (a.seat || 0) - (b.seat || 0);
      });
      var acts = h('div', { class: 'acts' });
      if (r.live) {
        acts.appendChild(
          h(
            'button',
            {
              class: 'small ghost',
              title: 'Watch this table in Live rooms',
              on: {
                click: function (e) {
                  e.stopPropagation();
                  A.console.openRoom(r.room_id);
                },
              },
            },
            icon('eye'),
            ' Watch'
          )
        );
      }
      if (r.skin_override) acts.appendChild(clearRoomButton(r));
      var meta = [
        r.host && r.host.name ? 'host ' + r.host.name : 'no host',
        r.bet ? A.fmtInt(r.bet) + ' coins' : 'free',
        r.status ? String(r.status).replace(/_/g, ' ') : null,
        r.live ? null : 'not started, cannot be changed yet',
      ];
      var row = h(
        'div',
        {
          class:
            'ov-room' +
            (pickable ? ' pickable' : '') +
            (picked ? ' picked' : '') +
            (r.live ? '' : ' off'),
          attrs: pickable
            ? { role: 'radio', 'aria-checked': picked ? 'true' : 'false', tabindex: '0' }
            : {},
        },
        h('span', { class: pickable ? 'ov-radio' : '' }),
        h(
          'div',
          null,
          h(
            'div',
            { class: 'name' },
            roomLabel(r),
            r.code && r.name ? h('span', { class: 'tag', text: r.code }) : null
          ),
          h('div', { class: 'meta', text: meta.filter(Boolean).join(' · ') }),
          h(
            'div',
            { class: 'players' },
            players.map(function (p) {
              return h(
                'span',
                {
                  class: 'pl' + (p.connected === false ? ' off' : ''),
                  title: (p.player_id || '') + (p.connected === false ? ' · offline' : ''),
                },
                p.is_bot ? icon('bot') : null,
                p.name || p.player_id || '?'
              );
            })
          )
        ),
        h(
          'div',
          { class: 'people' },
          h(
            'span',
            { title: 'seated' },
            icon('users'),
            h('b', { text: (r.player_count || 0) + '/' + (r.max_players || '?') })
          ),
          h('span', { title: 'watching' }, icon('eye'), String(r.spectator_count || 0))
        ),
        h(
          'div',
          { class: 'look' },
          h('span', { class: 'badge ' + src.cls, text: src.text }),
          heldStrip(r.skins || {}),
          r.skins_expires_at ? h('span', { text: expiryText(r.skins_expires_at) }) : null,
          r.skin_override && r.skin_override.setBy
            ? h('span', { text: 'set by ' + r.skin_override.setBy })
            : null
        ),
        acts
      );
      if (pickable) {
        var pick = function () {
          st.roomId = r.room_id;
          renderRooms();
          syncApply();
        };
        row.addEventListener('click', pick);
        row.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
      }
      box.appendChild(row);
    });
  }

  // ---- 2. look -----------------------------------------------------------------------

  function buildLook() {
    A.clear(ui.look);
    ui.catalogSelect = A.select([], '', { placeholder: 'None' });
    ui.catalogSelect.onchange = function () {
      var skin = st.catalog.find(function (s) {
        return String(s.id) === ui.catalogSelect.value;
      });
      if (skin) fromCatalog(skin);
      else resetDraft();
      renderLook();
      syncApply();
    };
    ui.look.appendChild(
      stepHead(
        2,
        'Look',
        h(
          'label',
          { class: 'ov-look-tools' },
          h('span', { class: 'lbl', text: 'Start from a catalog skin' }),
          ui.catalogSelect
        )
      )
    );
    ui.apiNote = h('div');
    ui.look.appendChild(ui.apiNote);
    ui.slotBox = h('div');
    ui.look.appendChild(ui.slotBox);
    renderLook();
  }

  function fillCatalogSelect() {
    var sel = ui.catalogSelect;
    A.clear(sel);
    sel.appendChild(
      h('option', { value: '', text: st.catalog.length ? 'None' : 'No skins in the catalog' })
    );
    st.catalog.forEach(function (s) {
      sel.appendChild(
        h('option', { value: String(s.id), text: s.name + (s.is_active ? '' : ' (not on sale)') })
      );
    });
    sel.value = st.catalogId;
  }

  function renderLook() {
    A.clear(ui.apiNote);
    if (!apiIsCurrent()) {
      ui.apiNote.appendChild(
        h(
          'div',
          { class: 'banner warn' },
          icon('alert'),
          h(
            'div',
            { class: 'grow' },
            h('b', { text: 'This wlive-api is older than the console. ' }),
            h('span', {
              class: 'muted',
              text: 'It ignores the background and uploaded images, so only the built-in table and card looks can be applied. Deploy wlive-api with the background slot (feat/buraco-game c8cd1fab and its migration) to unlock them.',
            })
          )
        )
      );
    }
    A.clear(ui.slotBox);
    ui.slotEls = {};
    SLOTS.forEach(function (s) {
      ui.slotEls[s.id] = renderSlot(s);
      ui.slotBox.appendChild(ui.slotEls[s.id]);
    });
  }

  function renderSlot(s) {
    var v = st.slots[s.id];
    var disabled = slotDisabled(s);
    var images = !!s.imageKey && apiIsCurrent();
    var modes = [
      { value: 'own', label: "Player's own" },
      { value: 'preset', label: s.presetLabel },
    ];
    if (images) modes.push({ value: 'image', label: 'Upload image' });
    if (v.mode === 'image' && !images) v.mode = 'own';
    var sec = h('section', { class: 'ov-slot' });
    var mode = A.seg(modes, v.mode, function (m) {
      v.mode = m;
      replaceSlot(s);
      syncApply();
    });
    sec.appendChild(
      h(
        'div',
        { class: 'ov-slot-h' },
        h(
          'div',
          null,
          h('div', { class: 't', text: s.title }),
          h('div', { class: 'd', text: s.desc })
        ),
        h('span', { class: 'spacer' }),
        disabled ? h('span', { class: 'badge warn', text: 'needs a newer wlive-api' }) : mode.root
      )
    );
    if (disabled) return sec;
    if (v.mode === 'own') {
      sec.appendChild(
        h('div', {
          class: 'ov-own',
          text: 'Not changed. Each player keeps the ' + s.title.toLowerCase() + ' they chose.',
        })
      );
    } else if (v.mode === 'preset') {
      sec.appendChild(swatchGrid(s));
    } else {
      sec.appendChild(dropZone(s));
    }
    sec.err = h('div', { class: 'err' });
    sec.appendChild(sec.err);
    return sec;
  }

  function replaceSlot(s) {
    var old = ui.slotEls[s.id];
    var fresh = renderSlot(s);
    ui.slotEls[s.id] = fresh;
    old.parentNode.replaceChild(fresh, old);
  }

  function swatchGrid(s) {
    var v = st.slots[s.id];
    var grid = h('div', {
      class: 'ov-swatches',
      attrs: { role: 'radiogroup', 'aria-label': s.title },
    });
    L.options(s.tokenKey, st.tokens).forEach(function (o) {
      var on = v.token === o.value;
      var b = h(
        'button',
        {
          type: 'button',
          class: 'ov-sw' + (on ? ' on' : ''),
          title: o.label,
          attrs: { role: 'radio', 'aria-checked': on ? 'true' : 'false' },
        },
        h('span', { class: 'ok' }, icon('check')),
        L.swatch(s.tokenKey, o.value),
        h('span', { class: 'lbl', text: o.label })
      );
      b.onclick = function () {
        v.token = o.value;
        grid.querySelectorAll('.ov-sw').forEach(function (x) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-checked', x === b ? 'true' : 'false');
        });
        ui.slotEls[s.id].classList.remove('bad');
        syncApply();
      };
      grid.appendChild(b);
    });
    return grid;
  }

  function dropZone(s) {
    var v = st.slots[s.id];
    var input = h('input', { type: 'file', accept: IMAGE_TYPES.join(',') });
    var err = h('div', { class: 'sm', style: { color: '#ff9b9b' } });
    function take(file) {
      if (!file) return;
      if (IMAGE_TYPES.indexOf(file.type) === -1) {
        err.textContent =
          'Use a PNG, JPEG or WebP image (that file is ' + (file.type || 'unknown') + ').';
        return;
      }
      if (file.size > s.maxBytes) {
        err.textContent =
          'Too large: ' + fileSize(file.size) + ' (max ' + fileSize(s.maxBytes) + ').';
        return;
      }
      setFile(s, file);
      replaceSlot(s);
      syncApply();
    }
    input.onchange = function () {
      var f = input.files && input.files[0];
      input.value = '';
      take(f);
    };
    var choose = function () {
      input.click();
    };
    var src = v.file ? v.objectUrl : A.safeUrl(v.url);
    var zone;
    if (src) {
      zone = h(
        'div',
        { class: 'ov-drop' },
        h('div', {
          class: 'pic' + (s.shape === 'card' ? ' card' : ''),
          style: { backgroundImage: A.cssUrl(src) },
        }),
        h(
          'div',
          { class: 'meta' },
          h('div', {
            class: 'nm',
            text: v.file ? v.file.name : 'Image' + (v.from ? ' from ' + v.from : ''),
          }),
          h('div', {
            class: 'sm',
            text: v.file
              ? fileSize(v.file.size) + ' · uploaded when you apply'
              : 'already uploaded',
          }),
          h(
            'div',
            { class: 'btns' },
            h(
              'button',
              { type: 'button', class: 'small', on: { click: choose } },
              icon('upload'),
              'Replace'
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'small ghost',
                on: {
                  click: function () {
                    setFile(s, null);
                    v.url = '';
                    v.from = null;
                    replaceSlot(s);
                    syncApply();
                  },
                },
              },
              icon('trash'),
              'Remove'
            )
          ),
          err
        ),
        input
      );
    } else {
      zone = h(
        'div',
        { class: 'ov-drop empty' },
        icon('image'),
        h('div', null, 'Drop an image here, or'),
        h(
          'button',
          { type: 'button', class: 'small', on: { click: choose } },
          icon('upload'),
          'Choose file'
        ),
        h('div', { class: 'sm', text: s.imageHint }),
        err,
        input
      );
    }
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('over');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('over');
      take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    return zone;
  }

  // ---- preview + apply ----------------------------------------------------------------

  function buildApply() {
    A.clear(ui.apply);
    ui.preview = h('div');
    ui.summary = h('div', { class: 'ov-sum' });
    ui.target = h('div', { class: 'ov-target' });
    ui.formError = h('div', { class: 'form-error' });
    ui.go = h('button', { class: 'primary go', on: { click: apply } });
    ui.why = h('div', { class: 'why' });
    ui.reset = h('button', {
      class: 'small ghost',
      text: 'Start over',
      on: {
        click: function () {
          resetDraft();
          ui.catalogSelect.value = '';
          renderLook();
          syncApply();
        },
      },
    });
    ui.apply.appendChild(
      h('div', { class: 'card-h', style: { marginBottom: 0 } }, h('b', { text: 'Preview' }))
    );
    [ui.preview, ui.summary, ui.target, ui.formError, ui.go, ui.why].forEach(function (n) {
      ui.apply.appendChild(n);
    });
    ui.apply.appendChild(h('div', { class: 'foot' }, ui.reset));
    syncApply();
  }

  function syncApply() {
    if (!ui.preview) return;
    A.clear(ui.preview).appendChild(L.render(previewSkins(), { chips: false }));
    A.clear(ui.summary);
    SLOTS.forEach(function (s) {
      if (slotDisabled(s)) return;
      var stt = slotStatus(s);
      ui.summary.appendChild(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'k', text: s.title }),
          h('span', {
            class: 'v' + (stt.own ? ' own' : stt.ok ? '' : ' todo'),
            text: stt.text,
            title: stt.text,
          })
        )
      );
    });

    var global = st.scope === 'global';
    var n = audience();
    var room = pickedRoom();
    var mins = Number(st.duration);
    var timed = global && st.duration !== '' && Number.isFinite(mins) && mins > 0;
    A.clear(ui.target);
    if (global) {
      ui.target.appendChild(h('b', { text: 'Every table' }));
      ui.target.appendChild(
        document.createTextNode(
          ' · ' +
            A.fmtInt(n) +
            (n === 1 ? ' person' : ' people') +
            ' at ' +
            liveRooms().length +
            (liveRooms().length === 1 ? ' table' : ' tables') +
            ' now'
        )
      );
      ui.target.appendChild(
        h('span', {
          class: 'muted',
          text: timed
            ? 'Reverts by itself after ' +
              A.fmtInt(mins) +
              ' min, at ' +
              A.fmtDate(new Date(Date.now() + mins * 60000).toISOString()) +
              '.'
            : 'Stays until someone clears it.',
        })
      );
    } else if (room) {
      ui.target.appendChild(h('b', { text: roomLabel(room) }));
      ui.target.appendChild(
        document.createTextNode(' · ' + A.fmtInt(n) + (n === 1 ? ' person' : ' people'))
      );
      ui.target.appendChild(h('span', { class: 'muted', text: 'Ends when this game ends.' }));
    } else {
      ui.target.appendChild(h('span', { class: 'muted', text: 'No table picked yet.' }));
    }

    var why = blocker();
    ui.go.disabled = !!why;
    A.clear(ui.go);
    ui.go.appendChild(icon('check'));
    ui.go.appendChild(
      document.createTextNode(
        global ? 'Apply to every table' : room ? 'Apply to ' + roomLabel(room) : 'Apply'
      )
    );
    ui.why.textContent = why || '';
    ui.why.hidden = !why;
  }

  // ---- data ---------------------------------------------------------------------------

  function renderBanners() {
    A.clear(ui.banners);
    var p = st.page;
    if (!p) return;
    if (!p.socket_reachable) {
      ui.banners.appendChild(
        h(
          'div',
          { class: 'banner warn' },
          icon('wifi-off'),
          h(
            'div',
            { class: 'grow' },
            h('b', { text: 'wlive-api cannot reach the game server. ' }),
            h('span', {
              class: 'muted',
              text: 'The tables below come from its database only, and nothing can be applied right now.',
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
      ui.globalExpiry = h('span', { class: 'muted', text: expiryText(g.expiresAt) });
      ui.globalExpiryIso = g.expiresAt || null;
      ui.banners.appendChild(
        h(
          'div',
          { class: 'banner' },
          icon('globe'),
          h(
            'div',
            { class: 'grow' },
            h(
              'div',
              { class: 'global-on' },
              h('b', { text: 'An override is on for every table' }),
              heldStrip(g.skins || {}),
              ui.globalExpiry,
              g.setBy ? h('span', { class: 'muted', text: '· set by ' + g.setBy }) : null
            )
          ),
          clearBtn
        )
      );
    } else {
      ui.globalExpiry = null;
    }
  }

  function load() {
    if (st.loading) return;
    st.loading = true;
    ui.refresh.disabled = true;
    var hadTokens = !!st.tokens;
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
          if (out[2].data) st.tokens = out[2].data;
        },
        function (err) {
          st.error = err;
          st.page = null;
        }
      )
      .then(function () {
        st.loading = false;
        ui.refresh.disabled = false;
        if (st.roomId && !pickedRoom()) st.roomId = '';
        // The only live table is the only choice: pick it.
        if (st.scope === 'room' && !st.roomId && liveRooms().length === 1)
          st.roomId = liveRooms()[0].room_id;
        fillCatalogSelect();
        renderBanners();
        renderWhere();
        if (!hadTokens && st.tokens) renderLook();
        syncApply();
      });
  }

  function apply() {
    if (blocker()) return;
    var global = st.scope === 'global';
    var room = pickedRoom();
    var mins = Number(st.duration);
    var durationMinutes =
      global && st.duration !== '' && Number.isFinite(mins) && mins > 0 ? Math.round(mins) : null;
    // Multipart: uploads travel as files; wlive-api stores them and pushes
    // their URLs to the socket.
    var body = new FormData();
    body.append('scope', st.scope);
    if (!global) body.append('room_id', room.room_id);
    if (durationMinutes) body.append('duration_minutes', String(durationMinutes));
    var uploads = [];
    changedSlots().forEach(function (s) {
      var v = st.slots[s.id];
      if (v.mode === 'preset') body.append('skins[' + s.tokenKey + ']', v.token);
      else if (v.file) {
        body.append(s.imageKey + '_file', v.file, v.file.name);
        uploads.push(s);
      } else body.append('skins[' + s.imageKey + ']', v.url);
    });
    var n = audience();
    var ask = global
      ? A.confirmDialog({
          title: 'Change every table?',
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
              h('li', null, 'Anything left on "Player\'s own" stays each player\'s choice.'),
              h('li', null, 'A one-table override still wins on its own table.')
            ),
            h(
              'div',
              { style: { marginTop: '10px' } },
              L.render(previewSkins(), { small: true, chips: false })
            ),
          ],
        })
      : Promise.resolve(true);
    var fieldMap = slotFieldMap();
    ask
      .then(function (ok) {
        if (!ok) return;
        A.showErrors(null, fieldMap, ui.formError);
        return A.busy(ui.go, uploads.length ? 'Uploading…' : 'Applying…', function () {
          return A.api.upload('skin-override', body);
        }).then(function (res) {
          var d = res.data || {};
          // The uploads are stored now: keep their URLs, so applying the same
          // look to another table does not upload them again.
          uploads.forEach(function (s) {
            if (d.skins && d.skins[s.imageKey]) {
              setFile(s, null);
              st.slots[s.id].url = d.skins[s.imageKey];
            }
          });
          if (uploads.length) renderLook();
          A.toast(
            'Applied. ' +
              A.fmtInt(n) +
              (n === 1 ? ' person is' : ' people are') +
              ' seeing it now' +
              (d.expires_at ? ' (ends ' + A.relTime(d.expires_at) + ')' : '') +
              '.'
          );
          load();
        });
      })
      .catch(function (err) {
        A.showErrors(err, fieldMap, ui.formError);
        if (err && err.code !== 'ACTOR_REQUIRED') A.toastError('Not applied', err);
      });
  }

  /** wlive-api validation keys → the section that shows the message. */
  function slotFieldMap() {
    var map = {};
    SLOTS.forEach(function (s) {
      var sec = ui.slotEls[s.id];
      var f = {
        root: sec,
        setError: function (msg) {
          sec.classList.toggle('bad', !!msg);
          if (sec.err) sec.err.textContent = msg || '';
        },
      };
      map[s.tokenKey] = f;
      if (s.imageKey) {
        map[s.imageKey] = f;
        map[s.imageKey + '_file'] = f;
      }
    });
    var where = {
      root: ui.where,
      setError: function (msg) {
        ui.durationErr.textContent = msg || '';
      },
    };
    map.room_id = where;
    map.duration_minutes = where;
    return map;
  }

  A.registerPage('overrides', {
    mount: mount,
    show: function () {
      load();
      if (!ticker) {
        ticker = setInterval(function () {
          if (ui.globalExpiry && ui.globalExpiryIso)
            ui.globalExpiry.textContent = expiryText(ui.globalExpiryIso);
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

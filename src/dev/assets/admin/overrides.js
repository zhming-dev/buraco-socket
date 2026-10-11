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
 * An override only ever lives on this socket, so the page talks to the socket
 * itself: GET/POST /dev/api/skin-override, POST /dev/api/skin-media (the
 * socket keeps uploaded images and serves them at /media/skins/*). The look
 * lists are SkinLook's mirror of the SDK. wlive-api is only asked for the
 * catalog behind "Start from a catalog skin", and the page works without it.
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
  // Uploads are shrunk to fit this before they leave the browser: the web
  // server in front of a socket often keeps nginx's 1 MB request limit, and
  // the app draws skin images at most 1024 px wide anyway.
  var UPLOAD_TARGET = 900 * 1024;
  var MAX_SOURCE_BYTES = 40 * MB;
  var MAX_EDGE = { wide: 1600, card: 640 };
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
      shape: 'wide',
      imageHint:
        'Covers the felt. Landscape PNG, JPEG or WebP; large images are shrunk before upload.',
      catalogImage: 'table_background',
    },
    {
      id: 'background',
      title: 'Background',
      desc: 'The screen around the table.',
      tokenKey: 'background_style',
      imageKey: 'background_skin',
      presetLabel: 'Colour',
      shape: 'wide',
      imageHint:
        'Fills the screen around the table. Landscape; large images are shrunk before upload.',
      catalogImage: 'background_image',
    },
    {
      id: 'back',
      title: 'Card back',
      desc: 'What every face-down card shows.',
      tokenKey: 'card_back_style',
      imageKey: 'card_skin',
      presetLabel: 'Design',
      shape: 'card',
      imageHint: 'Portrait card art; large images are shrunk before upload.',
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
    page: null, // {global_override, rooms}
    catalog: [],
    catalogError: null,
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
    return L.label(s.tokenKey, value);
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
      return st.slots[s.id].mode !== 'own';
    });
  }

  /** Why Apply is not possible right now, or null. */
  function blocker() {
    if (!st.page) return 'Loading the tables…';
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
    else v.prepared = null;
  }

  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That image could not be read.'));
      };
      img.src = url;
    });
  }

  function hasAlpha(img) {
    var c = document.createElement('canvas');
    c.width = 48;
    c.height = 48;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0, 48, 48);
    var d = g.getImageData(0, 0, 48, 48).data;
    for (var i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  }

  /**
   * The file to upload for slot `s`: as picked when it is small enough and no
   * bigger than the slot can use, else redrawn at most MAX_EDGE px and
   * re-encoded (JPEG; PNG when it has transparency) until it is under
   * UPLOAD_TARGET. Resolves {file, w, h, changed, original}.
   */
  function prepareUpload(file, s) {
    var maxEdge = MAX_EDGE[s.shape] || MAX_EDGE.wide;
    return readImage(file).then(function (img) {
      var w = img.naturalWidth;
      var h0 = img.naturalHeight;
      if (Math.max(w, h0) <= maxEdge && file.size <= UPLOAD_TARGET) {
        return { file: file, w: w, h: h0, changed: false, original: file.size };
      }
      var alpha = file.type !== 'image/jpeg' && hasAlpha(img);
      var type = alpha ? 'image/png' : 'image/jpeg';
      var scale = Math.min(1, maxEdge / Math.max(w, h0));
      var quality = 0.86;
      function attempt(n) {
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h0 * scale));
        var c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        var g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, cw, ch);
        return new Promise(function (resolve) {
          c.toBlob(resolve, type, alpha ? undefined : quality);
        }).then(function (blob) {
          if (!blob) throw new Error('This browser could not re-encode the image.');
          if (blob.size > UPLOAD_TARGET && n < 10) {
            if (!alpha && quality > 0.67) quality -= 0.1;
            else scale *= 0.8;
            return attempt(n + 1);
          }
          var name = file.name.replace(/\.[^.]+$/, '') + (alpha ? '.png' : '.jpg');
          return {
            file: new File([blob], name, { type: type }),
            w: cw,
            h: ch,
            changed: true,
            original: file.size,
          };
        });
      }
      return attempt(0);
    });
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
      var v = st.slots[s.id];
      var img = s.catalogImage ? skin[s.catalogImage] : null;
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
        return A.devApi.post('skin-override', {
          action: 'clear',
          scope: 'room',
          roomId: r.room_id,
        });
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
    ui.slotBox = h('div');
    ui.look.appendChild(ui.slotBox);
    renderLook();
  }

  function fillCatalogSelect() {
    var sel = ui.catalogSelect;
    A.clear(sel);
    sel.appendChild(
      h('option', {
        value: '',
        text: st.catalog.length
          ? 'None'
          : st.catalogError
            ? 'Catalog unavailable'
            : 'No skins in the catalog',
      })
    );
    sel.disabled = !st.catalog.length;
    sel.title = st.catalogError
      ? 'The catalog comes from wlive-api, which did not answer: ' + st.catalogError.message
      : '';
    st.catalog.forEach(function (s) {
      sel.appendChild(
        h('option', { value: String(s.id), text: s.name + (s.is_active ? '' : ' (not on sale)') })
      );
    });
    sel.value = st.catalogId;
  }

  function renderLook() {
    A.clear(ui.slotBox);
    ui.slotEls = {};
    SLOTS.forEach(function (s) {
      ui.slotEls[s.id] = renderSlot(s);
      ui.slotBox.appendChild(ui.slotEls[s.id]);
    });
  }

  function renderSlot(s) {
    var v = st.slots[s.id];
    var modes = [
      { value: 'own', label: "Player's own" },
      { value: 'preset', label: s.presetLabel },
    ];
    if (s.imageKey) modes.push({ value: 'image', label: 'Upload image' });
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
        mode.root
      )
    );
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
    L.options(s.tokenKey, null).forEach(function (o) {
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
      if (file.size > MAX_SOURCE_BYTES) {
        err.textContent = 'Too large to read: ' + fileSize(file.size) + '.';
        return;
      }
      err.textContent = 'Preparing…';
      prepareUpload(file, s).then(
        function (out) {
          setFile(s, out.file);
          v.prepared = out;
          replaceSlot(s);
          syncApply();
        },
        function (e) {
          err.textContent = e.message;
        }
      );
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
              ? (v.prepared ? v.prepared.w + '×' + v.prepared.h + ' · ' : '') +
                fileSize(v.file.size) +
                (v.prepared && v.prepared.changed
                  ? ' (shrunk from ' + fileSize(v.prepared.original) + ')'
                  : '') +
                ' · uploaded when you apply'
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
    var g = p.global_override;
    if (g) {
      var clearBtn = h('button', { class: 'small', text: 'Clear' });
      clearBtn.onclick = function () {
        A.busy(clearBtn, 'Clearing…', function () {
          return A.devApi.post('skin-override', { action: 'clear', scope: 'global' });
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

  /** The socket's room (listRoomsForAdmin) in the shape this page draws. */
  function fromSocket(r) {
    var players = (r.players || []).map(function (p) {
      return {
        seat: p.playerIndex,
        name: p.playerName,
        player_id: p.playerId,
        is_bot: p.isBot,
        connected: p.isConnected,
      };
    });
    var host = (r.players || []).find(function (p) {
      return r.hostPlayerId != null && String(p.playerId) === String(r.hostPlayerId);
    });
    return {
      room_id: r.roomId,
      code: r.roomId,
      name: r.name,
      // Every room on the socket can take an override (a lobby's lasts into its game).
      live: true,
      status: r.status,
      bet: r.bet,
      player_count: r.playerCount,
      max_players: r.maxPlayers,
      spectator_count: r.spectatorCount,
      host: host ? { name: host.playerName } : null,
      players: players,
      skins: r.skins || {},
      skins_source: r.skinsSource,
      skins_expires_at: r.skinsExpiresAt,
      skin_override: r.skinOverride,
    };
  }

  function load() {
    if (st.loading) return;
    st.loading = true;
    ui.refresh.disabled = true;
    Promise.all([
      A.devApi.get('skin-override'),
      // Optional: only "Start from a catalog skin" needs wlive-api.
      A.api.get('skins').catch(function (e) {
        return { error: e };
      }),
    ])
      .then(
        function (out) {
          var d = out[0].data || {};
          st.error = null;
          st.page = { rooms: (d.rooms || []).map(fromSocket), global_override: d.global || null };
          st.catalog = Array.isArray(out[1].data) ? out[1].data : [];
          st.catalogError = out[1].error || null;
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
        // The only table is the only choice: pick it.
        if (st.scope === 'room' && !st.roomId && liveRooms().length === 1)
          st.roomId = liveRooms()[0].room_id;
        fillCatalogSelect();
        renderBanners();
        renderWhere();
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
    var uploads = changedSlots().filter(function (s) {
      return st.slots[s.id].mode === 'image' && st.slots[s.id].file;
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
          // Images first, one by one, onto this socket; each answers with the
          // URL the app loads. A stored image becomes the slot's URL, so a
          // second apply (another table) does not upload it again.
          var chain = Promise.resolve();
          uploads.forEach(function (s) {
            chain = chain.then(function () {
              return A.devApi.file('skin-media', st.slots[s.id].file).then(
                function (r) {
                  setFile(s, null);
                  st.slots[s.id].url = r.data.url;
                },
                function (err) {
                  // No answer at all, or nginx's 413: the web server in front
                  // of this socket refused the size before the socket saw it.
                  if (err && (err.status === 0 || err.status === 413)) {
                    err.message =
                      'the upload was cut off before this socket answered (' +
                      fileSize(st.slots[s.id].file.size) +
                      '). The web server in front of it limits the request size; allow at least 10 MB there (nginx client_max_body_size 10m).';
                  }
                  // Point the message at the slot whose image was refused.
                  if (err && err.status !== 401) {
                    err.fields = {};
                    err.fields[s.imageKey] = [s.title + ' image: ' + err.message];
                  }
                  throw err;
                }
              );
            });
          });
          return chain.then(function () {
            var skins = {};
            changedSlots().forEach(function (s) {
              var v = st.slots[s.id];
              if (v.mode === 'preset') skins[s.tokenKey] = v.token;
              else skins[s.imageKey] = v.url;
            });
            return A.devApi.post('skin-override', {
              action: 'set',
              scope: st.scope,
              roomId: global ? undefined : room.room_id,
              durationMinutes: durationMinutes,
              skins: skins,
            });
          });
        }).then(function (res) {
          var d = res.data || {};
          if (uploads.length) renderLook();
          A.toast(
            'Applied. ' +
              A.fmtInt(n) +
              (n === 1 ? ' person is' : ' people are') +
              ' seeing it now' +
              (d.expiresAt ? ' (ends ' + A.relTime(d.expiresAt) + ')' : '') +
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

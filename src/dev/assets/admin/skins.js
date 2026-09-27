/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Skins — the catalog players buy and equip, and what an override can push
 * onto a table. A skin is uploaded artwork (table image, card back — "admin
 * bisa upload meja dan punggung kartu") and/or the engine's built-in looks by
 * token. The preview is the SDK palette, so a skin is judged before it ships.
 *
 * wlive-api: GET skins, POST skins (multipart), POST skins/{id} (multipart
 * update), DELETE skins/{id} (deactivates instead when players own it),
 * GET skin-tokens.
 */
(function () {
  'use strict';
  var A = window.BuracoAdmin;
  var L = window.SkinLook;
  if (!A || !L) return;
  var h = A.h;

  var RARITIES = ['common', 'rare', 'epic', 'legendary'];
  var MB = 1024 * 1024;
  var ARTWORK = [
    {
      key: 'table_background',
      label: 'Table image',
      max: 8 * MB,
      wide: true,
      hint: 'PNG, JPEG or WebP, up to 8 MB. Shown on the felt instead of the theme colour.',
    },
    {
      key: 'card_back',
      label: 'Card back image',
      max: 4 * MB,
      hint: 'Up to 4 MB. Replaces the generated back.',
    },
    {
      key: 'preview_image',
      label: 'Store preview image',
      max: 4 * MB,
      hint: 'Up to 4 MB. The thumbnail players see in the shop.',
    },
  ];

  var st = { rows: null, error: null, tokens: null, q: '', showInactive: true };
  var ui = {};

  function mount(root) {
    ui.add = h('button', {
      class: 'primary',
      text: 'New skin',
      on: {
        click: function () {
          openEditor(null);
        },
      },
    });
    ui.refresh = h('button', { class: 'small', text: 'Refresh', on: { click: load } });
    root.appendChild(
      A.pageHead(
        'Skins',
        "What players buy and equip, and what an override can push onto a table: uploaded artwork and/or the engine's built-in looks.",
        [ui.refresh, ui.add]
      )
    );
    ui.search = h('input', {
      type: 'text',
      placeholder: 'Search by name or slug',
      autocomplete: 'off',
      spellcheck: false,
    });
    ui.search.oninput = function () {
      st.q = ui.search.value.trim().toLowerCase();
      render();
    };
    ui.inactive = h('input', { type: 'checkbox', checked: true });
    ui.inactive.onchange = function () {
      st.showInactive = ui.inactive.checked;
      render();
    };
    ui.count = h('span', { class: 'hint' });
    root.appendChild(
      h(
        'div',
        { class: 'row' },
        ui.search,
        h('label', { class: 'chk' }, ui.inactive, 'show inactive'),
        ui.count
      )
    );
    ui.grid = h('div');
    root.appendChild(ui.grid);
  }

  function load() {
    ui.refresh.disabled = true;
    if (!st.rows) render();
    Promise.all([
      A.api.get('skins'),
      st.tokens
        ? Promise.resolve({ data: st.tokens })
        : A.api.get('skin-tokens').catch(function () {
            return { data: null };
          }),
    ])
      .then(
        function (out) {
          st.error = null;
          st.rows = Array.isArray(out[0].data) ? out[0].data : [];
          if (out[1].data) st.tokens = out[1].data;
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

  function priceText(row) {
    return row.price ? '🪙 ' + A.fmtInt(row.price) : 'free';
  }

  function render() {
    var box = A.clear(ui.grid);
    if (st.error) {
      box.appendChild(A.errorBox(st.error, load));
      return;
    }
    if (!st.rows) {
      box.appendChild(
        h(
          'div',
          { class: 'skin-grid' },
          [0, 1, 2].map(function () {
            return A.loadingBox(240);
          })
        )
      );
      return;
    }
    if (!st.rows.length) {
      box.appendChild(
        A.stateBox({
          icon: '🎨',
          title: 'No skins yet',
          text: "Create one: upload a table image and a card back, or pick from the engine's built-in looks.",
          action: h('button', {
            class: 'primary small',
            text: 'New skin',
            on: {
              click: function () {
                openEditor(null);
              },
            },
          }),
        })
      );
      return;
    }
    var rows = st.rows.filter(function (r) {
      if (!st.showInactive && !r.is_active) return false;
      if (!st.q) return true;
      return (String(r.name || '') + ' ' + String(r.slug || '')).toLowerCase().indexOf(st.q) !== -1;
    });
    ui.count.textContent = rows.length + ' of ' + st.rows.length;
    if (!rows.length) {
      box.appendChild(A.stateBox({ title: 'Nothing matches', text: 'Try another name.' }));
      return;
    }
    box.appendChild(h('div', { class: 'skin-grid' }, rows.map(card)));
  }

  function card(row) {
    var del = h('button', {
      class: 'small ghost',
      text: 'Delete',
      disabled: !!row.is_default,
      title: row.is_default ? 'A default skin cannot be deleted; deactivate it instead' : '',
    });
    del.onclick = function () {
      remove(row, del);
    };
    return h(
      'div',
      { class: 'skin-card' + (row.is_active ? '' : ' inactive') },
      L.render(row.wire || {}, { small: true, ownLabel: 'not set' }),
      h(
        'div',
        { class: 'row1' },
        h('div', { class: 'nm', text: row.name, title: row.name }),
        row.is_default ? h('span', { class: 'badge info', text: 'default' }) : null,
        row.is_active ? null : h('span', { class: 'badge neutral', text: 'inactive' }),
        h('span', {
          class:
            'badge ' +
            (row.rarity === 'legendary' ? 'gold' : row.rarity === 'epic' ? 'info' : 'neutral'),
          text: row.rarity || 'common',
        })
      ),
      h(
        'div',
        { class: 'meta' },
        h('span', { class: 'tag', text: row.slug }),
        ' · ',
        priceText(row),
        row.owners_count ? ' · ' + A.fmtInt(row.owners_count) + ' own it' : '',
        ' · order ' + (row.sort_order || 0)
      ),
      row.description ? h('div', { class: 'meta', text: row.description }) : null,
      h(
        'div',
        { class: 'btns' },
        h('button', {
          class: 'small',
          text: 'Edit',
          on: {
            click: function () {
              openEditor(row);
            },
          },
        }),
        del
      )
    );
  }

  function remove(row, button) {
    A.confirmDialog({
      title: 'Delete “' + row.name + '”?',
      danger: true,
      confirmText: 'Delete',
      body: [
        h('div', { text: 'The skin leaves the catalog.' }),
        h(
          'ul',
          { class: 'confirm-list' },
          h(
            'li',
            null,
            row.owners_count
              ? h('b', { text: A.fmtInt(row.owners_count) + ' players own it' })
              : 'Nobody owns it',
            row.owners_count
              ? ' — it is only taken off the shelf (deactivated); their purchase is kept.'
              : ' — it is deleted for good.'
          ),
          h('li', null, 'Overrides already in force keep their look until they end.')
        ),
      ],
    })
      .then(function (ok) {
        if (!ok) return;
        return A.busy(button, '…', function () {
          return A.api.del('skins/' + encodeURIComponent(row.id));
        }).then(function (res) {
          A.toast(res.message || 'Skin deleted');
          load();
        });
      })
      .catch(function (e) {
        A.toastError('Delete failed', e);
      });
  }

  // ---- editor -------------------------------------------------------------------------

  function openEditor(row) {
    var editing = !!row;
    var draft = {
      table_theme: row ? row.table_theme || '' : '',
      card_back_style: row ? row.card_back_style || '' : '',
      card_face_style: row ? row.card_face_style || '' : '',
    };
    var clearFlags = {};
    var pickers = {};
    var previewBox = h('div');

    function currentImage(key) {
      if (pickers[key] && pickers[key].url()) return pickers[key].url();
      if (clearFlags[key] && clearFlags[key].checked) return null;
      return row ? row[key] : null;
    }
    function paintPreview() {
      var skins = {};
      if (draft.table_theme) skins.table_theme = draft.table_theme;
      if (draft.card_back_style) skins.card_back_style = draft.card_back_style;
      if (draft.card_face_style) skins.card_face_style = draft.card_face_style;
      var t = currentImage('table_background');
      var b = currentImage('card_back');
      if (t) skins.table_skin = t;
      if (b) skins.card_skin = b;
      A.clear(previewBox).appendChild(L.render(skins, { ownLabel: 'not set' }));
    }

    var name = h('input', { type: 'text', value: row ? row.name : '', maxLength: 80 });
    var slug = h('input', {
      type: 'text',
      value: row ? row.slug || '' : '',
      maxLength: 48,
      placeholder: editing ? '' : 'derived from the name',
      spellcheck: false,
    });
    var description = h('input', {
      type: 'text',
      value: row ? row.description || '' : '',
      maxLength: 255,
    });
    var price = A.numberInput(row ? row.price : 0, { min: 0 });
    var rarity = A.select(
      RARITIES.map(function (r) {
        return { value: r, label: r };
      }),
      row ? row.rarity || 'common' : 'common'
    );
    var sort = A.numberInput(row ? row.sort_order || 0 : 0);
    var active = h('input', { type: 'checkbox', checked: row ? !!row.is_active : true });

    var f = {
      name: A.field('Name', name, { required: true }),
      slug: A.field('Slug', slug, {
        hint:
          'Lowercase letters, digits and dashes. ' +
          (editing
            ? 'Changing it does not move uploaded files.'
            : 'Leave empty to derive it from the name.'),
      }),
      description: A.field('Description', description, { wide: true }),
      price: A.field('Price (coins)', price, { hint: '0 = free for everyone.' }),
      rarity: A.field('Rarity', rarity),
      sort_order: A.field('Order', sort, { hint: 'Lower comes first in the shop.' }),
      is_active: A.field('On sale', h('label', { class: 'switch' }, active, 'Active')),
    };

    var tokenFields = {};
    [
      ['table_theme', 'Table theme'],
      ['card_back_style', 'Card back'],
      ['card_face_style', 'Card face'],
    ].forEach(function (s) {
      var sel = A.select(L.options(s[0], st.tokens), draft[s[0]], { placeholder: 'None' });
      sel.onchange = function () {
        draft[s[0]] = sel.value;
        paintPreview();
      };
      tokenFields[s[0]] = A.field(s[1], sel);
    });

    var artFields = {};
    var artBlocks = ARTWORK.map(function (a) {
      pickers[a.key] = A.filePicker({
        accept: 'image/png,image/jpeg,image/webp',
        maxBytes: a.max,
        current: row ? row[a.key] : null,
        wide: a.wide,
        onChange: paintPreview,
      });
      var extra = null;
      if (row && row[a.key]) {
        clearFlags[a.key] = h('input', { type: 'checkbox' });
        clearFlags[a.key].onchange = paintPreview;
        extra = h('label', { class: 'chk' }, clearFlags[a.key], 'remove the current image');
      }
      artFields[a.key] = A.field(a.label, h('div', null, pickers[a.key].root, extra), {
        hint: a.hint,
      });
      return artFields[a.key].root;
    });

    var errBox = h('div', { class: 'form-error' });
    var save = h('button', { class: 'primary', text: editing ? 'Save changes' : 'Create skin' });
    var body = h(
      'div',
      { class: 'skin-editor' },
      h(
        'div',
        null,
        h('div', {
          class: 'sec-title',
          style: { marginBottom: '8px' },
          text: 'What players will see',
        }),
        previewBox,
        h('div', {
          class: 'hint',
          style: { marginTop: '8px' },
          text: 'Generated backs are drawn by the app; the pattern here is an approximation in the same colours. Uploaded images are shown exactly as they ship.',
        })
      ),
      h(
        'div',
        { class: 'form' },
        h(
          'div',
          { class: 'form-grid' },
          f.name.root,
          f.slug.root,
          f.description.root,
          f.price.root,
          f.rarity.root,
          f.sort_order.root,
          f.is_active.root
        ),
        h('div', { class: 'sec-title', text: 'Built-in looks' }),
        h(
          'div',
          { class: 'form-grid' },
          tokenFields.table_theme.root,
          tokenFields.card_back_style.root,
          h('div', { class: 'wide' }, tokenFields.card_face_style.root)
        ),
        h('div', { class: 'sec-title', text: 'Artwork' }),
        artBlocks,
        errBox
      )
    );

    var m = A.modal({
      title: editing ? 'Edit “' + row.name + '”' : 'New skin',
      sub: editing
        ? '#' +
          row.id +
          (row.owners_count ? ' · ' + A.fmtInt(row.owners_count) + ' players own it' : '')
        : null,
      wide: true,
      body: body,
      foot: [
        h('button', {
          class: 'ghost',
          text: 'Cancel',
          on: {
            click: function () {
              m.close();
            },
          },
        }),
        save,
      ],
    });
    paintPreview();
    setTimeout(function () {
      name.focus();
    }, 0);

    var fieldMap = {
      name: f.name,
      slug: f.slug,
      description: f.description,
      price: f.price,
      rarity: f.rarity,
      sort_order: f.sort_order,
      is_active: f.is_active,
      table_theme: tokenFields.table_theme,
      card_back_style: tokenFields.card_back_style,
      card_face_style: tokenFields.card_face_style,
      table_background: artFields.table_background,
      card_back: artFields.card_back,
      preview_image: artFields.preview_image,
    };

    save.onclick = function () {
      A.showErrors(null, fieldMap, errBox);
      var problems = {};
      if (!name.value.trim()) problems.name = ['A name is required.'];
      if (slug.value.trim() && !/^[a-z0-9][a-z0-9-]*$/.test(slug.value.trim()))
        problems.slug = [
          'Lowercase letters, digits and dashes only, starting with a letter or digit.',
        ];
      if (price.value !== '' && (!/^\d+$/.test(price.value) || Number(price.value) < 0))
        problems.price = ['A whole number of coins, 0 or more.'];
      if (sort.value !== '' && !/^-?\d+$/.test(sort.value))
        problems.sort_order = ['A whole number.'];
      if (Object.keys(problems).length) {
        A.showErrors(
          { status: 422, fields: problems, message: 'Check the highlighted fields.' },
          fieldMap,
          errBox
        );
        return;
      }
      var fd = new FormData();
      fd.append('name', name.value.trim());
      // An empty slug on an UPDATE would null the column: only send one that is set.
      if (slug.value.trim()) fd.append('slug', slug.value.trim());
      fd.append('description', description.value.trim());
      fd.append('price', String(price.value === '' ? 0 : Number(price.value)));
      fd.append('rarity', rarity.value || 'common');
      fd.append('sort_order', String(sort.value === '' ? 0 : Number(sort.value)));
      fd.append('is_active', active.checked ? '1' : '0');
      // Empty = none (wlive-api turns '' into null, which clears the slot).
      fd.append('table_theme', draft.table_theme || '');
      fd.append('card_back_style', draft.card_back_style || '');
      fd.append('card_face_style', draft.card_face_style || '');
      ARTWORK.forEach(function (a) {
        var file = pickers[a.key].file();
        if (file) fd.append(a.key, file, file.name);
        else if (clearFlags[a.key] && clearFlags[a.key].checked) fd.append('clear_' + a.key, '1');
      });
      A.busy(save, editing ? 'Saving…' : 'Creating…', function () {
        return A.api.upload(editing ? 'skins/' + encodeURIComponent(row.id) : 'skins', fd);
      })
        .then(function (res) {
          A.toast(res.message || (editing ? 'Skin updated' : 'Skin created'));
          m.close();
          load();
        })
        .catch(function (err) {
          A.showErrors(err, fieldMap, errBox);
        });
    };
  }

  A.registerPage('skins', { mount: mount, show: load });
})();

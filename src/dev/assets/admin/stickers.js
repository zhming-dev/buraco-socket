/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Stickers — emoji and sticker packs for the in-game chat's Stickers tab
 * ("artwork nanti dimasukin ke buraco admin"): a pack holds emoji glyphs
 * (typed) and stickers (uploaded images); the app pulls the catalog straight
 * into the engine's picker.
 *
 * wlive-api: GET/POST sticker-packs, POST/DELETE sticker-packs/{id},
 * POST sticker-packs/{id}/assets, POST/DELETE sticker-packs/{id}/assets/{assetId}
 * (writes are multipart).
 */
(function () {
  'use strict';
  var A = window.BuracoAdmin;
  if (!A) return;
  var h = A.h;
  var MB = 1024 * 1024;

  var st = { packs: null, error: null, selectedId: null };
  var ui = {};

  function selected() {
    return (
      (st.packs || []).find(function (p) {
        return p.id === st.selectedId;
      }) || null
    );
  }

  function mount(root) {
    ui.add = h('button', {
      class: 'primary',
      text: 'New pack',
      on: {
        click: function () {
          openPack(null);
        },
      },
    });
    ui.refresh = h('button', { class: 'small', text: 'Refresh', on: { click: load } });
    root.appendChild(
      A.pageHead(
        'Stickers',
        "Emoji and stickers for the in-game chat's Stickers tab. A free pack is everyone's; a paid one is unlocked with coins or an in-app purchase.",
        [ui.refresh, ui.add]
      )
    );
    ui.body = h('div');
    root.appendChild(ui.body);
  }

  function load() {
    ui.refresh.disabled = true;
    if (!st.packs) render();
    A.api
      .get('sticker-packs')
      .then(
        function (res) {
          st.error = null;
          st.packs = Array.isArray(res.data) ? res.data : [];
          if (!selected()) st.selectedId = st.packs.length ? st.packs[0].id : null;
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

  function priceText(p) {
    if (p.is_free || p.price_coins == null) return 'free';
    return '🪙 ' + A.fmtInt(p.price_coins);
  }

  function render() {
    var box = A.clear(ui.body);
    if (st.error) {
      box.appendChild(A.errorBox(st.error, load));
      return;
    }
    if (!st.packs) {
      box.appendChild(A.loadingBox(260));
      return;
    }
    if (!st.packs.length) {
      box.appendChild(
        A.stateBox({
          icon: '😊',
          title: 'No packs yet',
          text: 'Create a pack, then add emoji glyphs or upload sticker images to it.',
          action: h('button', {
            class: 'primary small',
            text: 'New pack',
            on: {
              click: function () {
                openPack(null);
              },
            },
          }),
        })
      );
      return;
    }
    var list = h('div', { class: 'pack-list' });
    st.packs.forEach(function (p) {
      var thumb = h('span', { class: 'pthumb' });
      var src = A.safeUrl(p.thumbnail_url);
      if (src) thumb.style.backgroundImage = A.cssUrl(src);
      else {
        var first = (p.assets || []).find(function (a) {
          return a.type === 'emoji' && a.glyph;
        });
        thumb.textContent = first ? first.glyph : '😊';
      }
      list.appendChild(
        h(
          'button',
          {
            class: 'pack-item' + (p.id === st.selectedId ? ' selected' : ''),
            on: {
              click: function () {
                st.selectedId = p.id;
                render();
              },
            },
          },
          thumb,
          h(
            'span',
            { class: 'pcol' },
            h('div', { class: 'pn', text: p.name }),
            h('div', {
              class: 'pm',
              text: [
                priceText(p),
                (p.assets || []).length + ' items',
                p.is_active ? null : 'inactive',
              ]
                .filter(Boolean)
                .join(' · '),
            })
          )
        )
      );
    });
    box.appendChild(
      h(
        'div',
        { class: 'split list-left' },
        h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'card-h' },
            h('b', { text: 'Packs' }),
            h('span', { text: '· ' + st.packs.length })
          ),
          list
        ),
        h('div', null, renderPack(selected()))
      )
    );
  }

  function renderPack(p) {
    if (!p) return h('div', { class: 'card' }, A.stateBox({ text: 'Pick a pack' }));
    var delPack = h('button', { class: 'small ghost', text: 'Delete pack' });
    delPack.onclick = function () {
      removePack(p, delPack);
    };
    var head = h(
      'div',
      { class: 'card-h' },
      h('b', { text: p.name }),
      p.is_active ? null : h('span', { class: 'badge neutral', text: 'inactive' }),
      h('span', {
        text: p.is_free
          ? '· free — every player has it'
          : '· ' + A.fmtInt(p.price_coins || 0) + ' coins to unlock',
      }),
      p.iap_sku ? h('span', { class: 'tag', text: 'IAP ' + p.iap_sku }) : null,
      p.owners_count ? h('span', { text: '· ' + A.fmtInt(p.owners_count) + ' own it' }) : null,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'small',
        text: '＋ Emoji',
        on: {
          click: function () {
            openAsset(p, null, 'emoji');
          },
        },
      }),
      h('button', {
        class: 'small',
        text: '＋ Sticker',
        on: {
          click: function () {
            openAsset(p, null, 'sticker');
          },
        },
      }),
      h('button', {
        class: 'small ghost',
        text: 'Edit pack',
        on: {
          click: function () {
            openPack(p);
          },
        },
      }),
      delPack
    );
    var assets = (p.assets || []).slice().sort(function (a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
    });
    var body;
    if (!assets.length) {
      body = A.stateBox({
        icon: '🖼',
        title: 'This pack is empty',
        text: 'Add an emoji glyph or upload a sticker image. Players see the tiles in this order.',
      });
    } else {
      body = h(
        'div',
        { class: 'tiles' },
        assets.map(function (a) {
          return tile(p, a);
        })
      );
    }
    return h(
      'div',
      { class: 'card' },
      head,
      h('div', {
        class: 'hint',
        style: { marginBottom: '10px' },
        text: 'Rendered the way the picker shows them. Hover a tile to edit or remove it.',
      }),
      body
    );
  }

  function tile(pack, a) {
    var content;
    var src = A.safeUrl(a.image_url);
    if (a.type === 'emoji') content = h('span', { class: 'glyph', text: a.glyph || '?' });
    else if (src) content = h('img', { src: src, alt: '', loading: 'lazy' });
    else content = h('span', { class: 'muted', text: 'no image' });
    var del = h('button', { class: 'small danger', text: '✕', title: 'Remove' });
    del.onclick = function () {
      A.confirmDialog({
        title: 'Remove this ' + a.type + '?',
        danger: true,
        confirmText: 'Remove',
        body: 'It disappears from the "' + pack.name + '" picker for everyone.',
      })
        .then(function (ok) {
          if (!ok) return;
          return A.api
            .del(
              'sticker-packs/' + encodeURIComponent(pack.id) + '/assets/' + encodeURIComponent(a.id)
            )
            .then(function () {
              A.toast('Removed');
              load();
            });
        })
        .catch(function (e) {
          A.toastError('Remove failed', e);
        });
    };
    return h(
      'div',
      { class: 'tile', title: a.type + ' · order ' + (a.sort_order || 0) },
      h('span', { class: 'kind', text: a.type === 'emoji' ? '' : 'sticker' }),
      content,
      h(
        'div',
        { class: 'tacts' },
        h('button', {
          class: 'small',
          text: 'Edit',
          on: {
            click: function () {
              openAsset(pack, a, a.type);
            },
          },
        }),
        del
      )
    );
  }

  function removePack(p, button) {
    A.confirmDialog({
      title: 'Delete “' + p.name + '”?',
      danger: true,
      confirmText: 'Delete pack',
      body: [
        h(
          'ul',
          { class: 'confirm-list' },
          h(
            'li',
            null,
            p.owners_count
              ? h('b', { text: A.fmtInt(p.owners_count) + ' players own it' })
              : 'Nobody owns it',
            p.owners_count
              ? ' — it is only deactivated, so their picker keeps the stickers they paid for.'
              : ' — the pack and its ' + (p.assets || []).length + ' items are deleted for good.'
          )
        ),
      ],
    })
      .then(function (ok) {
        if (!ok) return;
        return A.busy(button, '…', function () {
          return A.api.del('sticker-packs/' + encodeURIComponent(p.id));
        }).then(function (res) {
          A.toast(res.message || 'Pack deleted');
          if (!p.owners_count) st.selectedId = null;
          load();
        });
      })
      .catch(function (e) {
        A.toastError('Delete failed', e);
      });
  }

  // ---- pack editor ---------------------------------------------------------------------

  function openPack(p) {
    var editing = !!p;
    var name = h('input', { type: 'text', value: p ? p.name : '', maxLength: 80 });
    var price = A.numberInput(p && p.price_coins != null ? p.price_coins : '', {
      min: 0,
      placeholder: 'free',
    });
    var sku = h('input', {
      type: 'text',
      value: p ? p.iap_sku || '' : '',
      maxLength: 191,
      spellcheck: false,
      placeholder: 'optional',
    });
    var sort = A.numberInput(p ? p.sort_order || 0 : 0);
    var active = h('input', { type: 'checkbox', checked: p ? !!p.is_active : true });
    var thumb = A.filePicker({
      accept: 'image/png,image/jpeg,image/webp',
      maxBytes: 4 * MB,
      current: p ? p.thumbnail_url : null,
    });
    var f = {
      name: A.field('Name', name, { required: true }),
      price_coins: A.field('Price (coins)', price, {
        hint: 'Leave empty for a free pack every player owns.',
      }),
      iap_sku: A.field('In-app purchase SKU', sku, {
        hint: 'The store product id, when the pack is also sold for money.',
      }),
      sort_order: A.field('Order', sort),
      is_active: A.field('On sale', h('label', { class: 'switch' }, active, 'Active')),
      thumbnail: A.field('Thumbnail', thumb.root, { hint: 'PNG, JPEG or WebP, up to 4 MB.' }),
    };
    var errBox = h('div', { class: 'form-error' });
    var save = h('button', { class: 'primary', text: editing ? 'Save pack' : 'Create pack' });
    var m = A.modal({
      title: editing ? 'Edit “' + p.name + '”' : 'New sticker pack',
      body: h(
        'div',
        { class: 'form' },
        f.name.root,
        h(
          'div',
          { class: 'form-grid' },
          f.price_coins.root,
          f.iap_sku.root,
          f.sort_order.root,
          f.is_active.root
        ),
        f.thumbnail.root,
        errBox
      ),
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
    setTimeout(function () {
      name.focus();
    }, 0);
    save.onclick = function () {
      var problems = {};
      if (!name.value.trim()) problems.name = ['A name is required.'];
      if (price.value !== '' && !/^\d+$/.test(price.value))
        problems.price_coins = ['A whole number of coins, or empty for free.'];
      if (Object.keys(problems).length) {
        A.showErrors({ status: 422, fields: problems }, f, errBox);
        return;
      }
      A.showErrors(null, f, errBox);
      var fd = new FormData();
      fd.append('name', name.value.trim());
      fd.append('price_coins', price.value === '' ? '' : String(Number(price.value))); // '' → null → free
      fd.append('iap_sku', sku.value.trim());
      fd.append('sort_order', String(sort.value === '' ? 0 : Number(sort.value)));
      fd.append('is_active', active.checked ? '1' : '0');
      if (thumb.file()) fd.append('thumbnail', thumb.file(), thumb.file().name);
      A.busy(save, 'Saving…', function () {
        return A.api.upload(
          editing ? 'sticker-packs/' + encodeURIComponent(p.id) : 'sticker-packs',
          fd
        );
      })
        .then(function (res) {
          A.toast(res.message || (editing ? 'Pack updated' : 'Pack created'));
          if (!editing && res.data && res.data.id) st.selectedId = res.data.id;
          m.close();
          load();
        })
        .catch(function (err) {
          A.showErrors(err, f, errBox);
        });
    };
  }

  // ---- asset editor --------------------------------------------------------------------

  function openAsset(pack, a, type) {
    var editing = !!a;
    var isEmoji = type === 'emoji';
    var preview = h('div', { class: 'asset-preview' });
    var glyph = h('input', {
      type: 'text',
      value: a ? a.glyph || '' : '',
      maxLength: 64,
      placeholder: '🎉',
    });
    glyph.style.fontSize = '20px';
    var image = A.filePicker({
      accept: 'image/png,image/webp,image/gif,image/jpeg',
      maxBytes: 4 * MB,
      current: a ? a.image_url : null,
      onChange: paint,
    });
    var nextOrder =
      ((pack.assets || []).reduce(function (m0, x) {
        return Math.max(m0, x.sort_order || 0);
      }, 0) || 0) + 10;
    var sort = A.numberInput(a ? a.sort_order || 0 : nextOrder);
    function paint() {
      A.clear(preview);
      if (isEmoji)
        preview.appendChild(h('span', { class: 'glyph', text: glyph.value.trim() || '?' }));
      else {
        var src = image.url() || A.safeUrl(a && a.image_url);
        preview.appendChild(
          src ? h('img', { src: src, alt: '' }) : h('span', { class: 'muted', text: '🖼' })
        );
      }
    }
    glyph.oninput = paint;
    var f = {
      glyph: A.field('Emoji', glyph, {
        required: true,
        hint: "Type or paste the emoji (it is shown with the phone's own emoji font).",
      }),
      image: A.field('Image', image.root, {
        required: !editing,
        hint: 'PNG, WebP, GIF or JPEG, up to 4 MB. Square works best; transparent PNG/WebP recommended.',
      }),
      sort_order: A.field('Order', sort, { hint: 'Lower comes first in the picker.' }),
    };
    var errBox = h('div', { class: 'form-error' });
    var save = h('button', { class: 'primary', text: editing ? 'Save' : 'Add' });
    var m = A.modal({
      title: (editing ? 'Edit ' : 'Add ') + (isEmoji ? 'emoji' : 'sticker'),
      sub: pack.name,
      narrow: true,
      body: h(
        'div',
        { class: 'form' },
        h(
          'div',
          { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
          preview,
          h('div', { class: 'hint', text: 'This is the tile players tap in the picker.' })
        ),
        isEmoji ? f.glyph.root : f.image.root,
        f.sort_order.root,
        errBox
      ),
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
    paint();
    if (isEmoji)
      setTimeout(function () {
        glyph.focus();
      }, 0);
    save.onclick = function () {
      A.showErrors(null, f, errBox);
      if (isEmoji && !glyph.value.trim()) {
        A.showErrors({ status: 422, fields: { glyph: ['An emoji needs a glyph.'] } }, f, errBox);
        return;
      }
      if (!isEmoji && !editing && !image.file()) {
        A.showErrors({ status: 422, fields: { image: ['A sticker needs an image.'] } }, f, errBox);
        return;
      }
      var fd = new FormData();
      fd.append('type', type);
      if (isEmoji) fd.append('glyph', glyph.value.trim());
      fd.append('sort_order', String(sort.value === '' ? 0 : Number(sort.value)));
      if (!isEmoji && image.file()) fd.append('image', image.file(), image.file().name);
      var path =
        'sticker-packs/' +
        encodeURIComponent(pack.id) +
        '/assets' +
        (editing ? '/' + encodeURIComponent(a.id) : '');
      A.busy(save, 'Saving…', function () {
        return A.api.upload(path, fd);
      })
        .then(function (res) {
          A.toast(res.message || 'Saved');
          m.close();
          load();
        })
        .catch(function (err) {
          A.showErrors(err, f, errBox);
        });
    };
  }

  A.registerPage('stickers', { mount: mount, show: load });
})();

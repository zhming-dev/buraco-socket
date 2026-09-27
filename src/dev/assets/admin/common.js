/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Buraco admin pages — shared plumbing (window.BuracoAdmin).
 *
 * The pages (overrides.js, skins.js, stickers.js, review.js, settings.js) call
 * wlive-api's /api/buraco/admin/* THROUGH this socket's /dev/api/admin/* proxy
 * (src/dev/adminProxy.js): the browser sends the dev console secret and the
 * operator's name; the socket adds the admin secret. Nothing here ever sees
 * the admin secret.
 *
 * wlive-api answers in more than one envelope — `{success, data, message}` on
 * success, and on failure the Buraco `{success:false, error:{code, message,
 * details}}`, Laravel's `{message, errors}` or a bare `{message}` — so every
 * call goes through request(), which turns all of them into one AdminError
 * {status, code, message, fields}.
 *
 * Everything user-supplied is rendered through textContent (h()), never HTML.
 */
(function () {
  'use strict';

  var DC = window.DevConsole;
  if (!DC) {
    if (window.console)
      console.error('Buraco admin: the dev console (window.DevConsole) is missing');
    return;
  }

  // ---- DOM ------------------------------------------------------------------------

  function append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) {
        append(parent, c);
      });
      return;
    }
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }

  /**
   * h('div', {class, text, title, style: {}, data: {}, on: {click}, attrs: {}, ...props}, ...children)
   * Children are nodes, strings (text) or arrays of those; null/false are skipped.
   */
  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null) return;
        if (v === false && (k === 'class' || k === 'text' || k === 'title')) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'style' && typeof v === 'object')
          Object.keys(v).forEach(function (s) {
            node.style[s] = v[s];
          });
        else if (k === 'data')
          Object.keys(v).forEach(function (d) {
            node.dataset[d] = v[d];
          });
        else if (k === 'on')
          Object.keys(v).forEach(function (ev) {
            node.addEventListener(ev, v[ev]);
          });
        else if (k === 'attrs')
          Object.keys(v).forEach(function (a) {
            node.setAttribute(a, v[a]);
          });
        else node[k] = v;
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /** A URL that is safe to load as an image: http(s), blob: or data:image/. */
  function safeUrl(u) {
    if (typeof u !== 'string' || !u.trim()) return null;
    var s = u.trim();
    if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return s;
    try {
      var url = new URL(s, location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  /** CSS url() for a background, quoted and escaped. */
  function cssUrl(u) {
    var s = safeUrl(u);
    if (!s) return 'none';
    return (
      'url("' +
      s.replace(/["\\\n\r\f]/g, function (c) {
        return encodeURIComponent(c);
      }) +
      '")'
    );
  }

  // ---- formatting -------------------------------------------------------------------

  function fmtInt(n) {
    var v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
  }

  function signed(n) {
    var v = Number(n) || 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + fmtInt(Math.abs(v));
  }

  function fmtDate(iso, withSeconds) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    var opts = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    };
    if (withSeconds) opts.second = '2-digit';
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleString([], opts);
  }

  function relTime(iso) {
    var t = new Date(iso).getTime();
    if (!iso || isNaN(t)) return '';
    var diff = t - Date.now();
    var abs = Math.abs(diff);
    var mins = Math.round(abs / 60000);
    var text;
    if (abs < 45000) text = 'moments';
    else if (mins < 60) text = mins + ' min';
    else if (mins < 60 * 36) text = Math.round(mins / 60) + ' h';
    else text = Math.round(mins / 1440) + ' d';
    if (text === 'moments') return diff >= 0 ? 'in moments' : 'just now';
    return diff >= 0 ? 'in ' + text : text + ' ago';
  }

  function initials(name) {
    var parts = String(name || '?')
      .trim()
      .split(/\s+/);
    return ((parts[0] || '?').charAt(0) + (parts[1] ? parts[1].charAt(0) : '')).toUpperCase();
  }

  // ---- the operator's name (x-admin-actor) -------------------------------------------
  //
  // Recorded by wlive-api as who made a change (the override's setBy, the
  // flag's reviewed_by). A header can only carry printable ASCII, so the name is
  // trimmed to that here and again on the socket.

  var ACTOR_KEY = 'buraco_dev_actor';

  function sanitizeActor(value) {
    if (typeof value !== 'string') return '';
    return value
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .replace(/[^A-Za-z0-9 ._@+-]/g, '')
      .replace(/ {2,}/g, ' ')
      .trim()
      .slice(0, 48)
      .trim();
  }

  function getActor() {
    try {
      return sanitizeActor(localStorage.getItem(ACTOR_KEY) || '');
    } catch (e) {
      return '';
    }
  }

  function setActor(name) {
    try {
      if (name) localStorage.setItem(ACTOR_KEY, name);
      else localStorage.removeItem(ACTOR_KEY);
    } catch (e) {
      /* private mode: kept for this page only */
    }
    memoActor = name || '';
    renderActorChip();
  }

  var memoActor = null;
  function actor() {
    if (memoActor === null) memoActor = getActor();
    return memoActor;
  }

  function renderActorChip() {
    var slot = document.getElementById('admin-actor-slot');
    if (!slot) return;
    clear(slot);
    var name = actor();
    if (name) {
      slot.appendChild(
        h(
          'span',
          { class: 'actor-chip', title: 'Recorded on wlive-api as who made each change' },
          'Operator ',
          h('b', { text: name }),
          h('button', {
            class: 'small ghost',
            text: 'change',
            on: {
              click: function () {
                askActor();
              },
            },
          })
        )
      );
    } else {
      slot.appendChild(
        h('button', {
          class: 'small',
          text: 'Set your name',
          title: 'Needed before you change anything on the admin pages',
          on: {
            click: function () {
              askActor();
            },
          },
        })
      );
    }
  }

  /** Opens the name dialog. Resolves with the saved name, or null when cancelled. */
  function askActor(reason) {
    return new Promise(function (resolve) {
      var input = h('input', {
        type: 'text',
        value: actor(),
        placeholder: 'e.g. Nizwar',
        maxLength: 60,
        autocomplete: 'off',
        spellcheck: false,
      });
      input.style.width = '100%';
      var preview = h('div', { class: 'hint' });
      var save = h('button', { class: 'primary', text: 'Save' });
      function refresh() {
        var clean = sanitizeActor(input.value);
        preview.textContent = clean
          ? 'Recorded as “' + clean + ' (dev console)”'
          : 'Letters, digits, spaces and . _ @ + - only';
        save.disabled = !clean;
      }
      input.addEventListener('input', refresh);
      refresh();
      var done = false;
      var m = modal({
        title: 'Who is operating?',
        narrow: true,
        body: h(
          'div',
          { class: 'form' },
          reason
            ? h('div', { class: 'banner warn' }, h('div', { class: 'grow', text: reason }))
            : null,
          h(
            'div',
            { class: 'muted', style: { fontSize: '13px', lineHeight: '1.5' } },
            "Your name goes with every change you make on these pages: wlive-api records it as the override's ",
            h('b', { text: 'set by' }),
            " and the review's ",
            h('b', { text: 'reviewed by' }),
            '. It is kept in this browser.'
          ),
          h('div', { class: 'fld' }, h('label', { text: 'Your name' }), input, preview)
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
        onClose: function () {
          if (!done) resolve(null);
        },
      });
      function commit() {
        var clean = sanitizeActor(input.value);
        if (!clean) return;
        done = true;
        setActor(clean);
        m.close();
        DC.toast('Operating as ' + clean);
        resolve(clean);
      }
      save.onclick = commit;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') commit();
      });
      setTimeout(function () {
        input.focus();
        input.select();
      }, 0);
    });
  }

  function ensureActor() {
    var name = actor();
    if (name) return Promise.resolve(name);
    return askActor('Tell us who you are before the first change.').then(function (n) {
      if (!n) throw new AdminError(0, 'ACTOR_REQUIRED', 'Cancelled — a change needs your name.');
      return n;
    });
  }

  // ---- the admin API ------------------------------------------------------------------

  function AdminError(status, code, message, fields, body) {
    var e = new Error(message);
    e.name = 'AdminError';
    e.status = status;
    e.code = code || null;
    e.fields = fields || null;
    e.body = body || null;
    return e;
  }

  var STATUS_TEXT = {
    400: 'Bad request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not found',
    405: 'This wlive-api does not support that call',
    409: 'Conflict',
    413: 'The upload is too large',
    422: 'Some fields are not valid',
    429: 'Too many requests — wait a minute and retry',
    500: 'wlive-api failed (HTTP 500)',
    501: 'Not configured',
    502: 'wlive-api is unreachable',
    503: 'wlive-api is down for maintenance',
    504: 'wlive-api timed out',
  };

  /** Any wlive-api / proxy error body → {code, message, fields}. */
  function describe(status, body) {
    var b = body && typeof body === 'object' ? body : {};
    var code = null;
    var message = null;
    var fields = null;
    if (b.error && typeof b.error === 'object') {
      code = b.error.code || null;
      message = typeof b.error.message === 'string' ? b.error.message : null;
      fields = b.error.details || null;
    } else if (typeof b.error === 'string') {
      message = b.error;
    }
    if (!message && typeof b.message === 'string' && b.message.trim()) message = b.message.trim();
    if (!fields && b.errors && typeof b.errors === 'object') fields = b.errors;
    if (
      fields &&
      (typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length)
    )
      fields = null;
    if (message === 'INVALID_ADMIN_PROXY_SECRET') {
      code = 'ADMIN_SECRET_REFUSED';
      message =
        'wlive-api refused the admin secret: WLIVE_ADMIN_SECRET on this socket must equal BURACO_ADMIN_PROXY_SECRET on wlive-api.';
    } else if (message && /^No query results for model/.test(message)) {
      message = 'Not found — it may have been deleted meanwhile.';
    } else if (code === 'UNAUTHORIZED' && status === 401) {
      message = 'The webhook secret was refused — reconnect (top right).';
    }
    if (!message) message = STATUS_TEXT[status] || 'HTTP ' + status;
    return { code: code, message: message, fields: fields };
  }

  function queryString(q) {
    if (!q) return '';
    var parts = [];
    Object.keys(q).forEach(function (k) {
      var v = q[k];
      if (v === null || v === undefined || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  /**
   * One admin call. `path` is under /api/buraco/admin/ (e.g. 'skins/4').
   * opts: {query, json, form}. Writes ask for the operator's name first.
   * Resolves {status, data, message, body}; rejects with an AdminError.
   */
  function request(method, path, opts) {
    opts = opts || {};
    if (!DC.secret()) {
      return Promise.reject(
        AdminError(0, 'NOT_CONNECTED', 'Connect with the webhook secret first (top right).')
      );
    }
    var write = method !== 'GET';
    return (write ? ensureActor() : Promise.resolve(actor()))
      .then(function (name) {
        var headers = { 'x-webhook-secret': DC.secret(), Accept: 'application/json' };
        if (name) headers['x-admin-actor'] = name;
        var init = { method: method, headers: headers };
        if (opts.json !== undefined) {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(opts.json);
        } else if (opts.form) {
          init.body = opts.form; // the browser writes the multipart boundary
        }
        return fetch('/dev/api/admin/' + path + queryString(opts.query), init).catch(function (e) {
          throw AdminError(0, 'NETWORK', 'Could not reach this socket server (' + e.message + ')');
        });
      })
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch (e) {
              body = null;
            }
          }
          if (!res.ok || (body && body.success === false)) {
            var d = describe(res.status, body);
            throw AdminError(res.status, d.code, d.message, d.fields, body);
          }
          return {
            status: res.status,
            data: body && typeof body === 'object' && 'data' in body ? body.data : body,
            message: body && typeof body.message === 'string' ? body.message : null,
            body: body,
          };
        });
      });
  }

  var api = {
    get: function (path, query) {
      return request('GET', path, { query: query });
    },
    post: function (path, json) {
      return request('POST', path, { json: json === undefined ? {} : json });
    },
    put: function (path, json) {
      return request('PUT', path, { json: json });
    },
    del: function (path, json) {
      return request('DELETE', path, json === undefined ? {} : { json: json });
    },
    upload: function (path, form) {
      return request('POST', path, { form: form });
    },
  };

  // ---- wlive-api health (nav status) -------------------------------------------------

  var health = { at: 0, data: null, pending: null };

  function checkHealth(force) {
    if (!DC.secret()) {
      renderHealth(null);
      return Promise.resolve(null);
    }
    if (health.pending) return health.pending;
    if (!force && health.data && Date.now() - health.at < 60000)
      return Promise.resolve(health.data);
    health.pending = fetch('/dev/api/admin/_health', {
      headers: { 'x-webhook-secret': DC.secret() },
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            if (r.ok && body && body.data) return body.data;
            return {
              configured: null,
              reachable: false,
              unauthorized: r.status === 401,
              message: describe(r.status, body).message,
            };
          });
      })
      .then(function (data) {
        health.data = data;
        health.at = Date.now();
        renderHealth(health.data);
        return health.data;
      })
      .catch(function (e) {
        health.data = { configured: null, reachable: false, message: e.message };
        renderHealth(health.data);
        return health.data;
      })
      .then(function (d) {
        health.pending = null;
        return d;
      });
    return health.pending;
  }

  function renderHealth(d) {
    var box = document.getElementById('admin-api-status');
    if (!box) return;
    clear(box);
    if (!d) {
      box.className = 'admin-api-status';
      return;
    }
    var cls = d.reachable ? 'ok' : d.configured === false ? 'warn' : 'bad';
    var host = d.target ? d.target.replace(/^https?:\/\//, '') : '';
    var text = d.reachable
      ? 'wlive-api · ' + host + (d.latencyMs != null ? ' · ' + d.latencyMs + ' ms' : '')
      : d.unauthorized
        ? 'not connected'
        : d.configured === false
          ? 'wlive-api not configured'
          : d.status
            ? 'wlive-api answered ' + d.status
            : 'wlive-api unreachable';
    box.className = 'admin-api-status ' + cls;
    box.title =
      d.message || (d.reachable ? 'The admin pages reach wlive-api through this socket' : '');
    box.appendChild(h('span', { class: 'dot' }));
    box.appendChild(h('span', { text: text }));
  }

  // ---- pages -----------------------------------------------------------------------------

  var pages = {};
  var current = null;

  /**
   * def: { mount(root), show(), hide() } — mount once, show on every visit.
   * The page's root is a <section class="page"> inside #admin-pages.
   */
  function registerPage(name, def) {
    pages[name] = { def: def, root: null, mounted: false };
    if (current === name) show(name);
  }

  function show(name) {
    var host = document.getElementById('admin-pages');
    Object.keys(pages).forEach(function (n) {
      var p = pages[n];
      if (n === name) {
        if (!p.root) {
          p.root = h('section', { class: 'page', id: 'page-' + n });
          host.appendChild(p.root);
        }
        p.root.hidden = false;
        if (!p.mounted) {
          p.mounted = true;
          p.def.mount(p.root);
        }
        if (p.def.show) p.def.show();
      } else if (p.root && !p.root.hidden) {
        p.root.hidden = true;
        if (p.def.hide) p.def.hide();
      }
    });
    current = name;
    if (name) checkHealth(false);
  }

  DC.onConnect(function () {
    health.at = 0;
    health.data = null;
    if (current && pages[current] && pages[current].def.show)
      pages[current].def.show({ reconnect: true });
    if (current) checkHealth(true);
  });

  // ---- UI kit ------------------------------------------------------------------------------

  var modalStack = [];
  document.addEventListener(
    'keydown',
    function (e) {
      if (e.key !== 'Escape' || !modalStack.length) return;
      e.stopPropagation();
      e.preventDefault();
      modalStack[modalStack.length - 1].close();
    },
    true
  );

  /**
   * modal({title, sub, wide, narrow, body, foot: [nodes], onClose})
   * → {close, body, foot}. Closes on Esc and its close button (not on a stray
   * backdrop click: a half-filled form is not thrown away by a misclick).
   */
  function modal(opts) {
    var closed = false;
    var bg = h('div', { class: 'modal-bg show' });
    var box = h('div', {
      class: 'modal' + (opts.wide ? ' wide' : '') + (opts.narrow ? ' narrow' : ''),
      attrs: { role: 'dialog', 'aria-modal': 'true' },
    });
    var api0 = { close: close, body: null, foot: null, root: bg };
    box.appendChild(
      h(
        'div',
        { class: 'mh' },
        h('h3', { text: opts.title || '' }),
        opts.sub ? h('span', { class: 'sub', text: opts.sub }) : null,
        h('div', { class: 'spacer' }),
        h('button', { class: 'small', text: 'close', on: { click: close } })
      )
    );
    api0.body = h('div', { class: 'mbody' }, opts.body);
    box.appendChild(api0.body);
    api0.foot = h('div', { class: 'foot' }, opts.foot || []);
    box.appendChild(api0.foot);
    bg.appendChild(box);
    document.body.appendChild(bg);
    modalStack.push(api0);
    function close() {
      if (closed) return;
      closed = true;
      var i = modalStack.indexOf(api0);
      if (i !== -1) modalStack.splice(i, 1);
      bg.remove();
      if (opts.onClose) opts.onClose();
    }
    return api0;
  }

  /**
   * confirmDialog({title, body, confirmText, danger, cancelText}) → Promise<boolean>.
   * The confirm step every destructive / irreversible action goes through.
   */
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var answered = false;
      var ok = h('button', {
        class: opts.danger ? 'danger' : 'primary',
        text: opts.confirmText || 'Confirm',
      });
      var m = modal({
        title: opts.title,
        narrow: !opts.wide,
        body: h('div', { style: { fontSize: '13.5px', lineHeight: '1.55' } }, opts.body),
        foot: [
          h('button', {
            class: 'ghost',
            text: opts.cancelText || 'Cancel',
            on: {
              click: function () {
                m.close();
              },
            },
          }),
          ok,
        ],
        onClose: function () {
          if (!answered) resolve(false);
        },
      });
      ok.onclick = function () {
        answered = true;
        m.close();
        resolve(true);
      };
      setTimeout(function () {
        ok.focus();
      }, 0);
    });
  }

  /**
   * A labelled form field. field(label, control, {hint, required, wide})
   * → {root, control, setError(msg)}.
   */
  function field(label, control, opts) {
    opts = opts || {};
    var err = h('div', { class: 'err' });
    var hint = opts.hint ? h('div', { class: 'hint' }, opts.hint) : null;
    var root = h(
      'div',
      { class: 'fld' + (opts.wide ? ' wide' : '') },
      label
        ? h('label', null, label, opts.required ? h('span', { class: 'req', text: '*' }) : null)
        : null,
      control,
      hint,
      err
    );
    return {
      root: root,
      control: control,
      hint: hint,
      setError: function (msg) {
        root.classList.toggle('bad', !!msg);
        err.textContent = msg || '';
      },
    };
  }

  /**
   * Field errors from a 422 onto the form. `map` is {serverKey: field}; a key
   * like `skins.table_skin` also finds a field registered as `skins.table_skin`
   * or `table_skin`. Whatever matches no field goes to `box` (a .form-error).
   * A field's error goes away on its next edit, unless opts.clearOnInput is
   * false (a form that re-validates on every keystroke itself).
   * Returns true when anything was shown.
   */
  function showErrors(err, map, box, opts) {
    var clearOnInput = !opts || opts.clearOnInput !== false;
    Object.keys(map).forEach(function (k) {
      map[k].setError(null);
    });
    if (box) {
      box.textContent = '';
      box.classList.remove('show');
    }
    if (!err) return false;
    var loose = [];
    if (err.fields) {
      Object.keys(err.fields).forEach(function (key) {
        var msgs = err.fields[key];
        var msg = Array.isArray(msgs) ? msgs.join(' ') : String(msgs);
        var f = map[key] || map[key.split('.').pop()] || map[key.split('.')[0]];
        if (f) {
          f.setError(msg);
          if (clearOnInput) {
            var off = function () {
              f.setError(null);
              f.root.removeEventListener('input', off);
              f.root.removeEventListener('change', off);
            };
            f.root.addEventListener('input', off);
            f.root.addEventListener('change', off);
          }
        } else {
          loose.push(msg);
        }
      });
    }
    if (box) {
      var head =
        err.fields && !loose.length
          ? err.status === 422
            ? 'Check the highlighted fields.'
            : err.message
          : err.message;
      box.textContent = [head].concat(loose).filter(Boolean).join(' ');
      box.classList.add('show');
    }
    return true;
  }

  /** <select> from [{value, label}] (+ an optional placeholder option with value ''). */
  function select(options, value, opts) {
    opts = opts || {};
    var s = h('select');
    if (opts.placeholder != null) s.appendChild(h('option', { value: '', text: opts.placeholder }));
    (options || []).forEach(function (o) {
      s.appendChild(
        h('option', {
          value: String(o.value),
          text: o.label != null ? o.label : String(o.value),
          disabled: o.disabled,
        })
      );
    });
    s.value = value == null ? '' : String(value);
    if (s.value !== (value == null ? '' : String(value)) && value != null && value !== '') {
      // a value the list does not know (e.g. a token newer than this console): keep it visible
      s.appendChild(h('option', { value: String(value), text: String(value) + ' (unknown)' }));
      s.value = String(value);
    }
    return s;
  }

  function numberInput(value, opts) {
    opts = opts || {};
    var i = h('input', {
      type: 'number',
      step: opts.step || 1,
      placeholder: opts.placeholder || '',
    });
    if (opts.min != null) i.min = String(opts.min);
    if (opts.max != null) i.max = String(opts.max);
    i.value = value == null ? '' : String(value);
    return i;
  }

  /** Segmented control: seg([{value, label}], value, onChange) → {root, value()} */
  function seg(options, value, onChange) {
    var current0 = value;
    var root = h('div', { class: 'seg' });
    var buttons = options.map(function (o) {
      var b = h('button', {
        type: 'button',
        text: o.label,
        class: o.value === value ? 'active' : '',
      });
      b.onclick = function () {
        current0 = o.value;
        buttons.forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        if (onChange) onChange(o.value);
      };
      root.appendChild(b);
      return b;
    });
    return {
      root: root,
      value: function () {
        return current0;
      },
      set: function (v) {
        current0 = v;
        options.forEach(function (o, i) {
          buttons[i].classList.toggle('active', o.value === v);
        });
      },
    };
  }

  /**
   * An image picker with a thumbnail and client-side checks (type + size).
   * filePicker({accept, maxBytes, current, wide, onChange(file|null)})
   * → {root, file(), url(), reset(), setError(msg)}
   */
  function filePicker(opts) {
    opts = opts || {};
    var picked = null;
    var objectUrl = null;
    var input = h('input', {
      type: 'file',
      accept: opts.accept || 'image/png,image/jpeg,image/webp',
    });
    var thumb = h('div', { class: 'thumb' + (opts.wide ? ' wide' : '') });
    var name = h('div', { class: 'name' });
    var choose = h('button', {
      type: 'button',
      class: 'small',
      text: opts.current ? 'Replace…' : 'Choose image…',
    });
    var drop = h('button', { type: 'button', class: 'small ghost', text: 'undo', hidden: true });
    var errorLine = h('div', {
      class: 'err',
      style: { display: 'none', fontSize: '12px', color: '#ff9b9b' },
    });
    choose.onclick = function () {
      input.click();
    };
    drop.onclick = function () {
      set(null);
    };
    input.onchange = function () {
      var f = input.files && input.files[0];
      input.value = '';
      if (!f) return;
      var accepted = String(opts.accept || 'image/')
        .split(',')
        .map(function (s) {
          return s.trim();
        });
      var typeOk =
        /^image\//.test(f.type) &&
        (accepted.indexOf(f.type) !== -1 || accepted.indexOf('image/*') !== -1 || !opts.accept);
      if (!typeOk) {
        showErr('That is not an allowed image type (' + (f.type || 'unknown') + ').');
        return;
      }
      if (opts.maxBytes && f.size > opts.maxBytes) {
        showErr(
          'Too large: ' +
            Math.round(f.size / 104857.6) / 10 +
            ' MB (max ' +
            Math.round(opts.maxBytes / 1048576) +
            ' MB).'
        );
        return;
      }
      showErr(null);
      set(f);
    };
    function showErr(msg) {
      errorLine.textContent = msg || '';
      errorLine.style.display = msg ? '' : 'none';
    }
    function set(f) {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      picked = f;
      if (f) objectUrl = URL.createObjectURL(f);
      paint();
      if (opts.onChange) opts.onChange(f);
    }
    function paint() {
      var src = objectUrl || safeUrl(opts.current);
      thumb.style.backgroundImage = src ? cssUrl(src) : 'none';
      thumb.textContent = src ? '' : '🖼';
      name.textContent = picked
        ? picked.name + ' · ' + Math.round(picked.size / 1024) + ' KB (not saved yet)'
        : opts.current
          ? 'current image'
          : 'none';
      drop.hidden = !picked;
    }
    paint();
    return {
      root: h(
        'div',
        { class: 'filepick' },
        thumb,
        h('div', { class: 'meta' }, name, h('div', null, choose, ' ', drop), errorLine),
        input
      ),
      file: function () {
        return picked;
      },
      url: function () {
        return objectUrl;
      },
      reset: function () {
        set(null);
      },
      setCurrent: function (u) {
        opts.current = u;
        paint();
      },
    };
  }

  function userChip(u, small) {
    u = u || {};
    var name = u.name || u.user_name || (u.id != null ? 'user #' + u.id : 'unknown');
    var av = h('span', { class: 'av', text: initials(name) });
    var src = safeUrl(u.profile_photo_thumb);
    if (src) {
      av.style.backgroundImage = cssUrl(src);
      av.textContent = '';
    }
    var sub = [
      u.user_name ? '@' + u.user_name : null,
      u.unique_id ? 'ID ' + u.unique_id : null,
      u.id != null ? '#' + u.id : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return h(
      'div',
      { class: 'uchip' + (small ? ' sm' : ''), title: sub },
      av,
      h(
        'div',
        { class: 'un' },
        h('div', { class: 'n1', text: name }),
        small ? null : h('div', { class: 'n2', text: sub })
      )
    );
  }

  function stateBox(opts) {
    return h(
      'div',
      { class: 'state-box' },
      opts.icon ? h('div', { class: 'big', text: opts.icon }) : null,
      opts.title ? h('div', { class: 'title', text: opts.title }) : null,
      opts.text ? h('div', null, opts.text) : null,
      opts.action || null
    );
  }

  /** The error state for a whole page/panel, with a retry. */
  function errorBox(err, retry) {
    var notConfigured = err && (err.status === 501 || err.code === 'ADMIN_PROXY_NOT_CONFIGURED');
    var notConnected = err && err.code === 'NOT_CONNECTED';
    return stateBox({
      icon: notConfigured ? '🔌' : notConnected ? '🔑' : '⚠️',
      title: notConfigured
        ? 'The admin API is not configured on this socket'
        : notConnected
          ? 'Not connected'
          : err && err.status === 502
            ? 'wlive-api is unreachable'
            : err && err.status === 504
              ? 'wlive-api timed out'
              : 'Could not load',
      text: err ? err.message : '',
      action:
        retry && !notConnected
          ? h('button', { class: 'small', text: 'Retry', on: { click: retry } })
          : null,
    });
  }

  function loadingBox(height) {
    return h('div', { class: 'skeleton', style: { height: (height || 160) + 'px' } });
  }

  /** A page header: title, one-line description, actions on the right. */
  function pageHead(title, sub, actions) {
    return h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h2', { text: title }), sub ? h('div', { class: 'sub' }, sub) : null),
      h('div', { class: 'spacer' }),
      h('div', { class: 'actions' }, actions || [])
    );
  }

  /** Runs fn with the button disabled + a busy label; restores it afterwards. */
  function busy(button, label, fn) {
    var old = button.textContent;
    button.disabled = true;
    if (label) button.textContent = label;
    return Promise.resolve()
      .then(fn)
      .then(
        function (v) {
          button.disabled = false;
          button.textContent = old;
          return v;
        },
        function (e) {
          button.disabled = false;
          button.textContent = old;
          throw e;
        }
      );
  }

  function toastError(prefix, err) {
    DC.toast(
      (prefix ? prefix + ': ' : '') + (err && err.message ? err.message : String(err)),
      true
    );
  }

  renderActorChip();

  window.BuracoAdmin = {
    h: h,
    clear: clear,
    safeUrl: safeUrl,
    cssUrl: cssUrl,
    fmtInt: fmtInt,
    signed: signed,
    fmtDate: fmtDate,
    relTime: relTime,
    initials: initials,
    api: api,
    request: request,
    describe: describe,
    AdminError: AdminError,
    actor: actor,
    askActor: askActor,
    ensureActor: ensureActor,
    sanitizeActor: sanitizeActor,
    checkHealth: checkHealth,
    registerPage: registerPage,
    show: show,
    current: function () {
      return current;
    },
    modal: modal,
    confirmDialog: confirmDialog,
    field: field,
    showErrors: showErrors,
    select: select,
    numberInput: numberInput,
    seg: seg,
    filePicker: filePicker,
    userChip: userChip,
    stateBox: stateBox,
    errorBox: errorBox,
    loadingBox: loadingBox,
    pageHead: pageHead,
    busy: busy,
    toastError: toastError,
    toast: DC.toast,
    console: DC,
  };
})();

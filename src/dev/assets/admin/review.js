/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Review — the leaderboard's anti-collusion guard ("under review" games).
 *
 * When the same player beats the same opponent 5 games in a row (wlive-api
 * LeaderboardService, `collusion_streak_threshold`), the pair is flagged: the
 * streak's points are reversed for both, and further games between the two
 * count for nothing until an admin decides:
 *   - dismiss  → every voided point is restored and the pair counts again
 *                (streak reset);
 *   - confirm  → the points stay voided and the pair stays frozen.
 *
 * wlive-api: GET collusion-flags?status=, GET collusion-flags/{id},
 * POST collusion-flags/{id}/review {status, notes}, GET users/{id}/opponents,
 * GET leaderboard?period=&period_key=.
 *
 * Each game of a flag gets a Replay link when THIS socket still has the match
 * recording (GET /dev/api/matches?backendMatchId= — or, since the backend rows
 * carry no match id today, ?playerIds=<the pair>&at=<played_at>).
 */
(function () {
  'use strict';
  var A = window.BuracoAdmin;
  if (!A) return;
  var h = A.h;
  var DC = A.console;

  var FILTERS = [
    { value: 'open', label: 'Under review' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'dismissed', label: 'Dismissed' },
    { value: 'all', label: 'All' },
  ];
  var STATUS = {
    open: { text: 'under review', cls: 'warn' },
    confirmed: { text: 'confirmed', cls: 'on' },
    dismissed: { text: 'dismissed', cls: 'off' },
  };

  var st = {
    filter: 'open',
    flags: null,
    error: null,
    selectedId: null,
    detail: null,
    detailError: null,
    detailFor: null,
    replayStats: null,
    lookups: {}, // resultId -> {state: 'looking'|'found'|'none'|'error', matches, message}
    boards: {}, // 'period|key' -> {data} | {error}
    opponents: {}, // userId -> {data} | {error}
    period: 'weekly|',
    queue: [],
    inFlight: 0,
  };
  var ui = { replayCells: {} };

  // ---- helpers -----------------------------------------------------------------------

  function nameOf(u) {
    return (u && (u.name || u.user_name)) || (u && u.id != null ? 'user #' + u.id : 'unknown');
  }

  function isoWeekKey(date) {
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }

  function monthKey(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  }

  function voidText(reason, flagId) {
    if (!reason) return null;
    if (reason === 'collusion_flag_' + flagId) return 'voided by this flag';
    var m = /^collusion_flag_(\d+)$/.exec(reason);
    if (m) return 'voided by flag #' + m[1];
    if (reason === 'collusion_pair_flagged') return 'pair frozen — did not count';
    if (reason === 'forfeit_too_short') return 'forfeit too soon after the deal';
    return reason.replace(/_/g, ' ');
  }

  function statusBadge(status) {
    var s = STATUS[status] || { text: status, cls: 'neutral' };
    return h('span', { class: 'badge ' + s.cls, text: s.text });
  }

  function stat(k, v, title) {
    return h(
      'div',
      { class: 'stat', title: title || '' },
      h('div', { class: 'k', text: k }),
      h('div', { class: 'v' }, v)
    );
  }

  function setNavCount(n) {
    var c = document.getElementById('review-count');
    if (!c) return;
    c.textContent = n ? String(n) : '';
    c.classList.toggle('show', !!n);
    c.title = n ? n + ' flagged pair(s) waiting for a verdict' : '';
  }

  // ---- layout ------------------------------------------------------------------------

  function mount(root) {
    ui.refresh = h('button', {
      class: 'small',
      text: 'Refresh',
      on: {
        click: function () {
          loadList(true);
        },
      },
    });
    root.appendChild(
      A.pageHead(
        'Review',
        "Leaderboard anti-collusion. When the same player beats the same opponent 5 games in a row, the pair is flagged: the streak's points are voided and their games stop counting until you decide.",
        [ui.refresh]
      )
    );
    ui.filter = A.seg(FILTERS, st.filter, function (v) {
      st.filter = v;
      st.selectedId = null;
      loadList(true);
    });
    ui.listCount = h('span', { class: 'hint' });
    root.appendChild(h('div', { class: 'row' }, ui.filter.root, ui.listCount));
    ui.list = h('div', { class: 'flag-list' });
    ui.detail = h('div');
    root.appendChild(h('div', { class: 'split list-left' }, h('div', null, ui.list), ui.detail));
  }

  function loadList(force) {
    if (force) {
      st.flags = null;
      renderList();
    }
    ui.refresh.disabled = true;
    A.api
      .get('collusion-flags', { status: st.filter, limit: 200 })
      .then(
        function (res) {
          st.error = null;
          st.flags = Array.isArray(res.data) ? res.data : [];
          if (st.filter === 'open') setNavCount(st.flags.length);
          if (
            !st.flags.some(function (f) {
              return f.id === st.selectedId;
            })
          )
            st.selectedId = st.flags.length ? st.flags[0].id : null;
        },
        function (err) {
          st.error = err;
          st.flags = null;
        }
      )
      .then(function () {
        ui.refresh.disabled = false;
        renderList();
        if (st.selectedId == null) renderDetail();
        else if (force || st.detailFor !== st.selectedId) loadDetail(st.selectedId, true);
      });
    if (st.filter !== 'open') refreshOpenCount();
  }

  function refreshOpenCount() {
    if (!DC.secret()) return;
    A.api.get('collusion-flags', { status: 'open', limit: 200 }).then(
      function (res) {
        setNavCount(Array.isArray(res.data) ? res.data.length : 0);
      },
      function () {
        /* the page itself reports errors */
      }
    );
  }

  function renderList() {
    var box = A.clear(ui.list);
    ui.listCount.textContent = '';
    if (st.error) {
      box.appendChild(
        A.errorBox(st.error, function () {
          loadList(true);
        })
      );
      return;
    }
    if (!st.flags) {
      box.appendChild(A.loadingBox(90));
      box.appendChild(A.loadingBox(90));
      return;
    }
    ui.listCount.textContent =
      st.flags.length +
      (st.flags.length === 200 ? '+' : '') +
      ' flag' +
      (st.flags.length === 1 ? '' : 's');
    if (!st.flags.length) {
      box.appendChild(
        A.stateBox({
          icon: st.filter === 'open' ? '✅' : '🗂',
          title: st.filter === 'open' ? 'Nothing under review' : 'No ' + st.filter + ' flags',
          text:
            st.filter === 'open'
              ? 'No pair has tripped the win-streak rule. The queue is clear.'
              : '',
        })
      );
      return;
    }
    st.flags.forEach(function (f) {
      box.appendChild(
        h(
          'button',
          {
            class: 'flag-item' + (f.id === st.selectedId ? ' selected' : ''),
            on: {
              click: function () {
                st.selectedId = f.id;
                renderList();
                loadDetail(f.id);
              },
            },
          },
          h(
            'div',
            { class: 'f1' },
            h('span', { class: 'who', text: nameOf(f.beneficiary) + '  ⟵  ' + nameOf(f.feeder) }),
            statusBadge(f.status)
          ),
          h('div', {
            class: 'f2',
            text: [
              '×' + f.streak_length + ' in a row',
              f.coins_moved ? '🪙 ' + A.fmtInt(f.coins_moved) + ' moved' : 'free games',
              A.relTime(f.created_at),
              f.reviewed_by ? 'by ' + f.reviewed_by : null,
            ]
              .filter(Boolean)
              .join(' · '),
          })
        )
      );
    });
  }

  // ---- detail ------------------------------------------------------------------------

  function loadDetail(id, force) {
    if (!force && st.detailFor === id && st.detail) {
      renderDetail();
      return;
    }
    st.detailFor = id;
    st.detail = null;
    st.detailError = null;
    renderDetail();
    A.api.get('collusion-flags/' + encodeURIComponent(id)).then(
      function (res) {
        if (st.detailFor !== id) return;
        st.detail = res.data;
        renderDetail();
      },
      function (err) {
        if (st.detailFor !== id) return;
        st.detailError = err;
        renderDetail();
      }
    );
  }

  function renderDetail() {
    var box = A.clear(ui.detail);
    ui.replayCells = {};
    if (st.selectedId == null) {
      // nothing to pick from (empty queue, still loading, or the list failed)
      if (!st.flags || !st.flags.length) return;
      box.appendChild(h('div', { class: 'card' }, A.stateBox({ text: 'Pick a flag' })));
      return;
    }
    if (st.detailError) {
      box.appendChild(
        h(
          'div',
          { class: 'card' },
          A.errorBox(st.detailError, function () {
            loadDetail(st.selectedId, true);
          })
        )
      );
      return;
    }
    if (!st.detail) {
      box.appendChild(A.loadingBox(220));
      return;
    }
    var d = st.detail;
    var flag = d.flag || {};
    box.appendChild(summaryCard(flag, d.pair));
    box.appendChild(gamesCard(flag, d.games || []));
    box.appendChild(standingCard(flag));
    box.appendChild(opponentsCard(flag));
    ui.verdictCard = verdictCard(flag, d.games || []);
    box.appendChild(ui.verdictCard);
    queueLookups(flag, d.games || []);
  }

  function summaryCard(flag, pair) {
    var ben = flag.beneficiary || { id: null };
    var feeder = flag.feeder || { id: null };
    var jump = h('button', {
      class: 'small',
      text: flag.status === 'open' ? 'Decide ↓' : 'Verdict ↓',
      on: {
        click: function () {
          if (ui.verdictCard) ui.verdictCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      },
    });
    var head = h(
      'div',
      { class: 'card-h' },
      h('b', { text: 'Flag #' + flag.id }),
      statusBadge(flag.status),
      h('span', {
        text:
          '· ' +
          (flag.rule === 'same_winner_streak'
            ? 'same winner ' + flag.streak_length + ' games in a row'
            : flag.rule),
      }),
      h('span', {
        text: '· raised ' + A.fmtDate(flag.created_at) + ' (' + A.relTime(flag.created_at) + ')',
      }),
      h('div', { class: 'spacer' }),
      jump
    );
    var reviewed =
      flag.status !== 'open' || flag.reviewed_at
        ? h(
            'div',
            {
              class:
                'banner ' +
                (flag.status === 'dismissed' ? 'ok' : flag.status === 'confirmed' ? 'err' : ''),
            },
            h(
              'div',
              { class: 'grow' },
              h('b', {
                text:
                  flag.status === 'dismissed'
                    ? 'Dismissed'
                    : flag.status === 'confirmed'
                      ? 'Confirmed as win-trading'
                      : 'Reviewed',
              }),
              flag.reviewed_by ? ' by ' + flag.reviewed_by : '',
              flag.reviewed_at ? ' · ' + A.fmtDate(flag.reviewed_at) : '',
              flag.notes
                ? h('div', {
                    class: 'muted',
                    style: { marginTop: '4px', whiteSpace: 'pre-wrap' },
                    text: '“' + flag.notes + '”',
                  })
                : null
            )
          )
        : null;

    var users = h(
      'div',
      { class: 'users2' },
      h(
        'div',
        { class: 'user-card' },
        h('div', { class: 'role', text: 'Won the streak' }),
        A.userChip(ben),
        standingLine(ben)
      ),
      h(
        'div',
        { class: 'user-card' },
        h('div', { class: 'role', text: 'Lost the streak' }),
        A.userChip(feeder),
        standingLine(feeder)
      )
    );

    var stats = h('div', { class: 'kv', style: { marginTop: '10px' } });
    if (pair) {
      var streakWho =
        pair.streak_winner_user_id == null
          ? '—'
          : String(pair.streak_winner_user_id) === String(ben.id)
            ? nameOf(ben)
            : String(pair.streak_winner_user_id) === String(feeder.id)
              ? nameOf(feeder)
              : '#' + pair.streak_winner_user_id;
      stats.appendChild(stat('Games together', A.fmtInt(pair.games)));
      stats.appendChild(
        stat(
          nameOf(ben) + "'s record",
          h(
            'span',
            null,
            h('span', { class: 'pos', text: A.fmtInt(pair.wins) + ' W' }),
            ' – ',
            h('span', { class: 'neg', text: A.fmtInt(pair.losses) + ' L' })
          )
        )
      );
      stats.appendChild(
        stat(
          'Coins to ' + nameOf(ben),
          h('span', {
            class: pair.coins_net > 0 ? 'pos' : pair.coins_net < 0 ? 'neg' : '',
            text: A.signed(pair.coins_net),
          }),
          "net coins that moved between the two, from the winner's side"
        )
      );
      stats.appendChild(
        stat('Current streak', pair.streak_length ? streakWho + ' ×' + pair.streak_length : '—')
      );
      stats.appendChild(
        stat(
          'Pair',
          pair.flagged
            ? h('span', { class: 'neg', text: 'frozen since ' + A.fmtDate(pair.flagged_at) })
            : h('span', { class: 'pos', text: 'counting' }),
          pair.flagged ? 'games between the two count for nothing while frozen' : ''
        )
      );
      stats.appendChild(stat('Last game', pair.last_game_at ? A.fmtDate(pair.last_game_at) : '—'));
    }
    stats.appendChild(
      stat(
        'Coins moved in the streak',
        flag.coins_moved ? '🪙 ' + A.fmtInt(flag.coins_moved) : 'none (free games)'
      )
    );
    return h('div', { class: 'card' }, head, reviewed, users, stats);
  }

  // ---- standings ---------------------------------------------------------------------

  function periodOptions(flag) {
    var opts = [
      { value: 'weekly|', label: 'This week' },
      { value: 'monthly|', label: 'This month' },
    ];
    var at = new Date(flag.created_at);
    if (!isNaN(at.getTime())) {
      var wk = isoWeekKey(at);
      var mo = monthKey(at);
      if (wk !== isoWeekKey(new Date()))
        opts.push({ value: 'weekly|' + wk, label: 'Week of the flag (' + wk + ')' });
      if (mo !== monthKey(new Date()))
        opts.push({ value: 'monthly|' + mo, label: 'Month of the flag (' + mo + ')' });
    }
    return opts;
  }

  // Cached per period (the promise itself, so two readers share one call); a
  // failed call is not cached.
  function boardFor(periodValue) {
    if (st.boards[periodValue]) return st.boards[periodValue];
    var parts = periodValue.split('|');
    var p = A.api
      .get('leaderboard', { period: parts[0], period_key: parts[1] || null, limit: 100 })
      .then(
        function (res) {
          return { data: res.data || { entries: [] } };
        },
        function (err) {
          if (st.boards[periodValue] === p) delete st.boards[periodValue];
          return { error: err };
        }
      );
    st.boards[periodValue] = p;
    return p;
  }

  function entryOf(board, user) {
    if (!board || !board.data || !user) return null;
    return (
      (board.data.entries || []).find(function (e) {
        return e.user && String(e.user.id) === String(user.id);
      }) || null
    );
  }

  /** "#4 this week · 12 pts" line under each user card (current week). */
  function standingLine(user) {
    var line = h('div', { class: 'standing', text: 'standing…' });
    boardFor('weekly|').then(function (board) {
      A.clear(line);
      if (board.error) {
        line.textContent = 'standing: ' + board.error.message;
        return;
      }
      var e = entryOf(board, user);
      if (!e) {
        line.textContent = "not in this week's top 100";
        return;
      }
      line.appendChild(h('span', null, h('b', { text: '#' + e.rank }), ' this week'));
      line.appendChild(h('span', null, h('b', { text: A.signed(e.points) }), ' pts'));
      line.appendChild(h('span', { text: e.wins + ' W – ' + e.losses + ' L' }));
    });
    return line;
  }

  function standingCard(flag) {
    var card = h('div', { class: 'card' });
    var body = h('div');
    var options = periodOptions(flag);
    if (
      !options.some(function (o) {
        return o.value === st.period;
      })
    )
      st.period = options[0].value;
    var seg = A.seg(options, st.period, function (v) {
      st.period = v;
      paint();
    });
    card.appendChild(
      h(
        'div',
        { class: 'card-h' },
        h('b', { text: 'Leaderboard standing' }),
        h('div', { class: 'spacer' }),
        seg.root
      )
    );
    card.appendChild(body);
    var ben = flag.beneficiary;
    var feeder = flag.feeder;
    function paint() {
      A.clear(body).appendChild(A.loadingBox(80));
      boardFor(st.period).then(function (board) {
        A.clear(body);
        if (board.error) {
          body.appendChild(A.errorBox(board.error, paint));
          return;
        }
        var entries = board.data.entries || [];
        var rows = [];
        [ben, feeder].forEach(function (u, i) {
          var e = entryOf(board, u);
          rows.push(
            h(
              'tr',
              { class: 'me' },
              h('td', null, A.userChip(u, true)),
              h('td', { class: 'num', text: e ? '#' + e.rank : '—' }),
              h('td', { class: 'num', text: e ? A.signed(e.points) : '—' }),
              h('td', { class: 'num', text: e ? e.wins + ' – ' + e.losses : '—' }),
              h('td', { class: 'num', text: e ? A.fmtInt(e.games) : '—' }),
              h('td', { class: 'num', text: e ? (e.win_streak ? '×' + e.win_streak : '—') : '—' }),
              h('td', {
                class: 'hint',
                text: e
                  ? i === 0
                    ? 'won the streak'
                    : 'lost the streak'
                  : 'not in the top 100 (or no game this period)',
              })
            )
          );
        });
        var top = entries.slice(0, 5).map(function (e) {
          var mine = [ben, feeder].some(function (u) {
            return u && e.user && String(e.user.id) === String(u.id);
          });
          return h(
            'tr',
            { class: mine ? 'me' : '' },
            h('td', null, A.userChip(e.user, true)),
            h('td', { class: 'num', text: '#' + e.rank }),
            h('td', { class: 'num', text: A.signed(e.points) }),
            h('td', { class: 'num', text: e.wins + ' – ' + e.losses }),
            h('td', { class: 'num', text: A.fmtInt(e.games) }),
            h('td', { class: 'num', text: e.win_streak ? '×' + e.win_streak : '—' }),
            h('td')
          );
        });
        body.appendChild(
          h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'lb-mini' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ['Player', 'Rank', 'Points', 'W – L', 'Games', 'Streak', ''].map(function (t) {
                    return h('th', { text: t });
                  })
                )
              ),
              h(
                'tbody',
                null,
                rows,
                top.length
                  ? h(
                      'tr',
                      null,
                      h('td', {
                        attrs: { colspan: '7' },
                        class: 'hint',
                        text: 'Top of the board · ' + (board.data.period_key || ''),
                      })
                    )
                  : null,
                top
              )
            )
          )
        );
        body.appendChild(
          h('div', {
            class: 'hint',
            style: { marginTop: '6px' },
            text: 'Points are +1 a win, −1 a loss. Voided games are already taken out; a dismissal puts them back. "Week/month of the flag" uses this browser\'s calendar.',
          })
        );
      });
    }
    paint();
    return card;
  }

  // ---- who they play with ---------------------------------------------------------

  function opponentsFor(userId) {
    if (st.opponents[userId]) return st.opponents[userId];
    var p = A.api.get('users/' + encodeURIComponent(userId) + '/opponents').then(
      function (res) {
        return { data: res.data || { opponents: [] } };
      },
      function (err) {
        if (st.opponents[userId] === p) delete st.opponents[userId];
        return { error: err };
      }
    );
    st.opponents[userId] = p;
    return p;
  }

  function opponentsCard(flag) {
    var card = h('div', { class: 'card' });
    card.appendChild(
      h(
        'div',
        { class: 'card-h' },
        h('b', { text: 'Who they play with' }),
        h('span', { text: '· everyone each of them has faced, most played first' })
      )
    );
    [
      ['Won the streak', flag.beneficiary, flag.feeder],
      ['Lost the streak', flag.feeder, flag.beneficiary],
    ].forEach(function (x) {
      var user = x[1];
      var other = x[2];
      if (!user || user.id == null) return;
      var body = h('div');
      var fold = h(
        'details',
        { class: 'fold' },
        h(
          'summary',
          null,
          h('b', { text: nameOf(user) }),
          h('span', { class: 'hint', text: x[0] })
        ),
        body
      );
      var loaded = false;
      fold.addEventListener('toggle', function () {
        if (!fold.open || loaded) return;
        loaded = true;
        body.appendChild(A.loadingBox(60));
        opponentsFor(user.id).then(function (res) {
          A.clear(body);
          if (res.error) {
            body.appendChild(A.errorBox(res.error));
            loaded = false;
            return;
          }
          var list = res.data.opponents || [];
          if (!list.length) {
            body.appendChild(h('div', { class: 'hint', text: 'No recorded games.' }));
            return;
          }
          body.appendChild(
            h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                { class: 'lb-mini' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    ['Opponent', 'Games', 'W – L', 'Coins', 'Streak', ''].map(function (t) {
                      return h('th', { text: t });
                    })
                  )
                ),
                h(
                  'tbody',
                  null,
                  list.map(function (o) {
                    var isPair = other && o.opponent && String(o.opponent.id) === String(other.id);
                    var streak = o.streak_length
                      ? (String(o.streak_winner_user_id) === String(user.id) ? 'won ×' : 'lost ×') +
                        o.streak_length
                      : '—';
                    return h(
                      'tr',
                      { class: isPair ? 'me' : '' },
                      h('td', null, A.userChip(o.opponent, true)),
                      h('td', { class: 'num', text: A.fmtInt(o.games) }),
                      h('td', { class: 'num', text: o.wins + ' – ' + o.losses }),
                      h('td', {
                        class: 'num ' + (o.coins_net > 0 ? 'pos' : o.coins_net < 0 ? 'neg' : ''),
                        text: A.signed(o.coins_net),
                      }),
                      h('td', { class: 'num', text: streak }),
                      h(
                        'td',
                        null,
                        o.flagged ? h('span', { class: 'badge on', text: 'frozen' }) : null,
                        isPair
                          ? h('span', { class: 'badge tiny neutral', text: 'this pair' })
                          : null
                      )
                    );
                  })
                )
              )
            )
          );
        });
      });
      card.appendChild(fold);
    });
    return card;
  }

  // ---- games + replay links ---------------------------------------------------------

  function gamesCard(flag, games) {
    var card = h('div', { class: 'card' });
    var streakIds = {};
    ((flag.evidence && flag.evidence.game_ids) || []).forEach(function (id) {
      streakIds[String(id)] = true;
    });
    if (flag.game_id != null) streakIds[String(flag.game_id)] = true;
    var voided = games.filter(function (g) {
      return g.void_reason === 'collusion_flag_' + flag.id;
    }).length;
    card.appendChild(
      h(
        'div',
        { class: 'card-h' },
        h('b', { text: 'Games between the two' }),
        h('span', {
          text:
            '· ' +
            games.length +
            (games.length === 100 ? ' (latest 100)' : '') +
            ' · from ' +
            nameOf(flag.beneficiary) +
            "'s side",
        }),
        voided ? h('span', { class: 'badge on', text: voided + ' voided by this flag' }) : null
      )
    );
    if (!games.length) {
      card.appendChild(h('div', { class: 'hint', text: 'No shared game on record.' }));
      return card;
    }
    var tbody = h('tbody');
    games.forEach(function (g) {
      var cell = h('td', { class: 'replay-cell' }, h('span', { class: 'gone', text: '…' }));
      ui.replayCells[String(g.id)] = cell;
      var others = [];
      (g.teammates || []).forEach(function (u) {
        others.push('with ' + nameOf(u));
      });
      (g.opponents || []).forEach(function (u) {
        if (!flag.feeder || String(u.id) !== String(flag.feeder.id)) others.push('vs ' + nameOf(u));
      });
      var vt = voidText(g.void_reason, flag.id);
      tbody.appendChild(
        h(
          'tr',
          { class: streakIds[String(g.game_id)] ? 'streak' : '' },
          h(
            'td',
            { class: 'nowrap', title: 'game #' + g.game_id + ' · room #' + g.room_id },
            A.fmtDate(g.played_at),
            streakIds[String(g.game_id)]
              ? h('div', null, h('span', { class: 'badge tiny dirty', text: 'streak' }))
              : null
          ),
          h(
            'td',
            null,
            h('span', {
              class: 'badge tiny ' + (g.outcome === 'win' ? 'off' : 'on'),
              text: g.outcome === 'win' ? 'won' : 'lost',
            })
          ),
          h('td', { class: 'num nowrap', text: g.bet ? '🪙 ' + A.fmtInt(g.bet) : 'free' }),
          h('td', {
            class: 'num nowrap ' + (g.coins_delta > 0 ? 'pos' : g.coins_delta < 0 ? 'neg' : ''),
            text: g.bet ? A.signed(g.coins_delta) : '—',
          }),
          h(
            'td',
            { class: 'num' },
            g.counted ? A.signed(g.points_delta) : h('span', { class: 'muted', text: '0' })
          ),
          h(
            'td',
            null,
            g.counted
              ? h('span', { class: 'hint', text: 'counted' })
              : h('span', {
                  class: 'badge tiny ' + (vt === 'voided by this flag' ? 'on' : 'neutral'),
                  text: vt || 'not counted',
                })
          ),
          h(
            'td',
            { class: 'hint' },
            [
              g.reason && g.reason !== 'match_end' && g.reason !== 'round_end'
                ? g.reason.replace(/_/g, ' ')
                : null,
            ]
              .concat(others)
              .filter(Boolean)
              .join(' · ') || ''
          ),
          cell
        )
      );
    });
    card.appendChild(
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'games-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              [
                'Played',
                nameOf(flag.beneficiary),
                'Bet',
                'Coins',
                'Points',
                'Leaderboard',
                'Notes',
                'Replay',
              ].map(function (t) {
                return h('th', { text: t });
              })
            )
          ),
          tbody
        )
      )
    );
    card.appendChild(
      h('div', {
        class: 'hint',
        style: { marginTop: '6px' },
        text: 'Red rows are the streak that raised this flag. Replay opens the match recording on this socket, if it still has it.',
      })
    );
    return card;
  }

  function queueLookups(flag, games) {
    var pair = [flag.beneficiary && flag.beneficiary.id, flag.feeder && flag.feeder.id].filter(
      function (x) {
        return x != null;
      }
    );
    games.forEach(function (g) {
      var key = String(g.id);
      var known = st.lookups[key];
      if (known && known.state !== 'error') {
        paintReplayCell(key, g);
        return;
      }
      st.lookups[key] = { state: 'looking' };
      st.queue.push(function () {
        return lookup(key, g, pair);
      });
    });
    pump();
  }

  function pump() {
    while (st.inFlight < 3 && st.queue.length) {
      var job = st.queue.shift();
      st.inFlight += 1;
      job().then(function () {
        st.inFlight -= 1;
        pump();
      });
    }
  }

  function lookup(key, g, pair) {
    // A backend row that names its match (match_id = <roomId>:<createdAt ms>)
    // is found exactly; today's rows do not, so the pair + the settle time do.
    // The window is generous (a settlement can trail the last event when the
    // result webhook is retried); the closest match END wins.
    var matchId = g.match_id || g.backend_match_id || null;
    var qs = matchId
      ? 'backendMatchId=' + encodeURIComponent(matchId)
      : 'playerIds=' +
        encodeURIComponent(pair.join(',')) +
        '&at=' +
        encodeURIComponent(g.played_at) +
        '&windowMs=2700000&limit=3';
    return DC.api('/dev/api/matches?' + qs)
      .then(
        function (res) {
          if (res && res.stats) st.replayStats = res.stats;
          var rows = (res && res.matches) || [];
          st.lookups[key] = rows.length
            ? { state: 'found', matches: rows, exact: !!matchId }
            : { state: 'none' };
        },
        function (err) {
          st.lookups[key] = { state: 'error', message: err.message };
        }
      )
      .then(function () {
        paintReplayCell(key, g);
      });
  }

  function paintReplayCell(key, g) {
    var cell = ui.replayCells[key];
    if (!cell) return;
    A.clear(cell);
    var l = st.lookups[key] || {};
    if (l.state === 'looking') {
      cell.appendChild(h('span', { class: 'gone', text: 'looking…' }));
      return;
    }
    if (l.state === 'found') {
      var first = l.matches[0];
      cell.appendChild(
        h('button', {
          class: 'small primary',
          text: '▶ Replay',
          title:
            first.matchId +
            (first.backendMatchId ? ' · backend match ' + first.backendMatchId : '') +
            (l.exact ? '' : ' · matched by the two players and the time the game was settled'),
          on: {
            click: function () {
              DC.openReplay(first.matchId, first.roomId);
            },
          },
        })
      );
      l.matches.slice(1).forEach(function (m, i) {
        cell.appendChild(
          h('button', {
            class: 'small ghost',
            text: 'part ' + (i + 2),
            title: m.matchId + (m.partial ? ' (resumed after a restart)' : ''),
            on: {
              click: function () {
                DC.openReplay(m.matchId, m.roomId);
              },
            },
          })
        );
      });
      return;
    }
    if (l.state === 'error') {
      cell.appendChild(h('span', { class: 'gone', text: 'lookup failed', title: l.message || '' }));
      return;
    }
    var stats = st.replayStats || {};
    var age = Date.now() - new Date(g.played_at).getTime();
    var text;
    var title = '';
    if (stats.enabled === false) text = 'replays are off here';
    else if (stats.retentionMs && age > stats.retentionMs) {
      text = 'gone (kept ' + Math.round(stats.retentionMs / 86400000) + ' d)';
      title =
        'This socket deletes match recordings after ' +
        Math.round(stats.retentionMs / 86400000) +
        ' days.';
    } else if (stats.persist === false) {
      text = 'not on this socket';
      title =
        'Replays are memory-only on this socket: a restart loses them. The game may also have been played on another node.';
    } else {
      text = 'not on this socket';
      title =
        'No recording matches: played on another socket node, before replays were recorded, or the recording was lost.';
    }
    cell.appendChild(h('span', { class: 'gone', text: text, title: title }));
  }

  // ---- verdict ------------------------------------------------------------------------

  function verdictCard(flag, games) {
    var card = h('div', { class: 'card' });
    var reviewed = flag.status !== 'open';
    card.appendChild(
      h(
        'div',
        { class: 'card-h' },
        h('b', { text: reviewed ? 'Verdict' : 'Your verdict' }),
        reviewed ? statusBadge(flag.status) : null
      )
    );
    var voided = games.filter(function (g) {
      return g.void_reason === 'collusion_flag_' + flag.id;
    }).length;
    var ben = nameOf(flag.beneficiary);
    var feeder = nameOf(flag.feeder);

    var notes = h('textarea', {
      maxLength: 2000,
      placeholder: 'What you looked at and why (kept with the verdict)',
      value: reviewed ? flag.notes || '' : '',
    });
    var fNotes = A.field('Notes', notes, { hint: 'Optional, up to 2000 characters.' });
    var errBox = h('div', { class: 'form-error' });
    var dismiss = h('button', {
      class: 'primary',
      text: flag.status === 'dismissed' ? 'Dismissed' : 'Dismiss — not win-trading',
      disabled: flag.status === 'dismissed',
    });
    var confirmBtn = h('button', {
      class: 'danger',
      text: flag.status === 'confirmed' ? 'Confirmed' : 'Confirm — win-trading',
      disabled: flag.status === 'confirmed',
    });
    var controls = h(
      'div',
      { class: 'verdict' },
      h(
        'ul',
        { class: 'confirm-list', style: { marginTop: '0' } },
        h(
          'li',
          null,
          h('b', { text: 'Dismiss' }),
          ' gives back the points this flag voided (' +
            voided +
            ' game' +
            (voided === 1 ? '' : 's') +
            ' in view) and lets the pair count again, streak reset.'
        ),
        h(
          'li',
          null,
          h('b', { text: 'Confirm' }),
          ' keeps those points voided and keeps the pair frozen: games between ' +
            ben +
            ' and ' +
            feeder +
            ' keep counting for nothing.'
        )
      ),
      fNotes.root,
      errBox,
      h('div', { class: 'btns' }, dismiss, confirmBtn)
    );

    if (reviewed) {
      var change = h('button', { class: 'small', text: 'Change verdict' });
      controls.hidden = true;
      change.onclick = function () {
        controls.hidden = false;
        change.hidden = true;
      };
      card.appendChild(
        h(
          'div',
          { class: 'verdict-done' },
          h(
            'span',
            null,
            flag.status === 'dismissed' ? 'Dismissed' : 'Confirmed',
            flag.reviewed_by ? ' by ' : '',
            flag.reviewed_by ? h('b', { text: flag.reviewed_by }) : null,
            flag.reviewed_at ? ' · ' + A.fmtDate(flag.reviewed_at) : ''
          ),
          h('div', { class: 'spacer' }),
          change
        )
      );
    }
    card.appendChild(controls);

    function decide(status) {
      var name = A.actor();
      var items =
        status === 'dismissed'
          ? [
              h(
                'li',
                null,
                h('b', { text: ben }),
                ' gets back the wins and ',
                h('b', { text: feeder }),
                ' the losses this flag voided (' +
                  voided +
                  ' game' +
                  (voided === 1 ? '' : 's') +
                  '), on the weekly and monthly boards they were scored on.'
              ),
              h(
                'li',
                null,
                'Games between the two count again; the win streak starts over from 0.'
              ),
            ]
          : [
              h(
                'li',
                null,
                'The ' +
                  voided +
                  ' voided game' +
                  (voided === 1 ? '' : 's') +
                  ' stay voided — no points for either.'
              ),
              h(
                'li',
                null,
                'The pair stays frozen: any game between ',
                h('b', { text: ben }),
                ' and ',
                h('b', { text: feeder }),
                ' keeps counting for nothing.'
              ),
              flag.status === 'dismissed'
                ? h(
                    'li',
                    null,
                    h('b', {
                      text: 'Points the earlier dismissal gave back are NOT taken away again',
                    }),
                    ' — confirming now only freezes the pair.'
                  )
                : null,
            ];
      items.push(
        h(
          'li',
          null,
          'Recorded as reviewed by ',
          h('b', { text: (name || 'you') + ' (dev console)' }),
          '.'
        )
      );
      if (notes.value.trim())
        items.push(
          h(
            'li',
            null,
            'Notes: “' +
              notes.value.trim().slice(0, 200) +
              (notes.value.trim().length > 200 ? '…' : '') +
              '”'
          )
        );
      return A.confirmDialog({
        title: (status === 'dismissed' ? 'Dismiss' : 'Confirm') + ' flag #' + flag.id + '?',
        danger: status === 'confirmed',
        confirmText: status === 'dismissed' ? 'Dismiss and restore points' : 'Confirm win-trading',
        body: [
          h('div', {
            text: ben + ' beat ' + feeder + ' ' + flag.streak_length + ' times in a row.',
          }),
          h('ul', { class: 'confirm-list' }, items),
        ],
      })
        .then(function (ok) {
          if (!ok) return;
          A.showErrors(null, { notes: fNotes }, errBox);
          var button = status === 'dismissed' ? dismiss : confirmBtn;
          return A.busy(button, 'Saving…', function () {
            return A.api.post('collusion-flags/' + encodeURIComponent(flag.id) + '/review', {
              status: status,
              notes: notes.value.trim() || null,
            });
          }).then(function () {
            A.toast(
              'Flag #' +
                flag.id +
                ' ' +
                (status === 'dismissed' ? 'dismissed — points restored' : 'confirmed')
            );
            st.boards = {};
            st.opponents = {};
            loadList(false);
            loadDetail(flag.id, true);
            refreshOpenCount();
          });
        })
        .catch(function (err) {
          A.showErrors(err, { notes: fNotes }, errBox);
        });
    }
    dismiss.onclick = function () {
      ensureName().then(function (ok) {
        if (ok) decide('dismissed');
      });
    };
    confirmBtn.onclick = function () {
      ensureName().then(function (ok) {
        if (ok) decide('confirmed');
      });
    };
    return card;
  }

  // The confirm step names who is deciding, so ask for the name before it.
  function ensureName() {
    return A.ensureActor().then(
      function () {
        return true;
      },
      function () {
        return false;
      }
    );
  }

  A.registerPage('review', {
    mount: mount,
    show: function () {
      st.boards = {};
      st.opponents = {};
      loadList(!st.flags);
    },
  });

  // The nav badge: flagged pairs waiting for a verdict (once the console is connected).
  function initialCount() {
    if (!DC.secret()) return;
    A.checkHealth(false).then(function (hdata) {
      if (hdata && hdata.reachable) refreshOpenCount();
    });
  }
  DC.onConnect(initialCount);
  setTimeout(initialCount, 1500);
})();

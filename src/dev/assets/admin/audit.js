/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * Audit — every scored game and what the leaderboard's fair-play rules saw
 * (wlive-api FairPlayService + the game's audit row). 2 vs 2 by default.
 *
 * The rules, all admin settings (Settings → Fair play):
 *   - same local network: opponents on one network neither gain nor lose;
 *     partners on one network who WIN score nobody (their loss counts);
 *   - a pair frozen by the streak guard cannot score as partners;
 *   - the same partners, and the same four players in the same teams, score
 *     only their first N games per window.
 * The streak guard itself (Review) shows here too: frozen pairs and new flags.
 *
 * wlive-api: GET audit/games?mode=2v2|1v1|all&only=all|flagged&user=&page=&per_page=,
 * GET audit/games/{id}, GET audit/users/{user}/networks. Games scored before
 * the audit existed come from the ledger alone (`audited: false`).
 *
 * Replay: this socket's /dev/api/matches, by the game's match id when the
 * settlement carried one, else by the players and the settle time (as Review).
 * A game opens at #/audit/<game id>.
 */
(function () {
  'use strict';
  var A = window.BuracoAdmin;
  if (!A) return;
  var h = A.h;
  var DC = A.console;

  var PER_PAGE = 30;
  var MODES = [
    { value: '2v2', label: '2 vs 2' },
    { value: '1v1', label: '1 vs 1' },
    { value: 'all', label: 'All' },
  ];
  var SHOWING = [
    { value: 'all', label: 'All games' },
    { value: 'flagged', label: 'Flagged only' },
  ];

  /** Rule name (an audit hit) → its badge. */
  var RULES = {
    same_network: { text: 'Same network', cls: 'on' },
    frozen_pair_team: { text: 'Frozen pair as partners', cls: 'on' },
    partner_cap: { text: 'Partner cap', cls: 'warn' },
    lineup_cap: { text: 'Line-up cap', cls: 'warn' },
    frozen_pair: { text: 'Frozen pair', cls: 'on' },
    streak_flag: { text: 'Streak flag', cls: 'on' },
  };

  /** Why a whole game moved nobody's points (the audit's verdict). */
  var VERDICTS = {
    same_network_team: 'Nobody scored: partners on one local network won.',
    frozen_pair_team: 'Nobody scored: a frozen pair won as partners.',
    partner_cap: 'Nobody scored: the winners were partners over their game cap.',
    lineup_cap: 'Nobody scored: the same four players in the same teams were over their game cap.',
    forfeit_too_short: 'Nobody scored: a forfeit too soon after the deal.',
  };

  var st = {
    mode: '2v2',
    only: 'all',
    user: '',
    page: 1,
    list: null,
    error: null,
    gameId: null,
    detail: null,
    detailError: null,
  };
  var ui = {};

  // ---- words ---------------------------------------------------------------------------

  function nameOf(u) {
    return (u && (u.name || u.user_name)) || (u && u.id != null ? 'user #' + u.id : 'unknown');
  }

  /** A ledger row's void reason in plain words. */
  function voidText(reason) {
    if (!reason) return 'not counted';
    var m = /^collusion_flag_(\d+)$/.exec(reason);
    if (m) return 'voided by flag #' + m[1];
    var words = {
      same_network: 'same local network',
      same_network_team: 'partners on one network won',
      frozen_pair_team: 'frozen pair won as partners',
      partner_cap: 'partners over their game cap',
      lineup_cap: 'same four over their game cap',
      collusion_pair_flagged: 'pair frozen — did not count',
      forfeit_too_short: 'forfeit too soon after the deal',
    };
    return words[reason] || reason.replace(/_/g, ' ');
  }

  function tableText(g) {
    var r = g.room || {};
    var target = Number(r.target_score) || 0;
    return [
      g.mode === '2v2' ? '2 vs 2' : g.mode === '1v1' ? '1 vs 1' : g.mode || null,
      target > 0 ? 'to ' + A.fmtInt(target) : 'one hand',
      r.ruleset ? String(r.ruleset) : null,
      Number(r.bet) > 0 ? 'bet ' + A.fmtInt(r.bet) : 'free',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function endText(reason) {
    if (!reason || reason === 'match_end' || reason === 'round_end' || reason === 'normal') return null;
    return reason.replace(/_/g, ' ');
  }

  function pts(n, counted) {
    var v = Number(n) || 0;
    return h('span', {
      class: 'pts ' + (!counted ? 'zero' : v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'),
      text: counted ? A.signed(v) : '0',
    });
  }

  function badge(text, cls, title) {
    return h('span', { class: 'badge tiny ' + (cls || 'neutral'), text: text, title: title || '' });
  }

  function ruleBadges(g) {
    var out = (g.rules || []).map(function (r) {
      var b = RULES[r] || { text: r.replace(/_/g, ' '), cls: 'neutral' };
      return badge(b.text, b.cls);
    });
    if (!g.audited) out.push(badge('not audited', 'neutral', 'Scored before the audit existed: the ledger only'));
    else if (!out.length && !g.voided_results) out.push(h('span', { class: 'hint', text: 'clean' }));
    return out;
  }

  function people(g) {
    var map = {};
    (g.teams || []).forEach(function (t) {
      (t.players || []).forEach(function (p) {
        if (p.user && p.user.id != null) map[String(p.user.id)] = p.user;
      });
    });
    return map;
  }

  function idsOf(g) {
    return Object.keys(people(g));
  }

  // ---- layout --------------------------------------------------------------------------

  function mount(root) {
    ui.refresh = h('button', {
      class: 'small',
      text: 'Refresh',
      on: {
        click: function () {
          if (st.gameId != null) loadGame(st.gameId);
          else loadList();
        },
      },
    });
    root.appendChild(
      A.pageHead(
        'Audit',
        'Every scored game and what the fair-play rules did to its points: players on one local network, partners or the same four over their game cap, frozen pairs, streak flags. The rules themselves are under Settings → Fair play.',
        [ui.refresh]
      )
    );

    // The list
    ui.mode = A.seg(MODES, st.mode, function (v) {
      st.mode = v;
      st.page = 1;
      loadList();
    });
    ui.only = A.seg(SHOWING, st.only, function (v) {
      st.only = v;
      st.page = 1;
      loadList();
    });
    ui.search = h('input', {
      type: 'text',
      placeholder: 'Player id or WLive ID',
      autocomplete: 'off',
      spellcheck: false,
      inputMode: 'numeric',
    });
    ui.search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runSearch();
    });
    ui.who = h('span');
    ui.listView = h(
      'div',
      null,
      h(
        'div',
        { class: 'audit-filters' },
        ui.mode.root,
        ui.only.root,
        h(
          'span',
          { class: 'search' },
          ui.search,
          h('button', { class: 'small', text: 'Find', on: { click: runSearch } })
        ),
        ui.who
      ),
      (ui.listBox = h('div', { class: 'card audit-card' }))
    );
    ui.detailView = h('div', { hidden: true });
    root.appendChild(ui.listView);
    root.appendChild(ui.detailView);
  }

  function runSearch() {
    var v = ui.search.value.trim();
    if (v && !/^\d{1,20}$/.test(v)) {
      A.toast('A player id or WLive ID is digits only', true);
      return;
    }
    st.user = v;
    st.page = 1;
    loadList();
  }

  function paintWho() {
    var box = A.clear(ui.who);
    if (!st.user) return;
    var u = st.list && st.list.user;
    box.appendChild(
      h(
        'span',
        { class: 'audit-who' },
        u
          ? A.userChip(u, true)
          : h('span', { class: st.list ? '' : 'hint', text: st.list ? 'No player ' + st.user : 'Player ' + st.user + '…' }),
        h('button', {
          class: 'small ghost',
          text: 'Clear',
          on: {
            click: function () {
              st.user = '';
              ui.search.value = '';
              st.page = 1;
              loadList();
            },
          },
        })
      )
    );
  }

  // ---- the list ------------------------------------------------------------------------

  function loadList() {
    st.list = null;
    st.error = null;
    renderList();
    ui.refresh.disabled = true;
    var asked = [st.mode, st.only, st.user, st.page].join('|');
    A.api
      .get('audit/games', {
        mode: st.mode,
        only: st.only === 'flagged' ? 'flagged' : null,
        user: st.user || null,
        page: st.page,
        per_page: PER_PAGE,
      })
      .then(
        function (res) {
          if (asked !== [st.mode, st.only, st.user, st.page].join('|')) return;
          st.list = res.data && typeof res.data === 'object' ? res.data : { games: [] };
        },
        function (err) {
          if (asked !== [st.mode, st.only, st.user, st.page].join('|')) return;
          st.error = err;
        }
      )
      .then(function () {
        ui.refresh.disabled = false;
        renderList();
      });
  }

  function missingEndpoint(err) {
    return err && (err.status === 404 || err.status === 405) && !(err.body && err.body.data);
  }

  function renderList() {
    var box = A.clear(ui.listBox);
    paintWho();
    if (st.error) {
      box.appendChild(
        missingEndpoint(st.error)
          ? A.stateBox({
              icon: 'plug',
              title: 'This wlive-api has no game audit yet',
              text: 'GET /api/buraco/admin/audit/games answered ' + st.error.status + '. It ships with the wlive-api branch feat/buraco-fair-play; deploy that (and its two migrations), then refresh.',
              action: h('button', { class: 'small', text: 'Retry', on: { click: loadList } }),
            })
          : A.errorBox(st.error, loadList)
      );
      return;
    }
    if (!st.list) {
      box.appendChild(A.loadingBox(320));
      return;
    }
    var games = st.list.games || [];
    if (!games.length) {
      box.appendChild(
        A.stateBox({
          icon: st.only === 'flagged' ? 'check' : 'inbox',
          title:
            st.user && !st.list.user
              ? 'No player with id ' + st.user
              : st.only === 'flagged'
                ? 'No flagged games'
                : 'No scored games',
          text:
            st.only === 'flagged' && !st.user
              ? 'No game here had a rule match or a voided result.'
              : 'Only ranked games reach the leaderboard (every 2 vs 2 table, and Qanoon 1 vs 1).',
        })
      );
      return;
    }

    var tbody = h('tbody');
    games.forEach(function (g) {
      tbody.appendChild(listRow(g));
    });
    box.appendChild(
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'audit-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['Played', 'Table', 'Won', 'Lost', 'Worth', 'Fair play', ''].map(function (t) {
                return h('th', { text: t });
              })
            )
          ),
          tbody
        )
      )
    );
    box.appendChild(pager());
  }

  function listRow(g) {
    var voidedAll =
      g.voided_results > 0 &&
      (g.teams || []).every(function (t) {
        return (t.players || []).every(function (p) {
          return !p.counted;
        });
      });
    var tr = h('tr', {
      class: voidedAll ? 'voided' : g.flagged ? 'flagged' : '',
      attrs: { tabindex: '0', title: 'Open game #' + g.game_id },
      on: {
        click: function () {
          openGame(g.game_id);
        },
        keydown: function (e) {
          if (e.key === 'Enter') openGame(g.game_id);
        },
      },
    });
    var teams = g.teams || [];
    tr.appendChild(
      h(
        'td',
        { class: 'nowrap' },
        h('div', { text: A.fmtDate(g.played_at) }),
        h('div', { class: 'hint', text: A.relTime(g.played_at) })
      )
    );
    tr.appendChild(
      h(
        'td',
        { class: 'tbl' },
        h('div', { class: 'tag', text: (g.room && g.room.code) || 'room ?' }),
        h('div', { class: 'hint', text: tableText(g) }),
        endText(g.reason) ? h('div', { class: 'hint', text: 'ended: ' + endText(g.reason) }) : null
      )
    );
    tr.appendChild(h('td', null, teamCell(teams[0])));
    tr.appendChild(h('td', null, teamCell(teams[1])));
    tr.appendChild(h('td', { class: 'num nowrap', text: '±' + A.fmtInt(g.points_value) }));
    tr.appendChild(
      h(
        'td',
        { class: 'fp' },
        h('div', { class: 'audit-rules' }, ruleBadges(g)),
        g.verdict && VERDICTS[g.verdict]
          ? h('div', { class: 'hint', style: { marginTop: '4px' }, text: VERDICTS[g.verdict] })
          : (g.rules || []).length && !g.voided_results
            ? h('div', { class: 'hint', style: { marginTop: '4px' }, text: 'Matched, but every result counted.' })
            : null
      )
    );
    tr.appendChild(h('td', { class: 'go' }, A.icon('chevron-right') || '›'));
    return tr;
  }

  function teamCell(team) {
    var box = h('div', { class: 'ateam' });
    ((team && team.players) || []).forEach(function (p) {
      box.appendChild(
        h(
          'div',
          { class: 'aplayer' },
          h(
            'div',
            { class: 'who' },
            h('div', { class: 'nm', text: nameOf(p.user), title: chipTitle(p.user) }),
            p.counted ? null : h('div', { class: 'why', text: voidText(p.void_reason) })
          ),
          pts(p.points_delta, p.counted)
        )
      );
    });
    return box;
  }

  function chipTitle(u) {
    if (!u) return '';
    return [u.user_name ? '@' + u.user_name : null, u.unique_id ? 'ID ' + u.unique_id : null, u.id != null ? '#' + u.id : null]
      .filter(Boolean)
      .join(' · ');
  }

  function pager() {
    var total = Number(st.list.total) || 0;
    var per = Number(st.list.per_page) || PER_PAGE;
    var page = Number(st.list.page) || st.page;
    var pages = Math.max(1, Math.ceil(total / per));
    var from = total ? (page - 1) * per + 1 : 0;
    var to = Math.min(total, page * per);
    return h(
      'div',
      { class: 'audit-pager' },
      h('span', { text: A.fmtInt(from) + '–' + A.fmtInt(to) + ' of ' + A.fmtInt(total) + ' game' + (total === 1 ? '' : 's') }),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'small',
        text: 'Newer',
        disabled: page <= 1,
        on: {
          click: function () {
            st.page = Math.max(1, page - 1);
            loadList();
          },
        },
      }),
      h('span', { text: 'Page ' + page + ' of ' + pages }),
      h('button', {
        class: 'small',
        text: 'Older',
        disabled: page >= pages,
        on: {
          click: function () {
            st.page = page + 1;
            loadList();
          },
        },
      })
    );
  }

  // ---- one game ------------------------------------------------------------------------

  function setHash(gameId) {
    var hash = '#/audit' + (gameId != null ? '/' + gameId : '');
    if (location.hash !== hash && history.replaceState) history.replaceState(null, '', hash);
  }

  /** The game a #/audit/<id> link names, or null. */
  function gameInHash() {
    var parts = String(location.hash || '').replace(/^#\/?/, '').split('/');
    return parts[0] === 'audit' && /^\d+$/.test(parts[1] || '') ? Number(parts[1]) : null;
  }

  // Opening a game from the list is a history entry, so Back returns to the
  // list; a #/audit/<id> link (or Back/Forward) opens or closes it in place.
  function openGame(id, fromHash) {
    st.gameId = Number(id);
    var hash = '#/audit/' + st.gameId;
    if (!fromHash && location.hash !== hash && history.pushState) history.pushState(null, '', hash);
    ui.listView.hidden = true;
    ui.detailView.hidden = false;
    window.scrollTo(0, 0);
    loadGame(st.gameId);
  }

  function closeGame() {
    st.gameId = null;
    st.detail = null;
    st.detailError = null;
    setHash(null);
    ui.detailView.hidden = true;
    ui.listView.hidden = false;
    if (!st.list && !st.error) loadList();
  }

  function loadGame(id) {
    st.detail = null;
    st.detailError = null;
    renderGame();
    ui.refresh.disabled = true;
    A.api.get('audit/games/' + encodeURIComponent(id)).then(
      function (res) {
        if (st.gameId !== id) return;
        ui.refresh.disabled = false;
        st.detail = res.data || null;
        renderGame();
      },
      function (err) {
        if (st.gameId !== id) return;
        ui.refresh.disabled = false;
        st.detailError = err;
        renderGame();
      }
    );
  }

  function renderGame() {
    var box = A.clear(ui.detailView);
    var back = h('button', {
      class: 'small',
      on: { click: closeGame },
    }, A.icon('arrow-left'), ' All games');
    box.appendChild(h('div', { class: 'audit-back' }, back));
    if (st.detailError) {
      box.appendChild(
        h(
          'div',
          { class: 'card' },
          st.detailError.status === 404 && st.detailError.code === 'NOT_FOUND'
            ? A.stateBox({ icon: 'search', title: 'No scored game #' + st.gameId, text: 'It may be a game that was never ranked.' })
            : A.errorBox(st.detailError, function () {
                loadGame(st.gameId);
              })
        )
      );
      return;
    }
    if (!st.detail) {
      box.appendChild(A.loadingBox(140));
      box.appendChild(h('div', { style: { height: '12px' } }));
      box.appendChild(A.loadingBox(260));
      return;
    }
    var g = st.detail;
    box.appendChild(headCard(g));
    box.appendChild(resultCard(g));
    box.appendChild(rulesCard(g));
    box.appendChild(networksCard(g));
    box.appendChild(historyCard(g));
  }

  function headCard(g) {
    var replay = h('button', { class: 'small primary' }, A.icon('play'), ' Replay');
    replay.onclick = function () {
      A.busy(replay, 'Looking…', function () {
        return findReplay(g);
      }).catch(function (e) {
        A.toastError('Replay', e);
      });
    };
    var verdict;
    if (!g.audited) {
      verdict = h(
        'div',
        { class: 'banner' },
        h('div', { class: 'grow' }, h('b', { text: 'Not audited. ' }), 'This game was scored before the audit existed: the results below come from the ledger, with no network or rule evidence.')
      );
    } else if (g.verdict) {
      verdict = h(
        'div',
        { class: 'banner err' },
        h('div', { class: 'grow' }, h('b', { text: VERDICTS[g.verdict] || 'Nobody scored (' + voidText(g.verdict) + ').' }))
      );
    } else if (g.voided_results) {
      verdict = h(
        'div',
        { class: 'banner warn' },
        h('div', { class: 'grow' }, h('b', { text: g.voided_results + ' of the results did not count. ' }), 'The players and reasons are below.')
      );
    } else if ((g.hits || []).length) {
      verdict = h(
        'div',
        { class: 'banner warn' },
        h('div', { class: 'grow' }, h('b', { text: 'A rule matched, but every result counted. ' }), 'See what the rules saw below.')
      );
    } else {
      verdict = h('div', { class: 'banner ok' }, h('div', { class: 'grow' }, h('b', { text: 'Clean. ' }), 'No fair-play rule matched; every result counted.'));
    }
    var stats = h(
      'div',
      { class: 'kv' },
      stat('Played', A.fmtDate(g.played_at) + ' (' + A.relTime(g.played_at) + ')'),
      stat('Table', tableText(g)),
      stat('Worth', '±' + A.fmtInt(g.points_value) + ' points'),
      stat('Ended', endText(g.reason) || 'played to the end'),
      stat('Match id', g.match_id || '—', g.match_id || 'the settlement named no match')
    );
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-h' },
        h('b', { text: 'Game #' + g.game_id }),
        h('span', { class: 'tag', text: (g.room && g.room.code) || 'room ?' }),
        h('div', { class: 'spacer' }),
        replay
      ),
      verdict,
      stats
    );
  }

  function stat(k, v, title) {
    return h('div', { class: 'stat', title: title || '' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
  }

  function resultCard(g) {
    var grid = h('div', { class: 'users2' });
    (g.teams || []).forEach(function (t) {
      var won = t.outcome === 'win';
      var cardBox = h(
        'div',
        { class: 'user-card' },
        h('div', { class: 'role' }, won ? 'Won' : 'Lost', (t.players || []).length > 1 ? ' — partners' : '')
      );
      (t.players || []).forEach(function (p) {
        cardBox.appendChild(
          h(
            'div',
            { class: 'aresult' },
            userButton(p.user),
            h(
              'div',
              { class: 'right' },
              pts(p.points_delta, p.counted),
              h('div', { class: 'why', text: p.counted ? 'counted' : voidText(p.void_reason) }),
              p.bet
                ? h('div', {
                    class: 'why ' + (p.coins_delta > 0 ? 'pos' : p.coins_delta < 0 ? 'neg' : ''),
                    text: A.signed(p.coins_delta) + ' coins',
                  })
                : null
            )
          )
        );
      });
      grid.appendChild(cardBox);
    });
    return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('b', { text: 'Result' }), h('span', { text: '· points as they stand now (a dismissed flag gives back what it voided)' })), grid);
  }

  /** A player chip that opens their networks. */
  function userButton(u, small) {
    var b = h('button', { class: 'chip-btn', title: 'Networks of ' + nameOf(u) }, A.userChip(u, small));
    b.onclick = function (e) {
      e.stopPropagation();
      if (u && u.id != null) openNetworks(u);
    };
    return b;
  }

  // ---- what the rules saw -------------------------------------------------------------

  function rulesCard(g) {
    var card = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('b', { text: 'What the rules saw' })));
    if (!g.audited) {
      card.appendChild(h('div', { class: 'hint', text: 'No audit for this game.' }));
      return card;
    }
    var who = people(g);
    var name = function (id) {
      return h('b', { text: nameOf(who[String(id)] || { id: id }) });
    };
    var hits = g.hits || [];
    if (!hits.length) {
      card.appendChild(h('div', { class: 'hint', text: 'No fair-play rule matched this game.' }));
    } else {
      var list = h('ul', { class: 'hit-list' });
      hits.forEach(function (hit) {
        var b = RULES[hit.rule] || { text: String(hit.rule || 'rule').replace(/_/g, ' '), cls: 'neutral' };
        list.appendChild(
          h(
            'li',
            null,
            badge(b.text, b.cls),
            h('div', { class: 'grow' }, hitSentence(hit, name)),
            effectBadge(hit.effect)
          )
        );
      });
      card.appendChild(list);
    }
    if (g.settings) card.appendChild(h('div', { class: 'hint', style: { marginTop: '10px' } }, judgedUnder(g.settings)));
    return card;
  }

  function effectBadge(effect) {
    if (effect === 'voided_game') return badge('voided the game', 'on');
    if (effect === 'voided_pair') return badge('voided the two', 'on');
    if (effect === 'voided_streak') return badge('voided the streak', 'on');
    return badge('no effect', 'neutral');
  }

  function net(network) {
    return network ? h('span', { class: 'addr', text: network }) : 'one network';
  }

  function hitSentence(hit, name) {
    var u = hit.users || [];
    var a = name(u[0]);
    var b = name(u[1]);
    var won = hit.side === 'win';
    switch (hit.rule) {
      case 'same_network':
        if (hit.relation === 'opponents')
          return [a, ' and ', b, ' played against each other from the same local network (', net(hit.network), '): neither gains nor loses points.'];
        return won
          ? [a, ' and ', b, ' are partners on one local network (', net(hit.network), ') and won: nobody at the table scores this game.']
          : [a, ' and ', b, ' are partners on one local network (', net(hit.network), ') and lost: their loss counts as usual.'];
      case 'frozen_pair_team':
        return won
          ? [a, ' and ', b, ' are a pair frozen for win-trading and won as partners: nobody scores this game.']
          : [a, ' and ', b, ' are a pair frozen for win-trading and lost as partners: the loss counts.'];
      case 'partner_cap':
        return [
          a,
          ' and ',
          b,
          ' had already played ' + hit.games_before + ' game' + (hit.games_before === 1 ? '' : 's') + ' together as partners in the window (cap ' + hit.cap + ')',
          won ? ': their win scores nobody.' : ': their loss counts as usual.',
        ];
      case 'lineup_cap': {
        var t = hit.teams || [[], []];
        return [
          'The same four — ',
          name(t[0][0]),
          ' + ',
          name(t[0][1]),
          ' against ',
          name(t[1][0]),
          ' + ',
          name(t[1][1]),
          ' — had already played ' + hit.games_before + ' game' + (hit.games_before === 1 ? '' : 's') + ' in these teams in the window (cap ' + hit.cap + '): nobody scores this game.',
        ];
      }
      case 'frozen_pair':
        return [a, ' and ', b, ' are a pair frozen for win-trading: the game does not count for either of them.'];
      case 'streak_flag':
        return [
          a,
          ' beat ',
          b,
          ' ' + (hit.streak_length || '?') + ' games in a row: flag #' +
            hit.flag_id +
            " was raised and the streak's points were voided (decide it under Review).",
        ];
      default:
        return [String(hit.rule || 'A rule').replace(/_/g, ' ') + ' matched ', a, u.length > 1 ? [' and ', b] : '', '.'];
    }
  }

  function windowText(hours) {
    var n = Number(hours) || 0;
    if (!n) return 'ever';
    if (n % 24 === 0) return 'per ' + (n === 24 ? 'day' : n / 24 + ' days');
    return 'per ' + n + ' hours';
  }

  function judgedUnder(s) {
    return [
      'Judged under: streak flag at ' + s.collusion_streak_threshold + ' wins in a row',
      'same-network rule ' + (Number(s.same_network_rule) === 1 ? 'on' : 'off'),
      Number(s.partner_cap_games) > 0 ? 'partners score ' + s.partner_cap_games + ' games ' + windowText(s.repeat_cap_window_hours) : 'no partner cap',
      Number(s.lineup_cap_games) > 0 ? 'the same four score ' + s.lineup_cap_games + ' games ' + windowText(s.repeat_cap_window_hours) : 'no line-up cap',
    ].join(' · ') + '.';
  }

  // ---- networks -------------------------------------------------------------------------

  function networksCard(g) {
    var card = h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-h' },
        h('b', { text: 'Networks' }),
        h('span', { text: "· where each player's requests came from while the table was live" })
      )
    );
    if (!g.audited) {
      card.appendChild(h('div', { class: 'hint', text: 'Not recorded for this game.' }));
      return card;
    }
    var who = people(g);
    var here = {};
    Object.keys(who).forEach(function (id) {
      here[id] = true;
    });
    var networks = g.networks || {};
    var neighbours = g.neighbours || {};
    var tbody = h('tbody');
    Object.keys(who).forEach(function (id) {
      var seen = networks[id] || [];
      if (!seen.length) {
        tbody.appendChild(
          h(
            'tr',
            null,
            h('td', null, userButton(who[id], true)),
            h('td', { attrs: { colspan: '4' }, class: 'hint', text: 'no public address seen (requests came through a proxy, or none while the table was live)' })
          )
        );
        return;
      }
      seen.forEach(function (n, i) {
        var nb = neighbours[n.network] || { players: 0, users: [] };
        var others = (nb.users || []).filter(function (x) {
          return x.user && !here[String(x.user.id)];
        });
        var mates = (nb.users || []).filter(function (x) {
          return x.user && here[String(x.user.id)] && String(x.user.id) !== id;
        });
        // nb.users is capped by the API; nb.players is everyone seen on it.
        var atTable = (nb.users || []).length - others.length;
        var more = Math.max(others.length, (Number(nb.players) || 0) - atTable) - Math.min(6, others.length);
        tbody.appendChild(
          h(
            'tr',
            { class: n.shared ? 'shared' : mates.length ? 'match' : '' },
            h('td', null, i === 0 ? userButton(who[id], true) : null),
            h(
              'td',
              null,
              h('div', { class: 'addr', text: n.ip || '—' }),
              n.network !== n.ip ? h('div', { class: 'hint addr', text: n.network }) : null
            ),
            h(
              'td',
              null,
              n.shared
                ? badge('public address', 'neutral', 'Many different players use it (a carrier gateway, a cafe, a proxy): it ties nobody together')
                : mates.length
                  ? h(
                      'div',
                      { class: 'chips' },
                      badge('shared with', 'on'),
                      mates.map(function (x) {
                        return h('span', { class: 'hint', text: nameOf(x.user) });
                      })
                    )
                  : h('span', { class: 'hint', text: 'only them at this table' })
            ),
            h('td', { class: 'nowrap hint', text: n.last_seen_at ? A.fmtDate(n.last_seen_at) : '—' }),
            h(
              'td',
              null,
              others.length
                ? h(
                    'div',
                    { class: 'chips' },
                    others.slice(0, 6).map(function (x) {
                      return userButton(x.user, true);
                    }),
                    more > 0 ? h('span', { class: 'hint', text: '+' + more + ' more' }) : null
                  )
                : h('span', { class: 'hint', text: 'nobody else (30 days)' })
            )
          )
        );
      });
    });
    card.appendChild(
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'audit-table nets' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['Player', 'Address', 'At this table', 'Last seen', 'Also seen on it (30 days)'].map(function (t) {
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
        text: 'An IPv4 address is one network (everyone behind one router shares it); an IPv6 address is grouped by its /64. Click a player for every network they were seen on.',
      })
    );
    return card;
  }

  // ---- history together -------------------------------------------------------------------

  function historyCard(g) {
    var who = people(g);
    var name = function (id) {
      return nameOf(who[String(id)] || { id: id });
    };
    var card = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-h' }, h('b', { text: 'History together' }), h('span', { text: '· every ranked game on record, this one included' }))
    );
    var pairs = g.pairs || [];
    if (!pairs.length) {
      card.appendChild(h('div', { class: 'hint', text: 'No pairs.' }));
      return card;
    }
    card.appendChild(
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'audit-table pairs' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['Pair', 'Here', 'As partners', 'Head-to-head', 'Streak', 'Pair'].map(function (t) {
                return h('th', { text: t });
              })
            )
          ),
          h(
            'tbody',
            null,
            pairs.map(function (p) {
              var u = p.users || [];
              return h(
                'tr',
                null,
                h('td', null, h('b', { text: name(u[0]) }), ' + ', h('b', { text: name(u[1]) })),
                h('td', null, badge(p.relation === 'partners' ? 'partners' : 'opponents', p.relation === 'partners' ? 'teamA' : 'neutral')),
                h('td', { class: 'num', text: A.fmtInt(p.games_as_partners) + ' game' + (p.games_as_partners === 1 ? '' : 's') }),
                h('td', { class: 'num', text: A.fmtInt(p.games_as_opponents) + ' game' + (p.games_as_opponents === 1 ? '' : 's') }),
                h('td', { class: 'num', text: p.streak_length ? name(p.streak_winner_user_id) + ' ×' + p.streak_length : '—' }),
                h('td', null, p.pair_flagged ? badge('frozen', 'on', 'Flagged by the streak guard (see Review)') : h('span', { class: 'hint', text: 'counting' }))
              );
            })
          )
        )
      )
    );
    if (g.lineup) {
      card.appendChild(
        h(
          'div',
          { class: 'hint', style: { marginTop: '8px' } },
          'These four in these teams: ',
          h('b', { text: A.fmtInt(g.lineup.games) + ' game' + (g.lineup.games === 1 ? '' : 's') }),
          ' on record.'
        )
      );
    }
    return card;
  }

  // ---- a player's networks -----------------------------------------------------------------

  function openNetworks(u) {
    var body = h('div', null, A.loadingBox(160));
    var showGames = h('button', {
      class: 'ghost',
      text: 'Show their games',
      on: {
        click: function () {
          m.close();
          st.user = String(u.id);
          ui.search.value = st.user;
          st.page = 1;
          st.only = 'all';
          ui.only.set('all');
          if (st.gameId != null) closeGame();
          loadList();
        },
      },
    });
    var m = A.modal({
      title: 'Networks of ' + nameOf(u),
      sub: 'Every network their Buraco requests came from (kept 90 days), and who else used it in the last 30 days.',
      wide: true,
      body: body,
      foot: [h('div', { class: 'spacer' }), showGames, h('button', { text: 'Close', on: { click: function () { m.close(); } } })],
    });
    A.api.get('audit/users/' + encodeURIComponent(u.id) + '/networks').then(
      function (res) {
        A.clear(body);
        var d = res.data || {};
        var list = d.networks || [];
        if (!list.length) {
          body.appendChild(h('div', { class: 'hint', text: 'No public address recorded for this player.' }));
          return;
        }
        var nb = d.neighbours || {};
        body.appendChild(
          h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'audit-table nets' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ['Address', 'First seen', 'Last seen', 'Also seen on it (30 days)'].map(function (t) {
                    return h('th', { text: t });
                  })
                )
              ),
              h(
                'tbody',
                null,
                list.map(function (n) {
                  var others = ((nb[n.network] || {}).users || []).filter(function (x) {
                    return x.user && String(x.user.id) !== String(u.id);
                  });
                  return h(
                    'tr',
                    { class: n.shared ? 'shared' : '' },
                    h(
                      'td',
                      null,
                      h('div', { class: 'addr', text: n.ip }),
                      n.network !== n.ip ? h('div', { class: 'hint addr', text: n.network }) : null,
                      n.shared ? badge('public address', 'neutral') : null
                    ),
                    h('td', { class: 'nowrap hint', text: A.fmtDate(n.first_seen_at) }),
                    h('td', { class: 'nowrap hint', text: A.fmtDate(n.last_seen_at) }),
                    h(
                      'td',
                      null,
                      others.length
                        ? h(
                            'div',
                            { class: 'chips' },
                            others.map(function (x) {
                              return h('span', { class: 'nchip', text: nameOf(x.user), title: chipTitle(x.user) });
                            }),
                            (nb[n.network] || {}).players - 1 > others.length
                              ? h('span', { class: 'hint', text: '+' + ((nb[n.network] || {}).players - 1 - others.length) + ' more' })
                              : null
                          )
                        : h('span', { class: 'hint', text: 'nobody else' })
                    )
                  );
                })
              )
            )
          )
        );
      },
      function (err) {
        A.clear(body).appendChild(A.errorBox(err));
      }
    );
  }

  // ---- replay ------------------------------------------------------------------------------

  function findReplay(g) {
    var qs = g.match_id
      ? 'backendMatchId=' + encodeURIComponent(g.match_id)
      : 'playerIds=' +
        encodeURIComponent(idsOf(g).join(',')) +
        '&at=' +
        encodeURIComponent(g.played_at) +
        '&windowMs=2700000&limit=3';
    return DC.api('/dev/api/matches?' + qs).then(function (res) {
      var rows = (res && res.matches) || [];
      if (!rows.length) {
        throw new Error(
          'this socket has no recording of it (played on another node, before replays were kept, or past their retention)'
        );
      }
      return DC.openReplay(rows[0].matchId, rows[0].roomId);
    });
  }

  // ---- page --------------------------------------------------------------------------------

  // The console routes only between sections; a hash change inside this one
  // (a pasted link, Back from a game) is ours to follow.
  window.addEventListener('hashchange', function () {
    if (A.current() !== 'audit' || !ui.listView) return;
    if (String(location.hash || '').replace(/^#\/?/, '').split('/')[0] !== 'audit') return;
    var wanted = gameInHash();
    if (wanted != null && wanted !== st.gameId) openGame(wanted, true);
    else if (wanted == null && st.gameId != null) closeGame();
  });

  A.registerPage('audit', {
    mount: mount,
    show: function () {
      var wanted = gameInHash();
      if (wanted != null) {
        openGame(wanted, true);
        return;
      }
      if (st.gameId != null) {
        setHash(st.gameId);
        loadGame(st.gameId);
        return;
      }
      loadList();
    },
  });
})();

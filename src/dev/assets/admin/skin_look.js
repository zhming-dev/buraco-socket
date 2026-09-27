/* eslint-env browser */
/* eslint no-var: "off", indent: "off", quotes: ["error", "single", { "avoidEscape": true }] --
   ES5 like the console's inline script (no build step); Prettier owns the layout. */
/**
 * The Buraco engine's built-in looks, MIRRORED from the SDK so the admin pages
 * draw a real preview instead of a colour guess (window.SkinLook):
 *   wlive-app buraco_sdk/lib/models/game_skin.dart        table themes
 *   wlive-app buraco_sdk/lib/models/card_back_style.dart  generated backs
 *   wlive-app buraco_sdk/lib/models/card_face_style.dart  card faces
 * Token names ARE the Dart enum names — exactly what the socket carries in a
 * `skins` map. The pickers offer what wlive-api accepts (GET skin-tokens); this
 * file only knows how each token LOOKS. A token it does not know is still
 * shown, flagged "no preview".
 *
 * Honest about its limits: the backs are painted by Dart (CardBackPainter), so
 * the pattern here is a CSS stand-in over the SAME colours; anything uploaded
 * (table image, card back image) is shown exactly as it ships.
 */
(function () {
  'use strict';

  var THEMES = [
    ['ocean', 'Teal', '#16272B', '#9FC0C6', '#EAF1F2', '#5E858E', '#23434B'],
    ['forest', 'Forest', '#17251E', '#A2C4AE', '#ECF3EE', '#5E8770', '#244434'],
    ['burgundy', 'Burgundy', '#27171A', '#C6A0A7', '#F4EBEC', '#8B6068', '#44262C'],
    ['graphite', 'Graphite', '#1D1F22', '#ADB2BA', '#EFF0F2', '#6E747D', '#32373E'],
    ['sand', 'Sand', '#262117', '#C8B792', '#F3EFE5', '#8A7952', '#443A24'],
    ['plum', 'Plum', '#201A28', '#B2A2C0', '#F0ECF3', '#75658A', '#3A2E48'],
    ['midnight', 'Midnight', '#080B14', '#1B2340', '#3E4E82', '#3B4874', '#C8D2F0'],
    ['obsidian', 'Obsidian', '#0A0B0D', '#1D2024', '#434A55', '#3C424B', '#D2D6DE'],
    ['wine', 'Wine', '#14080B', '#35161D', '#6D3543', '#612D39', '#EBC7CF'],
    ['pine', 'Pine', '#07110C', '#16301F', '#356241', '#2E553A', '#C6E2CE'],
    ['espresso', 'Espresso', '#130E08', '#2E2118', '#5E4632', '#503C2B', '#E4D2BC'],
    ['braziliaPlus', 'Brazilia Plus', '#12060A', '#4A1226', '#8A2A4A', '#D4A64A', '#F2D7A8'],
  ].map(function (r) {
    return {
      value: r[0],
      label: r[1],
      outer: r[2],
      felt: r[3],
      wash: r[4],
      border: r[5],
      onFelt: r[6],
    };
  });

  // value, label, pattern, base, deep, ink, frame, accent
  var BACKS = [
    [
      'crimsonLattice',
      'Crimson',
      'diamondLattice',
      '#B3202C',
      '#7C1220',
      '#FFD9DC',
      '#F6F1EA',
      '#F2C94C',
    ],
    ['royalDamask', 'Royal', 'damask', '#1F3C88', '#122354', '#C9D8FF', '#F2F4FA', '#E8C46A'],
    [
      'emeraldWeave',
      'Emerald',
      'basketWeave',
      '#11694F',
      '#0A4234',
      '#BFF0DC',
      '#F1F7F3',
      '#E9D08A',
    ],
    ['amberDeco', 'Amber', 'decoFan', '#B07A16', '#7A4E08', '#FFECC0', '#FBF3E2', '#FFF6DC'],
    [
      'violetGuilloche',
      'Violet',
      'guilloche',
      '#5B2E8C',
      '#361A57',
      '#E4D2FF',
      '#F5F0FA',
      '#F3C9F0',
    ],
    [
      'midnightStars',
      'Midnight Stars',
      'starfield',
      '#16214A',
      '#0B1230',
      '#DCE4FF',
      '#EFF2FA',
      '#F3D77A',
    ],
    [
      'tealWaves',
      'Teal Waves',
      'chevronWave',
      '#10707A',
      '#08464E',
      '#C5F2F5',
      '#EFF8F8',
      '#FFE7A8',
    ],
    [
      'roseHerringbone',
      'Rose',
      'herringbone',
      '#B03A67',
      '#7A2245',
      '#FFD7E6',
      '#FDF0F4',
      '#FFE9B8',
    ],
    ['carbonSlate', 'Carbon', 'carbonGrid', '#32363E', '#1B1E24', '#B9C0CC', '#DDE1E8', '#8FD3FF'],
    ['sunsetTartan', 'Tartan', 'tartan', '#B4451C', '#7C2810', '#FFDCC0', '#FBEFE4', '#FFE2A0'],
    [
      'braziliaPlus',
      'Brazilia Plus',
      'crest',
      '#7A1030',
      '#3F0818',
      '#F3D27A',
      '#F7EDD8',
      '#F2C94C',
    ],
    [
      'sapphireQuatrefoil',
      'Sapphire',
      'quatrefoil',
      '#1F4FA3',
      '#10306B',
      '#CFE0FF',
      '#F1F5FC',
      '#EAD27E',
    ],
    [
      'bronzeHoneycomb',
      'Bronze',
      'honeycomb',
      '#8A5A1E',
      '#4F3110',
      '#FFE3A8',
      '#FAF2E3',
      '#FFF0C8',
    ],
    ['jadeScales', 'Jade', 'scales', '#1E7F6A', '#0E4A3E', '#C8F5E6', '#EFF9F5', '#F0E1A0'],
    ['noirArgyle', 'Noir', 'argyle', '#23252B', '#0F1013', '#D9DCE3', '#E6E8EC', '#C9CDD6'],
    [
      'neonCircuit',
      'Neon Circuit',
      'circuit',
      '#0B1F3A',
      '#051022',
      '#63F2FF',
      '#E9F6FA',
      '#9AF7FF',
    ],
    [
      'nebulaConstellation',
      'Nebula',
      'constellation',
      '#3B1D6E',
      '#1A0B38',
      '#F1E4FF',
      '#F4EEFC',
      '#FFB3E6',
    ],
    ['onyxMarble', 'Onyx', 'marble', '#17171A', '#060607', '#E9D9A6', '#E8E4DA', '#E9C46A'],
    ['copperSunburst', 'Copper', 'sunburst', '#A0522D', '#5E2D14', '#FFE0C8', '#FBF0E8', '#FFE8B0'],
  ].map(function (r) {
    return {
      value: r[0],
      label: r[1],
      pattern: r[2],
      base: r[3],
      deep: r[4],
      ink: r[5],
      frame: r[6],
      accent: r[7],
    };
  });

  var INK_OPACITY = {
    carbonGrid: 0.16,
    tartan: 0.22,
    starfield: 0.42,
    guilloche: 0.3,
    argyle: 0.18,
    sunburst: 0.22,
    scales: 0.3,
    honeycomb: 0.32,
    quatrefoil: 0.32,
    marble: 0.48,
    constellation: 0.55,
    circuit: 0.6,
    crest: 0.55,
  };

  // value, label, stock, stockEnd, border, hearts, diamonds, clubs, spades
  var FACES = [
    [
      'leftIndex',
      'Left Index',
      '#F7F6F3',
      null,
      '#9AA0A8',
      '#DF3327',
      '#DF3327',
      '#202124',
      '#202124',
    ],
    ['printed', 'Printed', '#FBFBF9', null, '#B7B2A8', '#DF3327', '#DF3327', '#202124', '#202124'],
    ['cream', 'Cream', '#F6E7BF', null, '#C9B27A', '#DF3327', '#DF3327', '#202124', '#202124'],
    ['snow', 'Snow', '#FFFFFF', null, '#C4C4C4', '#DF3327', '#DF3327', '#202124', '#202124'],
    ['silver', 'Silver', '#F2F2F2', null, '#B9BCC2', '#DF3327', '#DF3327', '#202124', '#202124'],
    ['classic', 'Classic', '#FDFCFA', null, '#B7B2A8', '#DF3327', '#DF3327', '#202124', '#202124'],
    [
      'bigCorner',
      'Big Corner',
      '#FFFFFF',
      null,
      '#C9C6C0',
      '#DF3327',
      '#DF3327',
      '#202124',
      '#202124',
    ],
    [
      'fourColour',
      'Four Colour',
      '#F7F6F3',
      null,
      '#9AA0A8',
      '#DF3327',
      '#E08A17',
      '#1E7A4B',
      '#202124',
    ],
    ['ivory', 'Ivory', '#F5F0E4', null, '#C9A34E', '#B3312A', '#B3312A', '#2A2622', '#2A2622'],
    ['night', 'Night', '#23262C', null, '#434955', '#FF6B5E', '#FF6B5E', '#E8E6E1', '#E8E6E1'],
    ['jumbo', 'Jumbo', '#FFFFFF', null, '#AEB3BA', '#E01F1A', '#E01F1A', '#101114', '#101114'],
    ['neon', 'Neon', '#14161C', '#1D212B', '#3A4152', '#FF4D6D', '#FFC94D', '#2DE0A5', '#6FD3FF'],
    [
      'parchment',
      'Parchment',
      '#F1E3C3',
      '#E4D2A8',
      '#A9905F',
      '#9E2B25',
      '#9E2B25',
      '#3B2E20',
      '#3B2E20',
    ],
    [
      'contrast',
      'Contrast',
      '#FFF4C2',
      null,
      '#101114',
      '#C40017',
      '#C40017',
      '#000000',
      '#000000',
    ],
    [
      'emerald',
      'Emerald',
      '#0E3B2E',
      '#124A39',
      '#C9A34E',
      '#FF7A6B',
      '#FF7A6B',
      '#F2ECDC',
      '#F2ECDC',
    ],
  ].map(function (r) {
    return {
      value: r[0],
      label: r[1],
      stock: r[2],
      stockEnd: r[3],
      border: r[4],
      suits: { hearts: r[5], diamonds: r[6], clubs: r[7], spades: r[8] },
    };
  });

  function find(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i];
    return null;
  }

  function rgba(hex, alpha) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(255,255,255,' + alpha + ')';
    return (
      'rgba(' +
      parseInt(m[1], 16) +
      ',' +
      parseInt(m[2], 16) +
      ',' +
      parseInt(m[3], 16) +
      ',' +
      alpha +
      ')'
    );
  }

  /** CSS stand-in for the Dart-painted pattern, over the back's own colours. */
  function backField(b) {
    var a = INK_OPACITY[b.pattern] || 0.34;
    var ink = rgba(b.ink, a);
    var inkSoft = rgba(b.ink, a * 0.6);
    var ground = 'linear-gradient(180deg, ' + b.base + ', ' + b.deep + ')';
    var p;
    switch (b.pattern) {
      case 'diamondLattice':
        p =
          'repeating-linear-gradient(45deg, ' +
          ink +
          ' 0 1px, transparent 1px 7px), repeating-linear-gradient(-45deg, ' +
          ink +
          ' 0 1px, transparent 1px 7px)';
        break;
      case 'damask':
        p =
          'radial-gradient(' +
          ink +
          ' 1.6px, transparent 2px) 0 0 / 9px 9px, radial-gradient(' +
          inkSoft +
          ' 1px, transparent 1.4px) 4.5px 4.5px / 9px 9px';
        break;
      case 'basketWeave':
        p =
          'repeating-linear-gradient(0deg, ' +
          ink +
          ' 0 2px, transparent 2px 7px), repeating-linear-gradient(90deg, ' +
          inkSoft +
          ' 0 2px, transparent 2px 7px)';
        break;
      case 'decoFan':
        p =
          'repeating-conic-gradient(from -90deg at 50% 100%, ' +
          ink +
          ' 0 5deg, transparent 5deg 15deg)';
        break;
      case 'guilloche':
        p = 'repeating-radial-gradient(circle at 50% 50%, ' + ink + ' 0 1px, transparent 1px 4px)';
        break;
      case 'starfield':
        p =
          'radial-gradient(' +
          ink +
          ' 1px, transparent 1.3px) 0 0 / 8px 8px, radial-gradient(' +
          inkSoft +
          ' 0.8px, transparent 1.1px) 3px 5px / 11px 11px';
        break;
      case 'chevronWave':
        p = 'repeating-radial-gradient(circle at 50% 120%, ' + ink + ' 0 1px, transparent 1px 6px)';
        break;
      case 'herringbone':
        p =
          'repeating-linear-gradient(60deg, ' +
          ink +
          ' 0 1px, transparent 1px 5px), repeating-linear-gradient(-60deg, ' +
          inkSoft +
          ' 0 1px, transparent 1px 9px)';
        break;
      case 'carbonGrid':
        p =
          'repeating-linear-gradient(0deg, ' +
          ink +
          ' 0 1px, transparent 1px 4px), repeating-linear-gradient(90deg, ' +
          ink +
          ' 0 1px, transparent 1px 4px)';
        break;
      case 'tartan':
        p =
          'repeating-linear-gradient(0deg, ' +
          ink +
          ' 0 3px, transparent 3px 10px), repeating-linear-gradient(90deg, ' +
          ink +
          ' 0 3px, transparent 3px 10px)';
        break;
      case 'quatrefoil':
        p =
          'radial-gradient(circle at 30% 30%, ' +
          ink +
          ' 0 18%, transparent 20%) 0 0 / 10px 10px, radial-gradient(circle at 70% 70%, ' +
          ink +
          ' 0 18%, transparent 20%) 0 0 / 10px 10px';
        break;
      case 'honeycomb':
        p =
          'radial-gradient(circle, transparent 45%, ' +
          ink +
          ' 48%, transparent 58%) 0 0 / 10px 9px, radial-gradient(circle, transparent 45%, ' +
          inkSoft +
          ' 48%, transparent 58%) 5px 4.5px / 10px 9px';
        break;
      case 'scales':
        p =
          'radial-gradient(circle at 50% 0, transparent 55%, ' +
          ink +
          ' 58%, transparent 66%) 0 0 / 10px 8px, radial-gradient(circle at 50% 0, transparent 55%, ' +
          ink +
          ' 58%, transparent 66%) 5px 4px / 10px 8px';
        break;
      case 'argyle':
        p =
          'repeating-linear-gradient(60deg, ' +
          ink +
          ' 0 1px, transparent 1px 12px), repeating-linear-gradient(-60deg, ' +
          ink +
          ' 0 1px, transparent 1px 12px), linear-gradient(90deg, ' +
          inkSoft +
          ', transparent 70%)';
        break;
      case 'circuit':
        p =
          'radial-gradient(' +
          ink +
          ' 1.2px, transparent 1.6px) 2px 2px / 12px 12px, repeating-linear-gradient(0deg, ' +
          inkSoft +
          ' 0 1px, transparent 1px 12px), repeating-linear-gradient(90deg, ' +
          inkSoft +
          ' 0 1px, transparent 1px 18px)';
        break;
      case 'constellation':
        p =
          'radial-gradient(' +
          ink +
          ' 1.1px, transparent 1.5px) 0 0 / 13px 11px, radial-gradient(' +
          inkSoft +
          ' 0.8px, transparent 1.1px) 6px 4px / 9px 14px, linear-gradient(30deg, transparent 48%, ' +
          inkSoft +
          ' 49%, transparent 51%)';
        break;
      case 'marble':
        p =
          'linear-gradient(115deg, transparent 38%, ' +
          ink +
          ' 40%, transparent 44%), linear-gradient(35deg, transparent 60%, ' +
          inkSoft +
          ' 61%, transparent 64%), linear-gradient(160deg, transparent 20%, ' +
          inkSoft +
          ' 21%, transparent 23%)';
        break;
      case 'sunburst':
        p =
          'repeating-conic-gradient(from 0deg at 50% 50%, ' +
          ink +
          ' 0 6deg, transparent 6deg 18deg)';
        break;
      case 'crest':
        p =
          'repeating-conic-gradient(from 0deg at 50% 50%, ' +
          ink +
          ' 0 4deg, transparent 4deg 16deg), radial-gradient(circle, ' +
          inkSoft +
          ' 0 22%, transparent 24%)';
        break;
      default:
        p = 'radial-gradient(' + ink + ' 1.5px, transparent 2px) 0 0 / 10px 10px';
    }
    return p + ', ' + ground;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function cssUrl(u) {
    return window.BuracoAdmin ? window.BuracoAdmin.cssUrl(u) : 'none';
  }

  function faceCard(face, rank, suit) {
    var glyph = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' }[suit];
    var c = el('div', 'lk-card lk-face');
    c.style.background = face.stockEnd
      ? 'linear-gradient(180deg, ' + face.stock + ', ' + face.stockEnd + ')'
      : face.stock;
    c.style.border = '1px solid ' + face.border;
    c.style.color = face.suits[suit];
    c.appendChild(el('span', 'r', rank));
    c.appendChild(el('span', 's', glyph));
    c.appendChild(el('span', 'r2', rank));
    c.title = face.label + ' face';
    return c;
  }

  /**
   * The preview: surround, felt (theme or uploaded image), frame, a deck back,
   * two faces, and chips saying which slots the skins map holds (the rest stay
   * each player's own).
   * @param {object} skins  wire map: table_skin, card_skin, table_theme, card_back_style, card_face_style
   * @param {{small?: boolean, chips?: boolean, heldLabel?: string, ownLabel?: string}} [opts]
   */
  function render(skins, opts) {
    skins = skins || {};
    opts = opts || {};
    var themeToken = skins.table_theme || null;
    var backToken = skins.card_back_style || null;
    var faceToken = skins.card_face_style || null;
    var theme = find(THEMES, themeToken) || THEMES[0];
    var back = find(BACKS, backToken) || BACKS[0];
    var face = find(FACES, faceToken) || FACES[0];
    var tableImg = window.BuracoAdmin ? window.BuracoAdmin.safeUrl(skins.table_skin) : null;
    var backImg = window.BuracoAdmin ? window.BuracoAdmin.safeUrl(skins.card_skin) : null;

    var wrap = el('div', 'lk');
    var board = el('div', 'lk-board' + (opts.small ? ' small' : ''));
    board.style.background = theme.outer;
    var felt = el('div', 'lk-felt');
    felt.style.border = '2px solid ' + theme.border;
    felt.style.background = tableImg
      ? cssUrl(tableImg) + ' center / cover no-repeat, ' + theme.felt
      : 'radial-gradient(ellipse at 50% 18%, ' + theme.wash + ' 0%, ' + theme.felt + ' 72%)';
    if (!tableImg) {
      var divider = el('div', 'lk-divider');
      divider.style.background = theme.onFelt;
      felt.appendChild(divider);
    }
    var name = el('span', 'lk-name', tableImg ? 'table image' : theme.label);
    name.style.color = tableImg ? '#fff' : theme.onFelt;
    if (tableImg) name.style.textShadow = '0 0 3px #000';
    felt.appendChild(name);

    var cards = el('div', 'lk-cards');
    var backCard = el('div', 'lk-card lk-back' + (backImg ? ' img' : ''));
    if (backImg) {
      backCard.style.backgroundImage = cssUrl(backImg);
      backCard.title = 'uploaded card back';
    } else {
      backCard.style.background = back.frame;
      var fieldEl = el('div', 'lk-field');
      fieldEl.style.background = backField(back);
      var medal = el('div', 'lk-medal');
      medal.style.border = '1.5px solid ' + back.accent;
      medal.style.background = rgba(back.deep, 0.6);
      backCard.appendChild(fieldEl);
      backCard.appendChild(medal);
      backCard.title = back.label + ' back';
    }
    cards.appendChild(backCard);
    cards.appendChild(faceCard(face, 'A', 'hearts'));
    cards.appendChild(faceCard(face, 'K', 'spades'));
    if (!opts.small) cards.appendChild(faceCard(face, '7', 'diamonds'));
    felt.appendChild(cards);
    board.appendChild(felt);
    wrap.appendChild(board);

    if (opts.chips !== false) {
      var chips = el('div', 'lk-chips');
      var own = opts.ownLabel || "player's own";
      var chip = function (held, text, unknown) {
        chips.appendChild(
          el('span', 'lk-chip' + (unknown ? ' unknown' : held ? ' held' : ''), text)
        );
      };
      if (tableImg) chip(true, 'table: uploaded image');
      else if (themeToken)
        chip(
          true,
          'table: ' + (find(THEMES, themeToken) ? theme.label : themeToken + ' (no preview)'),
          !find(THEMES, themeToken)
        );
      else chip(false, 'table: ' + own);
      if (backImg) chip(true, 'back: uploaded image');
      else if (backToken)
        chip(
          true,
          'back: ' + (find(BACKS, backToken) ? back.label : backToken + ' (no preview)'),
          !find(BACKS, backToken)
        );
      else chip(false, 'back: ' + own);
      if (faceToken)
        chip(
          true,
          'face: ' + (find(FACES, faceToken) ? face.label : faceToken + ' (no preview)'),
          !find(FACES, faceToken)
        );
      else chip(false, 'face: ' + own);
      wrap.appendChild(chips);
    }
    return wrap;
  }

  /** Label of a token for a slot ('table_theme' | 'card_back_style' | 'card_face_style'). */
  function label(slot, value) {
    var list = slot === 'table_theme' ? THEMES : slot === 'card_back_style' ? BACKS : FACES;
    var t = find(list, value);
    return t ? t.label : value;
  }

  /**
   * Picker options per slot: wlive-api's GET skin-tokens when it answered (what
   * it will accept), else this mirror.
   */
  function options(slot, apiTokens) {
    var fromApi = apiTokens && Array.isArray(apiTokens[slot]) ? apiTokens[slot] : null;
    if (fromApi && fromApi.length) {
      return fromApi.map(function (t) {
        return { value: t.value, label: t.label || label(slot, t.value) };
      });
    }
    var list = slot === 'table_theme' ? THEMES : slot === 'card_back_style' ? BACKS : FACES;
    return list.map(function (t) {
      return { value: t.value, label: t.label };
    });
  }

  window.SkinLook = {
    THEMES: THEMES,
    BACKS: BACKS,
    FACES: FACES,
    render: render,
    label: label,
    options: options,
    WIRE_KEYS: ['table_skin', 'card_skin', 'table_theme', 'card_back_style', 'card_face_style'],
  };
})();

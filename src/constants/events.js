/**
 * Socket.IO Event Names
 * Centralized event name constants to avoid typos and ensure consistency
 */

const SocketEvents = {
  // Connection events
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',
  ERROR: 'error',

  // Room events
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  PLAYER_JOINED: 'player_joined',
  PLAYER_LEFT: 'player_left',
  PLAYER_DISCONNECTED: 'player_disconnected',
  PLAYER_RECONNECTED: 'player_reconnected',
  HOST_CHANGED: 'host_changed',
  // Payload: { reason, message?, timestamp }. `reason` values a client may see:
  // host_left / host_heartbeat_timeout (lobby died with its host),
  // backend_cancelled (backend cancel-room), inactive / closed (server sweeps),
  // admin_closed (dev console "Close game"), maintenance / server_restart (ops
  // notice — arrives right after `development`), abandoned (the room's last
  // player took a seat elsewhere and nobody was left). All of them mean: leave
  // the table, no result — the backend has been told to de-list / refund.
  ROOM_CLOSED: 'room_closed',
  // Lobby settings edit: when the host PATCHes room settings the backend
  // re-syncs via /webhooks/sync-room; for a WAITING (lobby) room whose
  // client-visible settings actually changed, the server fans the new values
  // out to everyone in the room so the lobby/edit sheet updates live. Never
  // emitted for in-progress rooms or no-op syncs (join/heartbeat/normal sync).
  // Payload: { roomId, name, visibility, targetScore, turnTimeLimitSeconds,
  //   professionalWellMode, chatEnabled, hasPassword }.
  ROOM_SETTINGS_CHANGED: 'room_settings_changed',
  // Application-level host heartbeat for lobby/WAITING rooms. The server pings the
  // host socket every interval; the host pongs. After N consecutive missed pongs
  // the server kills the stuck lobby room (host swiped/killed the app). See
  // brazilia_host_heartbeat_contract.md.
  HOST_HEARTBEAT_PING: 'host_heartbeat_ping', // S → host socket: { roomId, seq, ts }
  HOST_HEARTBEAT_PONG: 'host_heartbeat_pong', // host → S: { roomId, seq }
  SPECTATORS_CHANGED: 'spectators_changed',
  // Admin skin override (PTW skins-admin): the server decides which skins a
  // table shows. Effective skins = per-game override (dies with the room) →
  // global override (has an expiry) → the room owner's own skins → none (each
  // client keeps its local choice). Fanned out to players AND spectators the
  // moment an override is set, cleared or expires — mid-game included — and
  // carried in every state payload (`skins`, `skinsSource`, `skinsExpiresAt`)
  // so reconnects and late joins converge. Payload: { roomId, skins,
  //   skinsSource: 'admin_room'|'admin_global'|'owner'|'none',
  //   skinsExpiresAt: ISO|null, reason, timestamp }.
  SKINS_UPDATED: 'skins_updated',
  INVITE_BOT: 'invite_bot',
  BOT_INVITED: 'bot_invited',
  REMOVE_BOT: 'remove_bot',
  BOT_REMOVED: 'bot_removed',
  REPLACE_WITH_BOT: 'replace_with_bot',
  REPLACED_WITH_BOT: 'replaced_with_bot',

  // Game lifecycle events
  START_GAME: 'start_game',
  // Host asks to begin the next round NOW instead of waiting out the
  // between-rounds window. Same code path as the timer; it just fires early.
  START_NEXT_ROUND: 'start_next_round',
  GAME_STARTED: 'game_started',
  DEAL_CARDS: 'deal_cards',
  // Sent by a client once its initial deal ANIMATION has finished playing, so the
  // server starts the first turn's timer only after the deal is visible (not the
  // instant cards are dealt, which made the clock count down behind the deal).
  DEAL_ANIMATION_COMPLETE: 'deal_animation_complete',
  GAME_ENDED: 'game_ended',
  ROUND_ENDED: 'round_ended',
  GAME_STATE_UPDATE: 'game_state_update',

  // Game action events
  DRAW_CARD: 'draw_card',
  CARD_DRAWN: 'card_drawn',
  PLAY_MELD: 'play_meld',
  MELD_PLAYED: 'meld_played',
  DISCARD_CARD: 'discard_card',
  CARD_DISCARDED: 'card_discarded',
  GO_DOWN: 'go_down',
  WENT_DOWN: 'went_down',
  ADD_TO_MELD: 'add_to_meld',
  ADDED_TO_MELD: 'added_to_meld',
  PICK_UP_PILE: 'pick_up_pile',
  PILE_PICKED_UP: 'pile_picked_up',
  DISCARD_PILE_TAKEN: 'discard_pile_taken', // Client-expected event name for pile pickup
  TAKE_POZZETTO: 'take_pozzetto',
  POZZETTO_TAKEN: 'pozzetto_taken',

  // Turn events
  TURN_CHANGED: 'turn_changed',
  TURN_COMPLETED: 'turn_completed', // Atomic event combining discard + turn change

  // Turn timer events (server-authoritative)
  TURN_TIMER_STARTED: 'turn_timer_started',
  TURN_TIMER_TICK: 'turn_timer_tick',
  TURN_TIMER_EXPIRED: 'turn_timer_expired',

  // Undo meld
  UNDO_MELD: 'undo_meld',
  MELD_UNDONE: 'meld_undone',

  // Chat events (in-game chat, socket-only — not part of the app/backend layer)
  CHAT_MESSAGE: 'chat_message', // server → all clients in room (a chat was sent)
  SEND_CHAT_MESSAGE: 'send_chat_message', // client → server (post a chat)
  GET_CHAT_HISTORY: 'get_chat_history', // client → server (request backlog)
  CHAT_HISTORY: 'chat_history', // server → requesting client (backlog snapshot)

  // Direct-message (social DM) events. User-scoped, NOT room-scoped: the backend
  // POSTs /webhooks/direct-message on Message create and the server fans the
  // payload out to the recipient's (and sender's other) authenticated sockets via
  // the per-user room `user:{userId}`. Replaces the mobile's 5s HTTP poll (PTW-50).
  DIRECT_MESSAGE: 'direct_message', // server → recipient/sender devices (new DM)

  // Client telemetry: emitted by mobile when its stuck-UI animation-flag watchdog
  // fires (an animation flag stayed set past its safety window and was force-
  // cleared). Server-side this only increments an observability counter so prod
  // can alert on a spike in stuck-animation events (PTW-81). Carries no game
  // authority — payload is { reason } and is sanitized to a small allowlist.
  CLIENT_ANIM_WATCHDOG: 'client_anim_watchdog', // client → server (watchdog fired)

  // Ops/development broadcast. Server → EVERY connected socket (global, not
  // room-scoped): the operator put the game under maintenance or announced an
  // imminent server restart. Clients stop the active game/lobby session when
  // either flag is set. Payload: { maintenance_mode: bool, restart_server: bool,
  // message?: string }. Triggered via POST /webhooks/development (x-webhook-secret).
  // When either flag is true the server ALSO voids every live room right after
  // this notice: each table gets ROOM_CLOSED { reason: 'maintenance' |
  // 'server_restart', message } and is deleted, so nothing is restored after the
  // restart and nobody stays bound to a table their app has left.
  DEVELOPMENT: 'development',
  // Graceful restart drain (deploy). Sent to every socket right before the
  // process closes them on purpose; the game state is snapshotted and resumes
  // on the next boot. Clients should keep the session, let the socket
  // auto-reconnect, then re-emit join_room (+ get_game_state) as on any resume.
  SERVER_RESTARTING: 'server_restarting',

  // Dev-only hand surgery. operator → server (socket event, requires the
  // webhook secret in `secret`), server → operator (result ack). REPLACES a
  // target player's whole hand with the requested cards, pulled from the deck,
  // the target's own hand, or the wells — never from other hands, melds or the
  // discard pile. A fresh game_state_update is broadcast to the room after the
  // swap. Also triggerable via POST /webhooks/dev-change-cards.
  DEV_CHANGE_CARDS: 'dev_change_cards', // operator → S: { roomId, target_user, change_cards, secret }
  DEV_CHANGE_CARDS_RESULT: 'dev_change_cards_result', // S → operator: changePlayerCards() result
};

Object.freeze(SocketEvents);

module.exports = SocketEvents;

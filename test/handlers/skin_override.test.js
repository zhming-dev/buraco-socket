/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents } = require('../../src/constants');
const GameService = require('../../src/services/GameService');

describe('SocketHandlers admin skin override', () => {
  const createSocketMock = (id) => {
    const emitted = [];
    return {
      id,
      handshake: { headers: {} },
      data: {},
      join: () => {},
      leave: () => {},
      to: () => ({ emit: () => {} }),
      emit: (event, payload) => emitted.push({ event, payload }),
      get emitted() {
        return emitted;
      },
    };
  };
  const createIoMock = (sockets = []) => {
    const io = {
      roomEmits: [],
      sockets: { sockets: new Map(sockets.map((s) => [s.id, s])) },
      to: (roomId) => ({
        emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }),
      }),
    };
    return io;
  };
  const setup = () => {
    const service = new GameService();
    const s1 = createSocketMock('s1');
    const s2 = createSocketMock('s2');
    const spec = createSocketMock('spec');
    const io = createIoMock([s1, s2, spec]);
    const handler = new SocketHandlers(io, service);
    const room = service.createRoom('skin-room', 2);
    service.joinRoom('skin-room', 'p1', 'P1', 's1');
    service.joinRoom('skin-room', 'p2', 'P2', 's2');
    room.skins = { table_skin: 'https://cdn/owner-table.png' };
    handler._getRoomSpectators('skin-room').set('spec', {
      spectatorId: 'v1',
      spectatorName: 'Viewer',
      avatarUrl: null,
    });
    return { service, handler, room, io, s1, spec };
  };
  const skinEvents = (io) => io.roomEmits.filter((e) => e.event === SocketEvents.SKINS_UPDATED);
  let ctx;
  afterEach(() => {
    if (ctx) {
      ctx.handler._armGlobalSkinOverrideTimer && (ctx.handler.globalSkinOverride = null);
      ctx.handler._armGlobalSkinOverrideTimer();
      ctx.service.shutdown();
      ctx = null;
    }
  });

  it('shows the owner skins when nothing is overridden', () => {
    ctx = setup();
    const fields = ctx.handler._skinsPayloadFields(ctx.room);
    expect(fields.skins).to.deep.equal({ table_skin: 'https://cdn/owner-table.png' });
    expect(fields.skinsSource).to.equal('owner');
    expect(fields.skinsExpiresAt).to.equal(null);
  });

  it('a room override wins, is broadcast to players and spectators, and dies when cleared', async () => {
    ctx = setup();
    const { handler, room, io, spec } = ctx;
    const result = await handler.setSkinOverride({
      scope: 'room',
      roomId: 'skin-room',
      skins: { table_theme: 'night', card_back_style: 'diamond', junk: 'x', card_skin: '' },
      setBy: 'admin@wblue.id',
    });
    expect(result.success).to.equal(true);
    expect(result.skins).to.deep.equal({ table_theme: 'night', card_back_style: 'diamond' });
    expect(room.skinOverride.setBy).to.equal('admin@wblue.id');

    const fields = handler._skinsPayloadFields(room);
    expect(fields.skinsSource).to.equal('admin_room');
    // Composed over the owner's skins: untouched slots stay as the owner had them.
    expect(fields.skins).to.deep.equal({ table_skin: 'https://cdn/owner-table.png', table_theme: 'night', card_back_style: 'diamond' });

    const events = skinEvents(io);
    expect(events).to.have.length(1);
    expect(events[0].roomId).to.equal('skin-room');
    expect(events[0].payload.skinsSource).to.equal('admin_room');
    expect(events[0].payload.reason).to.equal('admin_room_set');
    // The spectator socket is not in the io room mock → gets its own copy.
    expect(spec.emitted.map((e) => e.event)).to.include(SocketEvents.SKINS_UPDATED);

    const cleared = await handler.clearSkinOverride({ scope: 'room', roomId: 'skin-room' });
    expect(cleared).to.include({ success: true, cleared: true });
    expect(room.skinOverride).to.equal(null);
    expect(handler._skinsPayloadFields(room).skinsSource).to.equal('owner');
    expect(skinEvents(io).map((e) => e.payload.reason)).to.deep.equal([
      'admin_room_set',
      'admin_room_cleared',
    ]);
  });

  it('carries the game background (token and image) like the table and card slots', async () => {
    ctx = setup();
    const { handler, room } = ctx;
    const result = await handler.setSkinOverride({
      scope: 'room',
      roomId: 'skin-room',
      skins: { background_style: 'royalGold', background_skin: 'https://cdn/bg.jpg' },
    });
    expect(result.success).to.equal(true);
    expect(result.skins).to.deep.equal({ background_style: 'royalGold', background_skin: 'https://cdn/bg.jpg' });
    // A background-only override leaves the owner's felt alone.
    expect(handler._skinsPayloadFields(room).skins).to.deep.equal({
      table_skin: 'https://cdn/owner-table.png',
      background_style: 'royalGold',
      background_skin: 'https://cdn/bg.jpg',
    });
  });

  it('rejects an override without usable skins or without a room', async () => {
    ctx = setup();
    expect((await ctx.handler.setSkinOverride({ scope: 'room', roomId: 'skin-room', skins: { junk: 'x' } })).success).to.equal(false);
    expect((await ctx.handler.setSkinOverride({ scope: 'room', roomId: 'nope', skins: { table_theme: 'night' } })).success).to.equal(false);
    expect((await ctx.handler.setSkinOverride({ scope: 'team', skins: { table_theme: 'night' } })).success).to.equal(false);
    expect((await ctx.handler.setSkinOverride({ scope: 'global', skins: { table_theme: 'night' }, expiresAt: '2000-01-01T00:00:00.000Z' })).success).to.equal(false);
  });

  it('a global override applies to every room, loses to a room override, and expires on time', async () => {
    ctx = setup();
    const { handler, room, io, service } = ctx;
    const other = service.createRoom('other-room', 2);
    const result = await handler.setSkinOverride({
      scope: 'global',
      skins: { table_skin: 'https://cdn/event-table.png' },
      durationMs: 60,
    });
    expect(result.success).to.equal(true);
    expect(result.expiresAt).to.be.a('string');
    expect(handler._skinsPayloadFields(room).skinsSource).to.equal('admin_global');
    expect(handler._skinsPayloadFields(other).skinsSource).to.equal('admin_global');
    expect(handler._skinsPayloadFields(room).skinsExpiresAt).to.equal(result.expiresAt);
    expect(skinEvents(io).map((e) => e.roomId).sort()).to.deep.equal(['other-room', 'skin-room']);

    await handler.setSkinOverride({ scope: 'room', roomId: 'skin-room', skins: { card_skin: 'https://cdn/back.png' } });
    expect(handler._skinsPayloadFields(room).skinsSource).to.equal('admin_room');
    expect(handler._skinsPayloadFields(other).skinsSource).to.equal('admin_global');
    expect(handler.getSkinOverrideStatus().rooms.map((r) => r.roomId)).to.deep.equal(['skin-room']);

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(handler.globalSkinOverride).to.equal(null);
    expect(handler._skinsPayloadFields(other).skinsSource).to.equal('none');
    expect(handler._skinsPayloadFields(room).skinsSource).to.equal('admin_room');
    expect(skinEvents(io).filter((e) => e.payload.reason === 'admin_global_expired').map((e) => e.roomId).sort())
      .to.deep.equal(['other-room', 'skin-room']);
    expect(handler.getSkinOverrideStatus().global).to.equal(null);
  });

  it('lists live rooms with seats, watchers and the skins in force', async () => {
    ctx = setup();
    const { handler } = ctx;
    await handler.setSkinOverride({ scope: 'room', roomId: 'skin-room', skins: { table_theme: 'snow' } });
    const listing = handler.listRoomsForAdmin();
    expect(listing.success).to.equal(true);
    const row = listing.rooms.find((r) => r.roomId === 'skin-room');
    expect(row.playerCount).to.equal(2);
    expect(row.spectatorCount).to.equal(1);
    expect(row.players.map((p) => p.playerId)).to.deep.equal(['p1', 'p2']);
    expect(row.skinsSource).to.equal('admin_room');
    expect(row.skins).to.deep.equal({ table_skin: 'https://cdn/owner-table.png', table_theme: 'snow' });
  });

  it('sends the spectator count to the backend with the seat count', () => {
    ctx = setup();
    const { handler } = ctx;
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: true });
    };
    handler._backendUrlForRoom = () => 'https://backend.example';
    try {
      handler._broadcastSpectatorsChanged('skin-room');
    } finally {
      global.fetch = originalFetch;
    }
    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal('https://backend.example/api/webhooks/room-player-count');
    expect(calls[0].body).to.deep.equal({ roomId: 'skin-room', playerCount: 2, spectatorCount: 1 });
  });
});

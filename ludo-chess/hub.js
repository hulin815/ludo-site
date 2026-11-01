/**
 * 飞行棋 room + transport server.
 *
 * Transport is HTTP long-poll on purpose: the Web GUI's page policy permits
 * same-origin `fetch` but refuses `ws:` sockets, so a browser client talks to
 * `POST /ludo/api/sync` and the server holds that request until it has
 * messages. Every request carries the actions the client queued plus a
 * sequence number, so a retried batch never applies twice.
 */
import {
  HOME,
  PLANE_COUNT,
  applyMove,
  createGame,
  finishTurn,
  pickMove,
  rollDice,
} from './engine.js'

const MAX_MEMBERS = 4
const FEED_LIMIT = 140
const NAME_MAX = 14
const CHAT_MAX = 180
const CHAT_GAP_MS = 400
// Bots play briskly on purpose: a table with two bots should not feel like
// waiting for someone to think. Tempo only scales these in tests.
const BOT_ROLL_MS = 380
const BOT_MOVE_MS = 280
const HUMAN_MOVE_TIMEOUT_MS = 45000
const POLL_HOLD_MS = 20000
const CONN_STALE_MS = 45000
const CONN_KEEP_MS = 5 * 60 * 1000
const ROOM_IDLE_MS = 10 * 60 * 1000
const LOBBY_ORPHAN_MS = 30 * 1000
const BODY_LIMIT = 64 * 1024
const VOICE_LIMIT = 320 * 1024
const VOICE_MAX_MS = 20000
const VOICE_KEEP = 40
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** 语音消息允许的容器格式。 */
const VOICE_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'])
/** 局内互动表情的白名单（和客户端 core.js 里那份一致）。 */
const REACTIONS = new Set(['👍', '😂', '😭', '🎉', '🔥', '😱', '💪', '666'])

class UserError extends Error {}

function fail(message) {
  throw new UserError(message)
}

function cleanName(value, fallback) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
  return text || fallback
}

function cleanCid(value) {
  const text = String(value ?? '').trim()
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(text)) return null
  return text
}

function json(res, status, body) {
  if (res.writableEnded || res.destroyed) return
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(value && typeof value === 'object' ? value : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

/** 读原始字节（语音这种二进制体）。 */
function readRaw(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

import * as gomoku from './gomoku.js'
import * as duel from './duel.js'
import * as brawl from './brawl.js'

export function createHub(options = {}) {
  const random = options.random ?? Math.random
  const now = options.now ?? (() => Date.now())
  const tempo = options.tempo ?? 1
  const conns = new Map()
  const rooms = new Map()
  const pings = new Map()
  /** 语音片段单独存放，聊天流里只放 id，免得每次轮询把音频一起搬。 */
  const clips = new Map()
  let clipSeq = 0
  const startedAt = now()
  let connSeq = 0
  let feedSeq = 0
  let upgradeAttempts = 0

  const hub = {}

  // ---------------------------------------------------------------- helpers
  function seatOf(room, cid) {
    if (!cid) return -1
    return room.members.findIndex((member) => member.cid === cid)
  }

  /** 只有房主能改棋盘；返回是否放行。 */
  function requireHost(conn) {
    const room = rooms.get(conn.roomId)
    if (!room) {
      fail('不在房间里')
      return false
    }
    if (room.hostCid !== conn.cid) {
      fail('只有房主能改棋盘')
      return false
    }
    return true
  }

  function connOf(member) {
    if (!member || !member.sid) return undefined
    return conns.get(member.sid)
  }

  function isConnected(room, member) {
    const conn = connOf(member)
    return conn !== undefined && now() - conn.lastSeen < CONN_STALE_MS
  }

  function pushFeed(room, entry) {
    feedSeq += 1
    room.feed.push({ id: feedSeq, at: now(), ...entry })
    if (room.feed.length > FEED_LIMIT) room.feed.splice(0, room.feed.length - FEED_LIMIT)
  }

  function deliver(conn, payload) {
    if (!conn) return
    conn.queue.push(payload)
    if (conn.queue.length > 400) conn.queue.splice(0, conn.queue.length - 400)
    if (conn.queue.length > 0) flush(conn)
  }

  function flush(conn) {
    const pending = conn.pending
    if (!pending) return
    if (conn.queue.length === 0) return
    conn.pending = null
    clearTimeout(pending.timer)
    json(pending.res, 200, { ok: true, messages: conn.queue.splice(0) })
  }

  function settlePoll(conn) {
    const pending = conn.pending
    if (!pending) return
    conn.pending = null
    clearTimeout(pending.timer)
    json(pending.res, 200, { ok: true, messages: conn.queue.splice(0) })
  }

  function connFor(sid) {
    let conn = conns.get(sid)
    if (!conn) {
      connSeq += 1
      conn = {
        seq: connSeq,
        sid,
        cid: null,
        name: '',
        roomId: null,
        lastSeen: now(),
        stale: false,
        queue: [],
        pending: null,
        lastAction: 0,
      }
      conns.set(sid, conn)
    }
    conn.lastSeen = now()
    return conn
  }

  function roomList() {
    return [...rooms.values()]
      .map((room) => ({
        id: room.id,
        phase: room.phase,
        gameType: room.gameType || 'ludo',
        members: room.members.length,
        maxMembers: MAX_MEMBERS,
        humans: room.members.filter((m) => !m.isBot).length,
        hostName: room.members[0]?.name ?? '',
      }))
      .sort((a, b) => (a.phase === b.phase ? a.id.localeCompare(b.id) : a.phase === 'lobby' ? -1 : 1))
  }

  function roomView(room, cid) {
    const game = room.game
    const seat = seatOf(room, cid)
    const me = seat >= 0 ? room.members[seat] : null
    const canAct = !!game && !game.over && game.turn === seat
    return {
      id: room.id,
      phase: room.phase,
      gameType: room.gameType || 'ludo',
      hostCid: room.hostCid,
      board: room.board || null,
      you: me ? { cid: me.cid, name: me.name, color: seat, isHost: room.hostCid === me.cid } : null,
      members: room.members.map((member, index) => {
        const color = member.color ?? index
        return {
          color,
          cid: member.cid,
          name: member.name,
          isBot: member.isBot,
          connected: member.isBot ? true : isConnected(room, member),
          isHost: room.hostCid === member.cid,
          planes: game && game.players[color] && Array.isArray(game.players[color].planes) ? game.players[color].planes.slice() : [-1, -1, -1, -1],
          rank: game ? game.players[color].rank : 0,
        }
      }),
      game: game
        ? (room.gameType || 'ludo') === 'brawl'
          ? brawl.snapshot(game)
          : (room.gameType || 'ludo') === 'duel'
          ? {
              kind: 'duel',
              turn: game.picks.findIndex((pick) => pick === null),
              over: game.over,
              winner: game.winner,
              hp: game.hp.slice(),
              gap: game.gap,
              round: game.round,
              picks: game.picks.map((pick) => (pick ? 1 : 0)),
              last: game.last,
              history: game.history.slice(-8),
              turns: game.turns,
              canPick: room.phase === 'playing' && !game.over && game.picks[seat] === null,
            }
          : (room.gameType || 'ludo') === 'gomoku'
          ? {
              kind: 'gomoku',
              turn: game.turn,
              over: game.over,
              winner: game.winner,
              winLine: game.winLine,
              moves: game.moves,
              turns: game.turnsPlayed,
              last: game.history.length ? game.history[game.history.length - 1] : null,
              board: game.board.map((row) => row.slice()),
            }
          : {
              turn: game.turn,
              dice: game.dice,
              moves: canAct ? game.moves.map((move) => ({ ...move })) : [],
              over: game.over,
              ranks: game.players.map((player) => player.rank),
              turns: game.turnsPlayed,
            }
        : null,
      feed: room.feed.slice(-90),
      canStart: room.phase === 'lobby' && room.hostCid === cid,
      canAddBot: room.phase === 'lobby' && room.hostCid === cid && room.members.length < MAX_MEMBERS,
      canRestart: room.phase === 'over' && room.hostCid === cid,
      canChat: seat >= 0,
      seat,
    }
  }

  function broadcast(room) {
    for (const member of room.members) {
      const conn = connOf(member)
      if (!conn) continue
      deliver(conn, { t: 'room', room: roomView(room, member.cid) })
    }
  }

  function broadcastRooms() {
    const list = roomList()
    for (const conn of conns.values()) {
      if (!conn.cid || conn.roomId) continue
      deliver(conn, { t: 'rooms', rooms: list })
    }
  }

  // -------------------------------------------------------------- turn flow
  function clearTimer(room) {
    if (room.timer) {
      clearTimeout(room.timer)
      room.timer = null
    }
  }

  function schedule(room, delay, action) {
    clearTimer(room)
    room.timer = setTimeout(() => {
      room.timer = null
      try {
        action()
      } catch (error) {
        if (!(error instanceof UserError)) console.error('[ludo] scheduled action failed', error)
      }
    }, Math.max(5, Math.round(delay * tempo)))
    room.timer.unref?.()
  }

  /** 联机实时对战：服务端 60ms 一帧，跑起来就连着广播。 */
  function startBrawl(room) {
    const game = room.game
    if (!game) return
    if (game.loop) clearInterval(game.loop)
    game.loop = setInterval(() => {
      const live = rooms.get(room.id)
      if (!live || live.game !== game) {
        clearInterval(game.loop)
        return
      }
      if (game.over || room.phase !== 'playing') {
        clearInterval(game.loop)
        return
      }
      const dt = 0.06
      for (let seat = 0; seat < 2; seat += 1) {
        const member = room.members[seat]
        if (member && member.isBot) brawl.applyInput(game, seat, brawl.botInput(game, seat))
      }
      brawl.step(game, dt)
      if (game.over) {
        room.phase = 'over'
        room.feed.push({ kind: 'over', color: game.winner, at: now() })
        clearInterval(game.loop)
        broadcast(room)
        broadcastRooms()
        return
      }
      broadcast(room)
    }, 60)
    if (game.loop.unref) game.loop.unref()
  }

  /** 擂台：一边是机器人就自动出招；两边都出完就结算。 */
  function pumpDuel(room) {
    const game = room.game
    if (!game || game.over || room.phase !== 'playing') return
    for (let seat = 0; seat < 2; seat += 1) {
      if (game.picks[seat]) continue
      const member = room.members[seat]
      if (member && member.isBot) game.picks[seat] = duel.botPick(game, seat)
    }
    if (!game.picks[0] || !game.picks[1]) {
      broadcast(room)
      return
    }
    const result = duel.resolve(game)
    if (!result.ok) return
    if (result.over) {
      room.phase = 'over'
      room.feed.push({ kind: 'over', color: result.winner, at: now() })
    }
    broadcast(room)
    broadcastRooms()
  }

  /** 五子棋机器人：轮到它就下一手。 */
  function pumpGomoku(room) {
    const game = room.game
    if (!game || game.over || room.phase !== 'playing') return
    const seat = game.turn
    const member = room.members[seat]
    if (!member || !member.isBot) return
    if (game.botTimer) clearTimeout(game.botTimer)
    game.botTimer = setTimeout(() => {
      const live = rooms.get(room.id)
      if (!live || live.game !== game || game.over) return
      const move = gomoku.botMove(game, seat)
      if (!move) return
      const result = gomoku.place(game, seat, move.x, move.y)
      if (!result.ok) return
      room.feed.push({ kind: 'stone', color: seat, name: member.name, x: move.x, y: move.y, win: !!result.win, at: now() })
      if (result.win || result.draw) {
        room.phase = 'over'
        room.feed.push({ kind: 'over', color: result.win ? seat : -1, at: now() })
      }
      broadcast(room)
      broadcastRooms()
      pumpGomoku(room)
    }, 460)
  }

  function pump(room) {
    if ((room.gameType || 'ludo') === 'duel') {
      pumpDuel(room)
      return
    }
    if ((room.gameType || 'ludo') === 'gomoku') {
      pumpGomoku(room)
      return
    }
    clearTimer(room)
    if (room.phase !== 'playing' || !room.game || room.game.over) return
    const game = room.game
    const player = game.players[game.turn]
    if (!player) return
    const member = room.members.find((m) => m.color === player.color)
    const automated = !member || player.isBot || !isConnected(room, member)

    if (game.dice === null) {
      if (automated) schedule(room, BOT_ROLL_MS, () => rollFor(room))
      return
    }
    if (game.moves.length === 0) {
      closeTurn(room)
      return
    }
    if (automated) {
      schedule(room, BOT_MOVE_MS, () => moveFor(room, pickMove(game)))
      return
    }
    // A human always picks the plane itself — one legal move is still their
    // click (that is how you "launch it yourself"). The timeout only exists so
    // an abandoned table cannot stall the other seats.
    schedule(room, HUMAN_MOVE_TIMEOUT_MS, () => {
      pushFeed(room, { kind: 'timeout', color: player.color })
      moveFor(room, pickMove(game))
    })
  }

  function closeTurn(room) {
    const game = room.game
    const result = finishTurn(game)
    if (result.ranked !== null) {
      const player = game.players[result.ranked]
      pushFeed(room, { kind: 'rank', color: result.ranked, place: player.rank })
    }
    if (game.over) {
      room.phase = 'over'
      pushFeed(room, {
        kind: 'over',
        order: game.players
          .slice()
          .sort((a, b) => a.rank - b.rank)
          .map((player) => ({ color: player.color, name: player.name, rank: player.rank })),
      })
      clearTimer(room)
    }
    broadcast(room)
    if (!game.over) pump(room)
  }

  function rollFor(room) {
    const game = room.game
    if (!game || game.over || game.dice !== null) return
    const seat = game.turn
    const result = rollDice(game, random)
    if (!result.ok) return
    pushFeed(room, { kind: 'roll', color: seat, dice: result.dice })
    if (result.moves.length === 0) {
      pushFeed(room, { kind: 'pass', color: seat })
      broadcast(room)
      closeTurn(room)
      return
    }
    broadcast(room)
    pump(room)
  }

  function moveFor(room, plane) {
    const game = room.game
    if (!game || game.over || game.dice === null) return
    const seat = game.turn
    const result = applyMove(game, plane)
    if (!result.ok) return
    for (const event of result.events) {
      if (event.type === 'move') {
        pushFeed(room, {
          kind: 'move',
          color: event.color,
          plane: event.plane,
          from: event.from,
          to: event.to,
          via: event.via,
        })
      } else if (event.type === 'capture') {
        pushFeed(room, { kind: 'capture', color: seat, victim: event.color, count: event.count })
      }
    }
    broadcast(room)
    closeTurn(room)
  }

  // ------------------------------------------------------------- room seats
  function newRoomId() {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      let id = ''
      for (let i = 0; i < 4; i += 1) {
        id += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)]
      }
      if (!rooms.has(id)) return id
    }
    return 'R' + String(rooms.size + 1)
  }

  function addBotMember(room) {
    const taken = new Set(room.members.map((m) => m.cid))
    let index = 1
    while (taken.has('bot-' + index)) index += 1
    const member = {
      cid: 'bot-' + index,
      name: '机器人 ' + index,
      isBot: true,
      sid: null,
      color: room.members.length,
    }
    room.members.push(member)
    return member
  }

  function dropRoom(room) {
    clearTimer(room)
    rooms.delete(room.id)
    broadcastRooms()
  }

  function attach(room, member, conn) {
    member.sid = conn.sid
    member.offlineSince = 0
    if (member.isBot) member.isBot = false
    const seat = room.members.indexOf(member)
    if (room.game && seat >= 0) {
      room.game.players[seat].isBot = false
      room.game.players[seat].name = member.name
    }
    conn.roomId = room.id
    deliver(conn, { t: 'room', room: roomView(room, member.cid) })
  }

  function leaveRoom(conn) {
    const room = conn.roomId ? rooms.get(conn.roomId) : null
    conn.roomId = null
    if (!room) return
    const seat = seatOf(room, conn.cid)
    if (seat < 0) {
      deliver(conn, { t: 'room', room: null })
      return
    }
    const member = room.members[seat]
    if (member.sid === conn.sid) member.sid = null

    if (room.phase === 'playing') {
      member.isBot = true
      pushFeed(room, { kind: 'takeover', color: seat })
      // 实时对战没法“机器人接管”：有人退出就直接结算
      if ((room.gameType || 'ludo') === 'brawl' && room.game && !room.game.over) {
        room.game.over = true
        room.game.winner = 1 - seat
        room.phase = 'over'
        if (room.game.loop) clearInterval(room.game.loop)
        pushFeed(room, { kind: 'over', color: 1 - seat })
      }
      // The host leaving must not leave the table without a driver.
      if (room.hostCid === conn.cid) {
        const nextHost = room.members.find((other) => !other.isBot)
        room.hostCid = nextHost ? nextHost.cid : ''
      }
      // Nobody human is left to watch the bots play.
      if (room.members.every((other) => other.isBot)) {
        dropRoom(room)
        deliver(conn, { t: 'room', room: null })
        return
      }
    } else {
      room.members.splice(seat, 1)
      // seat indices are the colours, so keep them dense after a lobby exit
      room.members.forEach((other, index) => {
        other.color = index
      })
      if (room.hostCid === conn.cid) {
        const nextHost = room.members.find((m) => !m.isBot)
        room.hostCid = nextHost ? nextHost.cid : room.members[0]?.cid ?? ''
      }
      if (room.members.length === 0) {
        dropRoom(room)
        deliver(conn, { t: 'room', room: null })
        return
      }
      // A room nobody human is watching any more is dead weight.
      if (room.members.every((member) => member.isBot)) {
        dropRoom(room)
        deliver(conn, { t: 'room', room: null })
        return
      }
      pushFeed(room, { kind: 'leave', name: member.name, color: seat })
    }
    deliver(conn, { t: 'room', room: null })
    broadcast(room)
    pump(room)
    broadcastRooms()
  }

  // --------------------------------------------------------------- messages
  function handle(conn, message) {    switch (message.t) {
      case 'ping':
        deliver(conn, { t: 'pong', at: now() })
        return

      case 'hello': {
        const cid = cleanCid(message.cid) ?? 'g' + conn.seq + Math.floor(random() * 1e6)
        for (const other of conns.values()) {
          if (other !== conn && other.cid === cid) {
            other.cid = null
            other.roomId = null
            settlePoll(other)
          }
        }
        conn.cid = cid
        conn.name = cleanName(message.name, '玩家' + cid.slice(-4).toUpperCase())
        deliver(conn, { t: 'welcome', you: { cid, name: conn.name }, rooms: roomList() })
        const held = [...rooms.values()].find((room) => seatOf(room, cid) >= 0)
        if (held) {
          attach(held, held.members[seatOf(held, cid)], conn)
          broadcast(held)
          pump(held)
          return
        }
        // No seat for this identity: say so explicitly, otherwise a client that
        // kept a stale room view would never learn the room is gone.
        deliver(conn, { t: 'room', room: null })
        return
      }

      case 'setName': {
        const name = cleanName(message.name, conn.name || '玩家')
        conn.name = name
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (room) {
          const seat = seatOf(room, conn.cid)
          if (seat >= 0) {
            room.members[seat].name = name
            broadcast(room)
          }
        }
        deliver(conn, { t: 'named', name })
        return
      }

      case 'listRooms':
        deliver(conn, { t: 'rooms', rooms: roomList() })
        return

      case 'createRoom': {
        if (!conn.cid) fail('请先连接')
        if (conn.roomId) leaveRoom(conn)
        const id = newRoomId()
        const room = {
          id,
          phase: 'lobby',
          hostCid: conn.cid,
          members: [],
          game: null,
          gameType: message.game === 'gomoku' ? 'gomoku' : message.game === 'duel' ? 'duel' : message.game === 'brawl' ? 'brawl' : 'ludo',
          board: null,
          feed: [],
          timer: null,
          chatAt: new Map(),
          createdAt: now(),
        }
        room.members.push({ cid: conn.cid, name: conn.name || '玩家', isBot: false, sid: conn.sid, color: 0 })
        rooms.set(id, room)
        conn.roomId = id
        pushFeed(room, { kind: 'create', name: conn.name })
        deliver(conn, { t: 'room', room: roomView(room, conn.cid) })
        broadcastRooms()
        return
      }

      case 'joinRoom': {
        if (!conn.cid) fail('请先连接')
        const id = String(message.roomId ?? '').toUpperCase().trim()
        const room = rooms.get(id)
        if (!room) fail('房间不存在')
        if (conn.roomId && conn.roomId !== id) leaveRoom(conn)
        const seat = seatOf(room, conn.cid)
        if (seat >= 0) {
          attach(room, room.members[seat], conn)
          broadcast(room)
          pump(room)
          return
        }
        if (room.phase !== 'lobby') fail('这局已经开始了')
        if (room.members.length >= MAX_MEMBERS) fail('房间已满')
        room.members.push({
          cid: conn.cid,
          name: conn.name || '玩家',
          isBot: false,
          sid: conn.sid,
          color: room.members.length,
        })
        conn.roomId = id
        pushFeed(room, { kind: 'join', name: conn.name, color: room.members.length - 1 })
        deliver(conn, { t: 'room', room: roomView(room, conn.cid) })
        broadcast(room)
        broadcastRooms()
        return
      }

      case 'paint': {
        if (!requireHost(conn, 'paint')) return
        const room = rooms.get(conn.roomId)
        if (!room) return fail('不在房间里')
        if (room.phase !== 'lobby') return fail('开局后不能改棋盘')
        const cell = Number(message.cell)
        const color = Number(message.color)
        if (!Number.isInteger(cell) || cell < 0 || cell >= 52) return fail('格子号不对')
        if (!Number.isInteger(color) || color < 0 || color > 3) return fail('颜色不对')
        const board = room.board || {}
        const colors = Array.isArray(board.colors) ? board.colors.slice() : []
        colors[cell] = color
        board.colors = colors
        room.board = board
        broadcast(room)
        return
      }

      case 'mark': {
        if (!requireHost(conn, 'mark')) return
        const room = rooms.get(conn.roomId)
        if (!room) return fail('不在房间里')
        if (room.phase !== 'lobby') return fail('开局后不能改棋盘')
        const cell = Number(message.cell)
        const kind = String(message.kind || '')
        if (!Number.isInteger(cell) || cell < 0 || cell >= 52) return fail('格子号不对')
        if (kind !== 'safe' && kind !== 'flight') return fail('类型不对')
        const board = room.board || {}
        const list = Array.isArray(board[kind]) ? board[kind].slice() : []
        const at = list.indexOf(cell)
        if (at >= 0) list.splice(at, 1)
        else list.push(cell)
        board[kind] = list
        room.board = board
        broadcast(room)
        return
      }

      case 'startCell': {
        if (!requireHost(conn, 'startCell')) return
        const room = rooms.get(conn.roomId)
        if (!room) return fail('不在房间里')
        if (room.phase !== 'lobby') return fail('开局后不能改棋盘')
        const color = Number(message.color)
        const cell = Number(message.cell)
        if (!Number.isInteger(color) || color < 0 || color > 3) return fail('颜色不对')
        if (!Number.isInteger(cell) || cell < 0 || cell >= 52) return fail('格子号不对')
        const board = room.board || {}
        const start = Array.isArray(board.start) ? board.start.slice() : [19, 6, 45, 32]
        start[color] = cell
        board.start = start
        room.board = board
        broadcast(room)
        return
      }

      case 'leaveRoom':
        leaveRoom(conn)
        return

      case 'addBot': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) fail('你不在房间里')
        if (room.hostCid !== conn.cid) fail('只有房主可以添加机器人')
        if (room.phase !== 'lobby') fail('已经开始了')
        if (room.members.length >= MAX_MEMBERS) fail('房间已满')
        const bot = addBotMember(room)
        pushFeed(room, { kind: 'bot', name: bot.name })
        broadcast(room)
        broadcastRooms()
        return
      }

      case 'input': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) return fail('你不在房间里')
        if ((room.gameType || 'ludo') !== 'brawl') return fail('这局不是联机对战')
        const game = room.game
        if (!game || game.over || room.phase !== 'playing') return
        const seat = seatOf(room, conn.cid)
        if (seat < 0) return
        brawl.applyInput(game, seat, {
          left: message.left,
          right: message.right,
          jump: message.jump,
          punch: message.punch,
          kick: message.kick,
          block: message.block,
        })
        return
      }

      case 'pick': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) return fail('你不在房间里')
        if ((room.gameType || 'ludo') !== 'duel') return fail('这局不是擂台')
        const game = room.game
        if (!game || game.over || room.phase !== 'playing') return fail('还没开始')
        const seat = seatOf(room, conn.cid)
        if (seat < 0) return fail('你不在座位上')
        const move = String(message.move || '')
        if (!duel.MOVES.includes(move)) return fail('没有这一招')
        if (game.picks[seat]) return fail('这一轮你已经出招了')
        game.picks[seat] = move
        pumpDuel(room)
        return
      }

      case 'place': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) return fail('你不在房间里')
        if ((room.gameType || 'ludo') !== 'gomoku') return fail('这局不是五子棋')
        const game = room.game
        if (!game || room.phase !== 'playing') return fail('还没开始')
        const seat = seatOf(room, conn.cid)
        if (seat < 0) return fail('你不在座位上')
        const x = Number(message.x)
        const y = Number(message.y)
        const result = gomoku.place(game, seat, x, y)
        if (!result.ok) return fail(result.error || '不能下这里')
        room.feed.push({
          kind: 'stone',
          color: seat,
          name: conn.name,
          x,
          y,
          win: !!result.win,
          at: now(),
        })
        if (result.win || result.draw) {
          room.phase = 'over'
          room.feed.push({ kind: 'over', color: result.win ? seat : -1, at: now() })
        }
        broadcast(room)
        broadcastRooms()
        pumpGomoku(room)
        return
      }

      case 'start': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) fail('你不在房间里')
        if (room.hostCid !== conn.cid) fail('只有房主可以开始游戏')
        if (room.phase !== 'lobby') fail('已经开始了')
        if ((room.gameType || 'ludo') === 'brawl') {
          while (room.members.length < 2) addBotMember(room)
          room.members.length = 2
          for (let seat = 0; seat < 2; seat += 1) room.members[seat].color = seat
          room.game = brawl.createGame(
            room.members.map((member) => ({
              cid: member.cid,
              name: member.name,
              isBot: member.isBot,
            })),
          )
          startBrawl(room)
        } else if ((room.gameType || 'ludo') === 'duel') {
          while (room.members.length < 2) addBotMember(room)
          room.members.length = 2
          for (let seat = 0; seat < 2; seat += 1) room.members[seat].color = seat
          room.game = duel.createGame(
            room.members.map((member) => ({
              cid: member.cid,
              name: member.name,
              isBot: member.isBot,
            })),
          )
        } else if ((room.gameType || 'ludo') === 'gomoku') {
          while (room.members.length < 2) addBotMember(room)
          room.members.length = 2
          room.game = gomoku.createGame(
            room.members.map((member) => ({
              cid: member.cid,
              name: member.name,
              isBot: member.isBot,
            })),
          )
          for (let seat = 0; seat < 2; seat += 1) room.members[seat].color = seat
        } else {
          while (room.members.length < MAX_MEMBERS) addBotMember(room)
          room.game = createGame(
            room.members.map((member) => ({
              cid: member.cid,
              name: member.name,
              isBot: member.isBot,
            })),
          )
        }
        room.phase = 'playing'
        pushFeed(room, { kind: 'start' })
        broadcast(room)
        broadcastRooms()
        pump(room)
        return
      }

      case 'restart': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) fail('你不在房间里')
        if (room.hostCid !== conn.cid) fail('只有房主可以再来一局')
        if (room.phase !== 'over') fail('这局还没结束')
        for (const member of room.members) member.isBot = member.isBot || member.sid === null
        if ((room.gameType || 'ludo') === 'duel') {
          room.members.length = Math.min(2, room.members.length)
          while (room.members.length < 2) addBotMember(room)
          for (let seat = 0; seat < 2; seat += 1) room.members[seat].color = seat
          room.game = duel.createGame(
            room.members.map((member) => ({
              cid: member.cid,
              name: member.name,
              isBot: member.isBot,
            })),
          )
        } else if ((room.gameType || 'ludo') === 'gomoku') {
          room.members.length = Math.min(2, room.members.length)
          while (room.members.length < 2) addBotMember(room)
          for (let seat = 0; seat < 2; seat += 1) room.members[seat].color = seat
          room.game = gomoku.createGame(
            room.members.map((member) => ({
              cid: member.cid,
              name: member.name,
              isBot: member.isBot,
            })),
          )
        } else {
          room.game = createGame(
            room.members.map((member) => ({
              cid: member.cid,
              name: member.name,
              isBot: member.isBot,
            })),
          )
        }
        room.phase = 'playing'
        pushFeed(room, { kind: 'restart' })
        broadcast(room)
        broadcastRooms()
        pump(room)
        return
      }

      case 'roll': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) fail('你不在房间里')
        if (room.phase !== 'playing' || !room.game) fail('还没有开始')
        const seat = seatOf(room, conn.cid)
        if (seat < 0) fail('你不在这个房间')
        if (room.game.turn !== seat) fail('还没轮到你')
        if (room.game.dice !== null) fail('先走棋')
        rollFor(room)
        return
      }

      case 'move': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) fail('你不在房间里')
        if (room.phase !== 'playing' || !room.game) fail('还没有开始')
        const seat = seatOf(room, conn.cid)
        if (seat < 0) fail('你不在这个房间')
        if (room.game.turn !== seat) fail('还没轮到你')
        if (room.game.dice === null) fail('先掷骰子')
        const plane = Number(message.plane)
        if (!Number.isInteger(plane) || plane < 0 || plane >= PLANE_COUNT) fail('没有这架飞机')
        if (!room.game.moves.some((move) => move.plane === plane)) fail('这步不合规则')
        moveFor(room, plane)
        return
      }

      case 'chat': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) fail('你不在房间里')
        const seat = seatOf(room, conn.cid)
        if (seat < 0) fail('你不在这个房间')
        const text = String(message.text ?? '')
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
          .trim()
          .slice(0, CHAT_MAX)
        if (!text) return
        const last = room.chatAt.get(conn.cid) ?? 0
        if (now() - last < CHAT_GAP_MS) fail('说慢一点')
        room.chatAt.set(conn.cid, now())
        pushFeed(room, { kind: 'chat', color: seat, name: room.members[seat].name, text })
        broadcast(room)
        return
      }

      case 'reaction': {
        const room = conn.roomId ? rooms.get(conn.roomId) : null
        if (!room) return
        const seat = seatOf(room, conn.cid)
        if (seat < 0) return
        const emoji = String(message.emoji ?? '').slice(0, 4)
        if (!REACTIONS.has(emoji)) return
        if (!room.reactAt) room.reactAt = new Map()
        const last = room.reactAt.get(conn.cid) ?? 0
        if (now() - last < 300) return
        room.reactAt.set(conn.cid, now())
        pushFeed(room, { kind: 'reaction', color: seat, name: room.members[seat].name, emoji })
        broadcast(room)
        return
      }

      default:
        return
    }
  }

  // ------------------------------------------------------------------- wire
  function applyActions(conn, actions) {
    for (const action of actions) {
      if (!action || typeof action !== 'object' || typeof action.t !== 'string') continue
      if (typeof action.n === 'number') {
        if (action.n <= conn.lastAction) continue
        conn.lastAction = action.n
      }
      try {
        handle(conn, action)
      } catch (error) {
        if (error instanceof UserError) {
          deliver(conn, { t: 'error', message: error.message })
          continue
        }
        console.error('[ludo] action failed', error)
        deliver(conn, { t: 'error', message: '服务器出错了' })
      }
    }
  }

  hub.handleSync = async (request, response, body) => {
    const sid = typeof body.sid === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(body.sid) ? body.sid : null
    if (!sid) {
      json(response, 400, { ok: false, error: 'bad sid' })
      return
    }
    const conn = connFor(sid)
    if (conn.pending) settlePoll(conn)

    const actions = Array.isArray(body.actions) ? body.actions.slice(0, 24) : []
    if (!conn.cid && body.cid) actions.unshift({ t: 'hello', cid: body.cid, name: body.name })
    applyActions(conn, actions)

    if (!conn.cid) {
      json(response, 400, { ok: false, error: 'hello required' })
      return
    }

    if (conn.queue.length > 0) {
      json(response, 200, { ok: true, messages: conn.queue.splice(0) })
      return
    }
    if (body.wait === false) {
      json(response, 200, { ok: true, messages: [] })
      return
    }

    const timer = setTimeout(() => {
      if (conn.pending && conn.pending.res === response) {
        conn.pending = null
        json(response, 200, { ok: true, messages: conn.queue.splice(0) })
      }
    }, Math.round(POLL_HOLD_MS * tempo))
    timer.unref?.()
    conn.pending = { res: response, timer }
    response.on('close', () => {
      if (conn.pending && conn.pending.res === response) {
        clearTimeout(timer)
        conn.pending = null
      }
    })
  }

  hub.handleHttp = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '')

    // ---- 语音消息：音频单独存，聊天流里只有 id ----
    if (path === '/ludo/api/voice') {
      if (request.method !== 'POST') {
        json(response, 405, { ok: false, error: 'POST only' })
        return
      }
      const conn = conns.get(String(url.searchParams.get('sid') ?? ''))
      const room = conn?.roomId ? rooms.get(conn.roomId) : null
      const seat = room ? seatOf(room, conn.cid) : -1
      if (!room || seat < 0) {
        json(response, 403, { ok: false, error: 'not in a room' })
        return
      }
      const rawType = String(request.headers['content-type'] ?? 'audio/webm')
        .split(';')[0]
        .trim()
        .toLowerCase()
      const mime = VOICE_TYPES.has(rawType) ? rawType : 'audio/webm'
      const duration = Math.max(
        0,
        Math.min(VOICE_MAX_MS, Number(url.searchParams.get('duration') ?? 0) || 0),
      )
      readRaw(request, VOICE_LIMIT)
        .then((buffer) => {
          if (buffer.length < 64) {
            json(response, 400, { ok: false, error: 'empty clip' })
            return
          }
          clipSeq += 1
          const id = 'v' + clipSeq
          clips.set(id, { mime, buffer, at: now() })
          while (clips.size > VOICE_KEEP) clips.delete(clips.keys().next().value)
          pushFeed(room, {
            kind: 'voice',
            color: seat,
            name: room.members[seat].name,
            voiceId: id,
            duration,
            mime,
          })
          broadcast(room)
          json(response, 200, { ok: true, id })
        })
        .catch(() => json(response, 413, { ok: false, error: 'clip too large' }))
      return
    }

    if (path.startsWith('/ludo/api/voice/')) {
      const clip = clips.get(path.slice('/ludo/api/voice/'.length))
      if (!clip) {
        json(response, 404, { ok: false, error: 'gone' })
        return
      }
      response.writeHead(200, {
        'content-type': clip.mime,
        'content-length': clip.buffer.length,
        'cache-control': 'no-store',
      })
      response.end(clip.buffer)
      return
    }

    if (path === '/ludo/api/sync') {
      if (request.method !== 'POST') {
        json(response, 405, { ok: false, error: 'POST only' })
        return
      }
      readJson(request)
        .then((body) => hub.handleSync(request, response, body))
        .catch(() => {
          json(response, 400, { ok: false, error: 'bad body' })
        })
      return
    }

    if (path === '/ludo/api/ping') {
      const key = String(url.searchParams.get('k') ?? 'unknown').slice(0, 24)
      pings.set(key, (pings.get(key) ?? 0) + 1)
      json(response, 200, { ok: true })
      return
    }

    if (path === '/ludo/api/health') {
      json(response, 200, {
        ok: true,
        name: 'ludo-chess',
        rooms: rooms.size,
        players: [...rooms.values()].reduce((sum, room) => sum + room.members.length, 0),
        connections: [...conns.values()].filter((conn) => now() - conn.lastSeen < CONN_STALE_MS).length,
        sessions: conns.size,
        upgradeAttempts,
        pings: Object.fromEntries(pings),
        uptimeMs: now() - startedAt,
      })
      return
    }

    if (path === '/ludo/api/rooms') {
      json(response, 200, { rooms: roomList() })
      return
    }

    json(response, 404, { ok: false, error: 'not found' })
  }

  hub.dispose = () => {
    for (const room of rooms.values()) clearTimer(room)
    rooms.clear()
    for (const conn of conns.values()) settlePoll(conn)
    conns.clear()
    clearInterval(sweep)
  }

  hub.stats = () => ({
    rooms: rooms.size,
    sessions: conns.size,
    players: [...rooms.values()].reduce((sum, room) => sum + room.members.length, 0),
  })

  // -------------------------------------------------------------- lifecycle
  const sweep = setInterval(() => {
    const at = now()
    // 过期的语音片段没人会再听，清掉
    const clipCutoff = at - 10 * 60 * 1000
    for (const [id, clip] of clips) if (clip.at < clipCutoff) clips.delete(id)
    for (const conn of [...conns.values()]) {
      const idle = at - conn.lastSeen
      if (idle > CONN_KEEP_MS) {
        settlePoll(conn)
        conns.delete(conn.sid)
        continue
      }
      if (idle > CONN_STALE_MS && !conn.stale) {
        conn.stale = true
        for (const room of rooms.values()) {
          if (!room.members.some((member) => member.sid === conn.sid)) continue
          broadcast(room)
          pump(room)
        }
      }
    }

    // 连接没了（关页面/断网）→ 记下下线时间，之后按超时回收
    for (const room of rooms.values()) {
      let changed = false
      for (const member of room.members) {
        if (member.isBot || !member.sid) continue
        const conn = conns.get(member.sid)
        if (!conn || at - conn.lastSeen >= CONN_STALE_MS) {
          member.sid = null
          member.offlineSince = at
          changed = true
        }
      }
      if (changed && room.phase === 'lobby') broadcast(room)
    }

    for (const room of [...rooms.values()]) {
      if (room.phase === 'lobby') {
        const orphans = room.members.filter(
          (member) => !member.isBot && member.sid === null && member.offlineSince && at - member.offlineSince > LOBBY_ORPHAN_MS,
        )
        if (orphans.length > 0) {
          room.members = room.members.filter((member) => !orphans.includes(member))
          for (const orphan of orphans) {
            if (room.hostCid === orphan.cid) {
              const nextHost = room.members.find((m) => !m.isBot)
              room.hostCid = nextHost ? nextHost.cid : ''
            }
          }
          if (room.members.length === 0) {
            dropRoom(room)
            continue
          }
          pushFeed(room, { kind: 'orphan', count: orphans.length })
          broadcast(room)
          broadcastRooms()
        }
      }
      const live = room.members.some((member) => isConnected(room, member))
      if (!live && at - room.createdAt > ROOM_IDLE_MS) dropRoom(room)
    }
  }, 5000)
  sweep.unref?.()

  return hub
}

export { UserError }


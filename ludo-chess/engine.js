/**
 * Pure 飞行棋 (aeroplane chess) rules. No I/O, no timers.
 *
 * Track model
 *  - A shared loop of 52 cells. A plane's `pos` is its own progress 0..51 on
 *    that loop; the absolute board cell is (startCell(color) + pos) % 52.
 *  - After the loop each colour has a private runway of 4 cells (52..55) and
 *    then HOME (56). A plane must land on 56 exactly.
 *  - pos === -1 means the plane is still in its hangar.
 *
 * Specials
 *  - Coloured cell: landing on a cell whose colour matches yours jumps +4.
 *  - Flight cell: landing on one of the four marked cells flies +12.
 *  - Neither chains.
 */

export const LOOP = 52
export const RUNWAY_FIRST = 52
export const RUNWAY_LAST = 56
export const HOME = 57
export const PLANE_COUNT = 4

/** 每色的起飞格（环上序号）——红右下、蓝右上、黄左上、绿左下，各贴着自家机场。 */
const START_CELLS = [19, 6, 45, 32]
/** 52 格的散布色（每色 13 格），起飞格正好是自己颜色。 */
// 颜色规律：红 绿 黄 蓝 循环（起飞格例外）
const COLOR_CYCLE = [0, 3, 2, 1]
const FLIGHT_CELLS = new Set([11, 24, 37, 50])
/** 十字专属跑道：踩到就飞到下一个转角格（+13） */
const CORNER_FLIGHT = new Set([9, 22, 35, 48])
/** 白色安全格：停在这里不会被撞，也不会撞别人。 */
export const SAFE_CELLS = new Set([3, 7, 9, 20, 25, 33, 41, 46])

export function startCell(color, game) {
  const custom = game && game.board && game.board.start
  if (Array.isArray(custom) && Number.isInteger(custom[color])) return custom[color]
  return START_CELLS[color]
}

export function absoluteCell(color, pos, game) {
  return (startCell(color, game) + pos) % LOOP
}

export function cellColor(cell, game) {
  const custom = game && game.board && game.board.colors
  if (Array.isArray(custom)) {
    const value = custom[cell]
    if (Number.isInteger(value) && value >= 0 && value <= 3) return value
  }
  const own = START_CELLS.indexOf(cell)
  if (own >= 0) return own
  return COLOR_CYCLE[cell % 4]
}

export function isFlightCell(cell, game) {
  const custom = game && game.board && game.board.flight
  if (Array.isArray(custom)) return custom.includes(cell)
  return FLIGHT_CELLS.has(cell)
}

/** 白色安全格（可按房间配置覆盖）。 */
export function isSafeCell(cell, game) {
  const custom = game && game.board && game.board.safe
  if (Array.isArray(custom)) return custom.includes(cell)
  return SAFE_CELLS.has(cell)
}

export function cellKind(color, pos, game) {
  if (pos < 0) return 'hangar'
  if (pos === HOME) return 'home'
  if (pos >= RUNWAY_FIRST) return 'runway'
  const abs = absoluteCell(color, pos, game)
  if (isFlightCell(abs, game)) return 'flight'
  if (cellColor(abs, game) === color) return 'own'
  return 'plain'
}

export function createGame(seats) {
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 4) {
    throw new Error('createGame needs 2..4 seats')
  }
  return {
    players: seats.map((seat, index) => ({
      cid: seat.cid,
      name: seat.name,
      color: index,
      isBot: !!seat.isBot,
      planes: [-1, -1, -1, -1],
      rank: 0,
    })),
    turn: 0,
    dice: null,
    moves: [],
    sixStreak: 0,
    over: false,
    winnerOrder: [],
    turnsPlayed: 0,
  }
}

export function legalMoves(game) {
  if (game.over || game.dice === null) return []
  const me = game.players[game.turn]
  const dice = game.dice
  const out = []
  for (let plane = 0; plane < PLANE_COUNT; plane += 1) {
    const from = me.planes[plane]
    if (from === HOME) continue
    if (from === -1) {
      if (dice === 6) out.push({ plane, from, to: 0, kind: 'launch' })
      continue
    }
    const to = from + dice
    if (to > HOME) continue
    out.push({
      plane,
      from,
      to,
      kind: to === HOME ? 'home' : to >= RUNWAY_FIRST ? 'runway' : 'move',
    })
  }
  return out
}

/** Roll for the player whose turn it is. Returns the dice and legal moves. */
export function rollDice(game, rng = Math.random) {
  if (game.over) return { ok: false, reason: 'over' }
  if (game.dice !== null) return { ok: false, reason: 'already-rolled' }
  const dice = 1 + Math.floor(rng() * 6)
  game.dice = dice
  game.moves = legalMoves(game)
  return { ok: true, dice, moves: game.moves.map((m) => ({ ...m })) }
}

function captureAt(game, color, pos, events) {
  const abs = absoluteCell(color, pos, game)
  // 白色安全格：停在这里不吃人，也不被吃
  if (isSafeCell(abs, game)) return
  const pilot = game.players[game.turn]
  for (const other of game.players) {
    if (other === pilot) continue
    let hits = 0
    for (let i = 0; i < PLANE_COUNT; i += 1) {
      const p = other.planes[i]
      if (p < 0 || p > LOOP - 1) continue
      if (absoluteCell(other.color, p, game) !== abs) continue
      other.planes[i] = -1
      hits += 1
    }
    if (hits > 0) events.push({ type: 'capture', color: other.color, count: hits })
  }
}

/**
 * Apply a legal move for the current player. Mutates `game`; the caller is
 * responsible for ending the turn (see finishTurn).
 */
export function applyMove(game, plane) {
  if (game.over) return { ok: false, reason: 'over' }
  const move = game.moves.find((m) => m.plane === plane)
  if (!move) return { ok: false, reason: 'illegal' }
  const me = game.players[game.turn]
  const color = me.color
  const events = []

  if (move.from === -1) {
    me.planes[plane] = 0
    events.push({ type: 'move', color, plane, from: -2, to: 0, via: 'launch' })
    captureAt(game, color, 0, events)
  } else {
    let pos = move.to
    me.planes[plane] = pos
    if (pos <= LOOP - 1) {
      const abs = absoluteCell(color, pos, game)
      if (isFlightCell(abs, game) && pos + 12 <= LOOP - 1) {
        const from = pos
        pos += 12
        me.planes[plane] = pos
        events.push({ type: 'move', color, plane, from, to: pos, via: 'fly' })
        captureAt(game, color, pos, events)
      } else if (CORNER_FLIGHT.has(abs) && pos + 13 <= LOOP - 1) {
        // 十字对角跑道：踩到转角格直接飞到下一个转角格
        const from = pos
        pos += 13
        me.planes[plane] = pos
        events.push({ type: 'move', color, plane, from, to: pos, via: 'corner' })
        captureAt(game, color, pos, events)
      } else {
        // 同色格：跳到前面最近的一个同色格（步数按盘面走，不是固定 +4）
        let jumpStep = 0
        if (cellColor(abs, game) === color) {
          for (let d = 1; d <= 6; d += 1) {
            if (pos + d > LOOP - 1) break
            if (cellColor(absoluteCell(color, pos + d, game), game) === color) {
              jumpStep = d
              break
            }
          }
        }
        if (jumpStep > 0) {
          const from = pos
          pos += jumpStep
          me.planes[plane] = pos
          events.push({ type: 'move', color, plane, from, to: pos, via: 'jump' })
          captureAt(game, color, pos, events)
        } else {
          events.push({
            type: 'move',
            color,
            plane,
            from: move.from,
            to: pos,
            via: pos === HOME ? 'home' : 'step',
          })
          captureAt(game, color, pos, events)
        }
      }
    } else {
      events.push({
        type: 'move',
        color,
        plane,
        from: move.from,
        to: pos,
        via: pos === HOME ? 'home' : 'step',
      })
    }
  }

  return { ok: true, events, plane, to: me.planes[plane] }
}

/**
 * Close the current half-turn: rank a player who just brought every plane
 * home, then either keep the turn (a six) or pass it on. Returns
 * { extra, ranked, over, turn }.
 */
export function finishTurn(game) {
  const me = game.players[game.turn]
  const dice = game.dice
  let ranked = null
  if (me.planes.every((p) => p === HOME) && me.rank === 0) {
    me.rank = game.winnerOrder.length + 1
    game.winnerOrder.push(me.color)
    ranked = me.color
  }
  game.dice = null
  game.moves = []
  let extra = false
  if (ranked === null && dice === 6) {
    game.sixStreak += 1
    if (game.sixStreak >= 3) game.sixStreak = 0
    else extra = true
  } else {
    game.sixStreak = 0
  }
  if (ranked !== null) extra = false
  if (!extra) advanceTurn(game)
  return { extra, ranked, over: game.over, turn: game.turn }
}

export function advanceTurn(game) {
  const unranked = game.players.filter((p) => p.rank === 0)
  if (unranked.length <= 1) {
    if (unranked.length === 1) {
      unranked[0].rank = game.players.filter((p) => p.rank > 0).length + 1
      game.winnerOrder.push(unranked[0].color)
    }
    game.over = true
    return
  }
  for (let step = 1; step <= PLANE_COUNT; step += 1) {
    const next = (game.turn + step) % PLANE_COUNT
    if (game.players[next].rank === 0) {
      game.turn = next
      game.turnsPlayed += 1
      return
    }
  }
  game.over = true
}

/** Simple greedy chooser used by bots and by the idle-turn timeout. */
export function pickMove(game) {
  const moves = game.moves
  if (!moves || moves.length === 0) return -1
  const me = game.players[game.turn]
  let best = moves[0]
  let bestScore = -Infinity
  for (const move of moves) {
    let score = 0
    if (move.kind === 'home') score += 120
    if (move.kind === 'launch') score += 45
    if (move.kind === 'runway') score += 30
    score += Math.min(move.to, 50) * 0.4
    if (move.from >= 0 && move.from <= LOOP - 1 && move.to <= LOOP - 1) {
      const abs = absoluteCell(me.color, move.to, game)
      let captures = 0
      for (const other of game.players) {
        if (other === me) continue
        for (const p of other.planes) {
          if (p < 0 || p > LOOP - 1) continue
          if (absoluteCell(other.color, p, game) === abs) captures += 1
        }
      }
      score += captures * 35
      if (isFlightCell(abs, game)) score += 25
      if (cellColor(abs, game) === me.color) score += 15
    }
    if (score > bestScore) {
      bestScore = score
      best = move
    }
  }
  return best.plane
}

export function finishedCount(player) {
  return player.planes.filter((p) => p === HOME).length
}



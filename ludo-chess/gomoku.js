/**
 * 五子棋规则（纯逻辑，不碰网络、不碰 DOM）。
 * 15x15 棋盘，黑白轮流，先连成 5 子（横/竖/斜）者胜。
 */

export const SIZE = 15
export const WIN = 5

export function createGame(seats) {
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 2) {
    throw new Error('gomoku needs exactly 2 seats')
  }
  return {
    kind: 'gomoku',
    players: seats.map((seat, index) => ({
      cid: seat.cid,
      name: seat.name,
      color: index,
      isBot: !!seat.isBot,
    })),
    board: Array.from({ length: SIZE }, () => new Array(SIZE).fill(-1)),
    turn: 0,
    moves: 0,
    over: false,
    winner: -1,
    winLine: null,
    history: [],
    turnsPlayed: 0,
  }
}

export function inside(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < SIZE && y >= 0 && y < SIZE
}

export function cellAt(game, x, y) {
  if (!inside(x, y)) return -2
  return game.board[y][x]
}

/** 落子；返回 { ok, error } 或 { ok: true, win, line }。 */
export function place(game, color, x, y) {
  if (game.over) return { ok: false, error: '这局已经结束了' }
  if (game.turn !== color) return { ok: false, error: '还没轮到你' }
  if (!inside(x, y)) return { ok: false, error: '下在棋盘外面了' }
  if (game.board[y][x] !== -1) return { ok: false, error: '这个点已经有子了' }

  game.board[y][x] = color
  game.moves += 1
  game.history.push({ color, x, y })
  game.turnsPlayed += 1

  const line = findLine(game, x, y, color)
  if (line) {
    game.over = true
    game.winner = color
    game.winLine = line
    return { ok: true, win: true, line }
  }
  if (game.moves >= SIZE * SIZE) {
    game.over = true
    game.winner = -1
    return { ok: true, draw: true }
  }
  game.turn = 1 - game.turn
  return { ok: true }
}

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

function findLine(game, x, y, color) {
  for (const [dx, dy] of DIRECTIONS) {
    const cells = [[x, y]]
    for (const sign of [1, -1]) {
      let cx = x + dx * sign
      let cy = y + dy * sign
      while (inside(cx, cy) && game.board[cy][cx] === color) {
        cells.push([cx, cy])
        cx += dx * sign
        cy += dy * sign
      }
    }
    if (cells.length >= WIN) {
      cells.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      return cells
    }
  }
  return null
}

/** 简单机器人：能连就补，能挡就挡，否则挨着已有子下。 */
export function botMove(game, color) {
  if (game.over || game.turn !== color) return null
  const empty = []
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (game.board[y][x] !== -1) continue
      if (game.moves > 0) {
        let near = false
        for (let dy = -1; dy <= 1 && !near; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx
            const ny = y + dy
            if (inside(nx, ny) && game.board[ny][nx] !== -1) {
              near = true
              break
            }
          }
        }
        if (!near) continue
      }
      empty.push([x, y])
    }
  }
  if (!empty.length) return null
  if (game.moves === 0) return { x: 7, y: 7 }

  let best = null
  let bestScore = -1
  for (const [x, y] of empty) {
    let score = 0
    for (const [dx, dy] of DIRECTIONS) {
      let mine = 0
      let theirs = 0
      for (const sign of [1, -1]) {
        let cx = x + dx * sign
        let cy = y + dy * sign
        while (inside(cx, cy)) {
          const v = game.board[cy][cx]
          if (v === color) mine += 1
          else if (v === 1 - color) theirs += 1
          else break
          cx += dx * sign
          cy += dy * sign
        }
      }
      score += mine * 3 + theirs * 2
      if (mine >= 4) score += 60
      if (theirs >= 4) score += 50
    }
    if (score > bestScore) {
      bestScore = score
      best = { x, y }
    }
  }
  return best
}

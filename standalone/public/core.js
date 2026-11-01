/**
 * 纯逻辑：棋盘几何、落点、飞机摆位、播报文案、骰子点数。
 * 不碰 DOM —— 这样可以在 node 里直接测。
 */

export const GRID = 15
export const CELL = 40
export const BOARD = CELL * GRID
export const LOOP = 52
export const HOME = 57

/**
 * 环上 52 格（顺时针，从上方赛道左上角开始）。
 * 四个凹角是斜着跨过去的 —— 就是实物盘面拐角那几格三角形。
 */
export const RING = [
  [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0],
  [10, 1], [10, 2], [10, 3],
  [11, 4], [12, 4], [13, 4], [14, 4],
  [14, 5], [14, 6], [14, 7], [14, 8], [14, 9], [14, 10],
  [13, 10], [12, 10], [11, 10],
  [10, 11], [10, 12], [10, 13],
  [10, 14], [9, 14], [8, 14], [7, 14], [6, 14], [5, 14], [4, 14],
  [4, 13], [4, 12], [4, 11],
  [3, 10], [2, 10], [1, 10], [0, 10],
  [0, 9], [0, 8], [0, 7], [0, 6], [0, 5], [0, 4],
  [1, 4], [2, 4], [3, 4],
  [4, 3], [4, 2], [4, 1],
]

/** 每色的起飞格（环上序号）：红右下、蓝右上、黄左上、绿左下，各贴着自家机场。 */
export const START = [19, 6, 45, 32]

/** 52 格的散布色（每色 13 格），和引擎同一张表。 */
// 颜色规律：红 绿 黄 蓝 循环（起飞格例外，用自己基地的颜色）
const COLOR_CYCLE = [0, 3, 2, 1]

/** 白色安全格：停在这里不吃人也不被吃。 */
export const SAFE_CELLS = new Set([3, 7, 9, 20, 25, 33, 41, 46])

/** 四个斜角转弯格（照片里是斜切的三角/菱形格）。 */
export const CORNER_CELLS = new Set([9, 22, 35, 48])

/** 每色回家的 5 格（从外往内）：红右、蓝上、黄左、绿下。 */
export const RUNWAYS = [
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
]

/** 每色完整的回家道（画图用，和 RUNWAYS 一致）。 */
export const RUNWAY_LANES = [
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
]

/** 机场：红右下、蓝右上、黄左上、绿左下（和盘面图一致）。 */
export const HANGAR_ORIGIN = [
  [11, 11],
  [11, 0],
  [0, 0],
  [0, 11],
]

/** 中央风车：每色三角的质心（格坐标）。 */
const HOME_CENTROID = [
  [8.5, 7.5],
  [6.5, 7.5],
  [7.5, 8.5],
  [7.5, 6.5],
]

const FLIGHT = new Set([11, 24, 37, 50])
const STACK = [
  [0, 0],
  [-6, 5],
  [6, 5],
  [0, -7],
  [-7, -5],
  [7, -5],
]

/** 环上第 index 格在 15x15 棋盘里的列/行。 */
export function cellOf(index) {
  return RING[index]
}

/**
 * 格子的颜色：红 → 绿 → 黄 → 蓝 四格一循环；四个起飞格例外，用自己基地的颜色。
 */
let BOARD_OVERRIDE = null

/** 房主自定义的棋盘（null = 用内置布局）。 */
export function setBoardOverride(board) {
  BOARD_OVERRIDE = board && typeof board === 'object' ? board : null
}

export function boardOverride() {
  return BOARD_OVERRIDE
}

export function startList() {
  const custom = BOARD_OVERRIDE && BOARD_OVERRIDE.start
  if (Array.isArray(custom) && custom.length === 4 && custom.every((n) => Number.isInteger(n))) return custom
  return START
}

export function cellColor(index) {
  const colors = BOARD_OVERRIDE && BOARD_OVERRIDE.colors
  if (Array.isArray(colors)) {
    const value = colors[index]
    if (Number.isInteger(value) && value >= 0 && value <= 3) return value
  }
  const own = START.indexOf(index)
  if (own >= 0) return own
  return COLOR_CYCLE[index % 4]
}

export function isSafeCell(index) {
  const custom = BOARD_OVERRIDE && BOARD_OVERRIDE.safe
  if (Array.isArray(custom)) return custom.includes(index)
  return SAFE_CELLS.has(index)
}

export function isCornerCell(index) {
  return CORNER_CELLS.has(index)
}

export function isStartCell(index) {
  return startList().includes(index)
}

export function isFlightCell(index) {
  const custom = BOARD_OVERRIDE && BOARD_OVERRIDE.flight
  if (Array.isArray(custom)) return custom.includes(index)
  return FLIGHT.has(index)
}

/** 中央风车里的四个停机位（像素坐标）。 */
export function homeSlots(color) {
  const [c, r] = HOME_CENTROID[color]
  const d = 0.28
  return [
    [(c - d) * CELL, (r - d) * CELL],
    [(c + d) * CELL, (r - d) * CELL],
    [(c - d) * CELL, (r + d) * CELL],
    [(c + d) * CELL, (r + d) * CELL],
  ]
}

export function hangarSlots(color) {
  const [c, r] = HANGAR_ORIGIN[color]
  return [
    [(c + 1) * CELL, (r + 1) * CELL],
    [(c + 3) * CELL, (r + 1) * CELL],
    [(c + 1) * CELL, (r + 3) * CELL],
    [(c + 3) * CELL, (r + 3) * CELL],
  ]
}

/** 某色某进度落在哪个格子（列/行）；机场返回 null。 */
export function positionOf(color, pos) {
  if (pos < 0) return null
  if (pos === HOME) return null
  if (pos >= LOOP) return RUNWAYS[color][Math.min(pos - LOOP, 4)]
  return cellOf((startList()[color] + pos) % LOOP)
}

/** 棋子上飞机的图形（以 0,0 为中心的小纸飞机）。 */
export function planePath(size = 8) {
  const s = size
  return (
    'M0 ' + -s +
    ' L' + s * 0.85 + ' ' + s * 0.72 +
    ' L0 ' + s * 0.32 +
    ' L' + -s * 0.85 + ' ' + s * 0.72 + ' Z'
  )
}

/**
 * 飞机该朝哪儿飞（角度，0 = 朝上）。
 * 机场起飞时算"从机位飞向起飞格"；其余按上一格到这一格的方向。
 */
export function headingFor(color, index, fromPos, toPos) {
  let from = fromPos >= 0 ? positionOf(color, fromPos) : null
  if (!from) {
    const slot = hangarSlots(color)[index] ?? hangarSlots(color)[0]
    from = [slot[0] / CELL, slot[1] / CELL]
  }
  const to = positionOf(color, toPos)
  if (!to) return 0
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (dx === 0 && dy === 0) return 0
  return (Math.atan2(dy, dx) * 180) / Math.PI + 90
}

/** 飞行格 +12 之后落在哪一格（用于画虚线捷径）。 */
export function flightTarget(cell) {
  return (cell + 12) % LOOP
}

/** 快捷交流的固定短语。 */
export const QUICK_PHRASES = ['快点啦～', '好棋！', '我手气不行', '别撞我', '笑死', '再来一局']

/** 局内互动表情（服务器同一份白名单）。 */
export const REACTIONS = ['👍', '😂', '😭', '🎉', '🔥', '666']

/**
 * 把房间里的四家飞机摊平成一组 {key,x,y,...}，同格的飞机自动错开。
 * key 用来认出"同一个棋子"，界面据此复用元素做位移动画。
 */
export function buildTokens(members) {
  const tokens = []
  members.forEach((member, order) => {
    const color = member.color ?? order
    const planes = member.planes ?? [-1, -1, -1, -1]
    const hangar = hangarSlots(color)
    const homes = homeSlots(color)
    for (let index = 0; index < 4; index += 1) {
      const pos = planes[index]
      let key
      let x
      let y
      if (pos === -1) {
        key = 'h' + color + '-' + index
        x = hangar[index][0]
        y = hangar[index][1]
      } else if (pos === HOME) {
        key = 'm' + color + '-' + index
        x = homes[index][0]
        y = homes[index][1]
      } else if (pos >= LOOP) {
        const cell = RUNWAYS[color][Math.min(pos - LOOP, 4)]
        key = 'r' + color + '-' + pos
        x = cell[0] * CELL + CELL / 2
        y = cell[1] * CELL + CELL / 2
      } else {
        const absolute = (START[color] + pos) % LOOP
        const cell = cellOf(absolute)
        key = 'c' + absolute
        x = cell[0] * CELL + CELL / 2
        y = cell[1] * CELL + CELL / 2
      }
      tokens.push({ key, x, y, color, index, pos, name: member.name, cid: member.cid })
    }
  })

  const groups = new Map()
  for (const token of tokens) {
    const bucket = groups.get(token.key)
    if (bucket) bucket.push(token)
    else groups.set(token.key, [token])
  }
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue
    bucket.forEach((token, index) => {
      const offset = STACK[index % STACK.length]
      token.x += offset[0]
      token.y += offset[1]
    })
  }
  return tokens
}

export const DICE_PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

export const COLOR_KEYS = ['red', 'blue', 'amber', 'green']

/** 界面文案：想改词直接改这里。 */
export const TEXT = {
  title: '飞行棋',
  tagline: '四个人、一副骰子、一条跑道。掷 6 才能起飞。',
  you: '你',
  host: '房主',
  bot: '机器人',
  offline: '离线',
  lobbyName: '昵称',
  lobbyCreate: '创建房间',
  lobbyRefresh: '刷新',
  lobbyCode: '房间号',
  lobbyJoin: '加入',
  lobbyRooms: '房间列表',
  lobbyEmpty: '还没有房间，创建一个吧。',
  lobbyFull: '已满',
  lobbyPlaying: '进行中',
  lobbyWaiting: '等待中',
  lobbyPeople: '人',
  lobbyShare: '让朋友打开这个地址',
  copy: '复制',
  copied: '已复制',
  start: '开始游戏',
  startConfirm: '确认开局 · 补 {n} 个机器人',
  addBot: '添加机器人',
  leave: '离开房间',
  rematch: '再来一局',
  fillHint: '点开始就立刻开局，空位补机器人（满 4 人）',
  waitHost: '等待房主开始…',
  seats: '座位',
  roomCode: '房间号',
  netConnecting: '连接中',
  netOnline: '已连接',
  netOffline: '已断开，重连中',
  yourTurn: '轮到你了',
  rollPrompt: '点骰子，或者按下面的按钮',
  pickPlane: '选一架飞机',
  pickHint: '点棋盘上闪烁的飞机',
  waiting: '等待 {name}',
  waitingMove: '{name} 正在走棋',
  roll: '掷骰子',
  over: '对局结束',
  lastPlace: '最后一名',
  place: '第 {n} 名',
  plane: '{n} 号机',
  launch: '起飞',
  toHome: '直达终点',
  advance: '前进 {n} 格',
  chatPlaceholder: '说点什么…',
  chatSend: '发送',
  voiceHold: '按住说话',
  voiceRecording: '录音中',
  voiceSendHint: '松手发送',
  voiceDenied: '麦克风没打开（浏览器拦了）',
  voiceUnsupported: '这个浏览器不支持录音',
  voicePlay: '播放',
  voiceTooShort: '太短了，按住多说一会儿',
  feedEmpty: '还没有人说话。',
  settings: '设置',
  animation: '动画',
  sound: '音效',
  speed: '动画速度',
  speedSlow: '慢',
  speedNormal: '标准',
  speedFast: '快',
  speedOff: '关',
  theme: '配色',
  themeClassic: '经典',
  themeVivid: '鲜明',
  themeCandy: '糖果',
  close: '关闭',
  saved: '设置已保存',
  'feed.roll': '掷出 {n}',
  'feed.step': '前进 {n} 格',
  'feed.launch': '一架飞机起飞',
  'feed.jump': '踩到同色格，跳跃 +4',
  'feed.fly': '走上飞行格，飞行 +12',
  'feed.home': '一架飞机到达终点',
  'feed.capture': '撞回了 {who} 的 {n} 架飞机',
  'feed.pass': '无棋可走',
  'feed.rank': '第 {n} 名完成',
  'feed.over': '对局结束',
  'feed.join': '{name} 加入了房间',
  'feed.leave': '{name} 离开了房间',
  'feed.bot': '{name} 加入了对局',
  'feed.create': '{name} 创建了房间',
  'feed.start': '对局开始，每人 4 架飞机',
  'feed.restart': '新的一局开始了',
  'feed.takeover': '{name} 离开，由机器人接管',
  'feed.timeout': '{name} 超时，自动出棋',
  'feed.orphan': '清理了 {n} 个离线座位',
  'feed.sys': '提示',
  'color.red': '红方',
  'color.blue': '蓝方',
  'color.amber': '黄方',
  'color.green': '绿方',
}

export function fmt(text, params) {
  if (!params) return text
  let out = text
  for (const key of Object.keys(params)) {
    out = out.split('{' + key + '}').join(String(params[key]))
  }
  return out
}

export function t(key, params) {
  return fmt(TEXT[key] ?? key, params)
}

function colorName(color, members) {
  const member = members.find((item) => item.color === color)
  return member ? member.name : t('color.' + (COLOR_KEYS[color] ?? 'red'))
}

/** 一条播报 → 一句中文。chat 由界面单独排版。 */
export function feedText(entry, members = []) {
  const name = (color) => colorName(color, members)
  switch (entry.kind) {
    case 'roll':
      return name(entry.color) + ' ' + t('feed.roll', { n: entry.dice })
    case 'move': {
      if (entry.via === 'launch') return name(entry.color) + ' ' + t('feed.launch')
      if (entry.via === 'fly') return name(entry.color) + ' ' + t('feed.fly')
      if (entry.via === 'jump') return name(entry.color) + ' ' + t('feed.jump')
    if (entry.via === 'corner') return name(entry.color) + ' · 十字直飞 +13'
      if (entry.via === 'home') return name(entry.color) + ' ' + t('feed.home')
      return name(entry.color) + ' ' + t('feed.step', { n: entry.to - entry.from })
    }
    case 'capture':
      return name(entry.color) + ' ' + t('feed.capture', { who: name(entry.victim), n: entry.count })
    case 'pass':
      return name(entry.color) + ' ' + t('feed.pass')
    case 'rank':
      return name(entry.color) + ' ' + t('feed.rank', { n: entry.place })
    case 'over':
      return (
        t('feed.over') +
        ' · ' +
        entry.order.map((row) => row.name + ' ' + t('place', { n: row.rank })).join(' / ')
      )
    case 'join':
      return t('feed.join', { name: entry.name })
    case 'leave':
      return t('feed.leave', { name: entry.name })
    case 'bot':
      return t('feed.bot', { name: entry.name })
    case 'create':
      return t('feed.create', { name: entry.name })
    case 'start':
      return t('feed.start')
    case 'restart':
      return t('feed.restart')
    case 'takeover':
      return t('feed.takeover', { name: name(entry.color) })
    case 'timeout':
      return t('feed.timeout', { name: name(entry.color) })
    case 'orphan':
      return t('feed.orphan', { n: entry.count })
    case 'reaction':
      return name(entry.color) + ' ' + entry.emoji
    case 'voice':
      return name(entry.color) + ' 发了一条语音'
    default:
      return entry.text ?? t('feed.sys')
  }
}

/** 一条走法在按钮上怎么写。 */
export function moveLabel(move) {
  const plane = fmt(t('plane'), { n: move.plane + 1 })
  if (move.kind === 'launch') return plane + ' · ' + t('launch')
  if (move.kind === 'home') return plane + ' · ' + t('toHome')
  return plane + ' · ' + t('advance', { n: move.to - move.from })
}




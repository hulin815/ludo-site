/**
 * 界面与联网。规则、几何、文案在 core.js；可调参数在 config.js。
 */
import {
  BOARD,
  CELL,
  HOME,
  LOOP,
  RUNWAY_LANES,
  HANGAR_ORIGIN,
  cellOf,
  cellColor,
  isStartCell,
  isFlightCell,
  isSafeCell,
  isCornerCell,
  START,
  setBoardOverride,
  startList,
  homeSlots,
  hangarSlots,
  buildTokens,
  DICE_PIPS,
  TEXT,
  t,
  fmt,
  feedText,
  moveLabel,
  planePath,
  positionOf,
  flightTarget,
  QUICK_PHRASES,
  REACTIONS,
} from './core.js'
import { DURATION, SPEEDS, THEMES, applyTheme, loadSettings, saveSettings, speedFactor } from './config.js'
import { createAudio } from './audio.js'

const NS = 'http://www.w3.org/2000/svg'
const $ = (id) => document.getElementById(id)
const settings = loadSettings()
const audio = createAudio()

const state = {
  status: 'connecting',
  you: null,
  room: null,
  rooms: [],
  name: loadName(),
  lastRoomId: null,
  lastFeedId: 0,
  rollUntil: 0,
  fakeFace: 1,
  editing: false,
  editMode: 'color',
  editColor: 0,
  boardRef: null,
  armedUntil: 0,
  queue: [],
  seq: 0,
  sid: 's' + Math.random().toString(36).slice(2, 12),
  cid: sessionCid(),
  rtt: 0,
  lastTurnKey: null,
  ghost: null,
  echoes: [],
  headings: {},
}

const tokenEls = new Map()
let fxLayer = null
let tokenLayer = null
let hintLayer = null
let diceNode = null
let diceTimer = null
let abortController = null
let needHello = true
let failures = 0
let alive = true
let toastTimer = null
let shareUrl = location.origin

let PALETTE = []

// ------------------------------------------------------------------ 小工具
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

function button(label, onClick, className = 'btn') {
  const node = el('button', className, label)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

function rgba(hex, alpha) {
  const value = String(hex).replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
}

function motionFactor() {
  return speedFactor(settings)
}

function sessionCid() {
  try {
    const stored = sessionStorage.getItem('ludo.cid')
    if (stored && /^[A-Za-z0-9_-]{6,64}$/.test(stored)) return stored
  } catch (error) {
    /* ignore */
  }
  const fresh = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  try {
    sessionStorage.setItem('ludo.cid', fresh)
  } catch (error) {
    /* ignore */
  }
  return fresh
}

function loadName() {
  try {
    return localStorage.getItem('ludo.name') ?? ''
  } catch (error) {
    return ''
  }
}

function saveName(name) {
  try {
    localStorage.setItem('ludo.name', name)
  } catch (error) {
    /* ignore */
  }
}

function toast(text) {
  const node = $('toast')
  node.textContent = text
  node.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    node.hidden = true
  }, 3200)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (inner) {
      ok = false
    }
    area.remove()
    return ok
  }
}

// ------------------------------------------------------------------ 外观
function applyDurations() {
  const factor = motionFactor()
  const root = document.documentElement
  root.style.setProperty('--d-move', Math.round(DURATION.move * factor) + 'ms')
  root.style.setProperty('--d-dice', Math.round(DURATION.dice * factor) + 'ms')
  root.style.setProperty('--d-takeoff', Math.round(DURATION.takeoff * factor) + 'ms')
  root.style.setProperty('--d-capture', Math.round(DURATION.capture * factor) + 'ms')
}

function applyLook() {
  const theme = applyTheme(settings)
  PALETTE = [theme.red, theme.blue, theme.amber, theme.green]
  applyDurations()
}

// ------------------------------------------------------------------ 棋盘
function buildBoard() {
  // 棋盘完全按棋子使用的同一套格子坐标来画：格心 = positionOf() 的落点
  buildVectorBoard()
}

function buildVectorBoard() {
  const svg = $('board')
  svg.textContent = ''
  tokenEls.clear()
  diceNode = null

  svg.appendChild(
    svgEl('rect', {
      x: 0,
      y: 0,
      width: BOARD,
      height: BOARD,
      rx: 26,
      fill: '#1f4e8c',
      stroke: 'rgba(0,0,0,.12)',
    }),
  )

  // 飞行捷径：从飞行格斜穿到 +12 格的位置（画在格子下面）
  for (let cell = 0; cell < LOOP; cell += 1) {
    if (!isFlightCell(cell)) continue
    const from = cellOf(cell)
    const to = cellOf(flightTarget(cell))
    svg.appendChild(
      svgEl('line', {
        x1: from[0] * CELL + CELL / 2,
        y1: from[1] * CELL + CELL / 2,
        x2: to[0] * CELL + CELL / 2,
        y2: to[1] * CELL + CELL / 2,
        stroke: 'rgba(20,20,24,.22)',
        'stroke-width': 4,
        'stroke-dasharray': '2 9',
        'stroke-linecap': 'round',
      }),
    )
  }

  // 四角机场：整块实色 + 四个白圈机位
  for (let color = 0; color < 4; color += 1) {
    const [col, row] = HANGAR_ORIGIN[color]
    const group = svgEl('g')
    group.appendChild(
      svgEl('rect', {
        x: col * CELL + 4,
        y: row * CELL + 4,
        width: CELL * 4 - 8,
        height: CELL * 4 - 8,
        rx: 16,
        fill: PALETTE[color],
        stroke: 'rgba(0,0,0,.2)',
        'stroke-width': 1.5,
      }),
    )
    for (const [x, y] of hangarSlots(color)) {
      group.appendChild(svgEl('circle', { cx: x, cy: y, r: 15, fill: 'rgba(255,255,255,.92)' }))
      group.appendChild(
        svgEl('path', {
          d: planePath(9),
          fill: PALETTE[color],
          opacity: 0.85,
          transform: 'translate(' + x + ',' + y + ')',
          'pointer-events': 'none',
        }),
      )
    }
    svg.appendChild(group)
  }

  // 回家道：外围铺白缝，里面一格一格画（黑分隔线），格心大白点
  for (let color = 0; color < 4; color += 1) {
    const lane = RUNWAY_LANES[color]
    const cols = lane.map(([c]) => c)
    const rows = lane.map(([, r]) => r)
    const minCol = Math.min(...cols)
    const maxCol = Math.max(...cols)
    const minRow = Math.min(...rows)
    const maxRow = Math.max(...rows)
    svg.appendChild(
      svgEl('rect', {
        x: minCol * CELL - 3,
        y: minRow * CELL - 3,
        width: (maxCol - minCol + 1) * CELL + 6,
        height: (maxRow - minRow + 1) * CELL + 6,
        rx: 4,
        fill: '#ffffff',
        'pointer-events': 'none',
      }),
    )
    for (const [col, row] of lane) {
      svg.appendChild(
        svgEl('rect', {
          x: col * CELL + 1,
          y: row * CELL + 1,
          width: CELL - 2,
          height: CELL - 2,
          rx: 1.5,
          fill: PALETTE[color],
          stroke: 'rgba(0,0,0,.55)',
          'stroke-width': 1.4,
          'pointer-events': 'none',
        }),
      )
      svg.appendChild(
        svgEl('circle', {
          cx: col * CELL + CELL / 2,
          cy: row * CELL + CELL / 2,
          r: 13,
          fill: '#ffffff',
          'pointer-events': 'none',
        }),
      )
    }
  }

  // 中央风车：四个三角对应四条回家道的颜色（上绿、右红、下黄、左蓝）
  const mid = 7.5 * CELL
  const edge = [
    [6 * CELL, 6 * CELL],
    [9 * CELL, 6 * CELL],
    [9 * CELL, 9 * CELL],
    [6 * CELL, 9 * CELL],
  ]
  const wedgeColor = [1, 0, 3, 2]
  for (let wedge = 0; wedge < 4; wedge += 1) {
    const a = edge[wedge]
    const b = edge[(wedge + 1) % 4]
    svg.appendChild(
      svgEl('polygon', {
        points: a[0] + ',' + a[1] + ' ' + b[0] + ',' + b[1] + ' ' + mid + ',' + mid,
        fill: PALETTE[wedgeColor[wedge]],
        stroke: 'rgba(0,0,0,.18)',
      }),
    )
  }

  // 中央四个三角外缘各一个白点（等于回家道的第 6 格）
  for (const [dx2, dy2] of [[0, -0.85], [0.85, 0], [0, 0.85], [-0.85, 0]]) {
    svg.appendChild(
      svgEl('circle', {
        cx: mid + dx2 * CELL / 2,
        cy: mid + dy2 * CELL / 2,
        r: 9,
        fill: 'rgba(255,255,255,.92)',
        'pointer-events': 'none',
      }),
    )
  }
  // 中央小方块（图里中心那块蓝方块 + 白点）
  svg.appendChild(
    svgEl('rect', {
      x: mid - 15,
      y: mid - 15,
      width: 30,
      height: 30,
      fill: PALETTE[1],
      stroke: 'rgba(0,0,0,.18)',
    }),
  )
  svg.appendChild(svgEl('circle', { cx: mid, cy: mid, r: 6.5, fill: 'rgba(255,255,255,.92)' }))
  const midLabel = svgEl('text', {
    x: mid,
    y: mid + 3,
    'text-anchor': 'middle',
    'font-size': 7,
    'font-weight': 800,
    fill: '#1f4e8c',
    'pointer-events': 'none',
  })
  midLabel.textContent = '终点'
  svg.appendChild(midLabel)
  // 赛道 52 格：实色块 + 白圈；白色安全格、起飞格写 GO、飞行格画小飞机
  for (let index = 0; index < LOOP; index += 1) {
    const [col, row] = cellOf(index)
    const color = cellColor(index)
    const safe = isSafeCell(index) && !isStartCell(index)
    const start = isStartCell(index)
    const flight = isFlightCell(index)
    const cx = col * CELL + CELL / 2
    const cy = row * CELL + CELL / 2
    const corner = isCornerCell(index)
    const group = svgEl('g')
    if (start) {
      // 起飞点：整格用基地色，靠机场的那半边淡一点 = 起飞点
      const x0 = col * CELL + 2.5
      const y0 = row * CELL + 2.5
      const x1 = x0 + CELL - 5
      const y1 = y0 + CELL - 5
      const baseColor = START.indexOf(index) >= 0 ? START.indexOf(index) : color
      const [bc, br] = HANGAR_ORIGIN[baseColor]
      const towardBaseX = bc + 2 - (col + 0.5)
      const towardBaseY = br + 2 - (row + 0.5)
      group.appendChild(
        svgEl('rect', {
          x: x0,
          y: y0,
          width: CELL - 5,
          height: CELL - 5,
          rx: 8,
          fill: PALETTE[baseColor],
          stroke: 'rgba(0,0,0,.22)',
        }),
      )
      group.appendChild(
        svgEl('rect', {
          x: x0,
          y: y0,
          width: CELL - 5,
          height: CELL - 5,
          rx: 6,
          fill: 'none',
          stroke: 'rgba(0,0,0,.35)',
          'stroke-width': 2,
        }),
      )
    } else if (corner) {
      // 转角格：正方形沿斜线对半分，两半不同色（一半本色、一半相邻基地色）
      const x0 = col * CELL + 2.5
      const y0 = row * CELL + 2.5
      const x1 = x0 + CELL - 5
      const y1 = y0 + CELL - 5
      const partnerX = col < 7 ? 0 : 11
      const partnerY = row < 7 ? 0 : 11
      const partner = HANGAR_ORIGIN.findIndex(([pc, pr]) => pc === partnerX && pr === partnerY)
      group.appendChild(
        svgEl('polygon', {
          points: x0 + ',' + y0 + ' ' + x1 + ',' + y0 + ' ' + x1 + ',' + y1,
          fill: PALETTE[color],
        }),
      )
      group.appendChild(
        svgEl('polygon', {
          points: x0 + ',' + y0 + ' ' + x1 + ',' + y1 + ' ' + x0 + ',' + y1,
          fill: PALETTE[partner >= 0 ? partner : color],
        }),
      )
      group.appendChild(
        svgEl('rect', {
          x: x0,
          y: y0,
          width: CELL - 5,
          height: CELL - 5,
          rx: 6,
          fill: 'none',
          stroke: 'rgba(0,0,0,.3)',
          'stroke-width': 1.6,
        }),
      )
    } else {
      group.appendChild(
        svgEl('rect', {
          x: col * CELL + 2.5,
          y: row * CELL + 2.5,
          width: CELL - 5,
          height: CELL - 5,
          rx: 8,
          fill: safe ? 'rgba(250,250,252,.96)' : PALETTE[color],
          stroke: safe ? PALETTE[color] : 'rgba(0,0,0,.2)',
          'stroke-width': safe ? 2 : 1,
        }),
      )
    }
    group.appendChild(
      svgEl('circle', {
        cx,
        cy,
        r: safe ? 8 : 11.5,
        fill: safe ? PALETTE[color] : 'rgba(255,255,255,.92)',
        opacity: safe ? 0.9 : 1,
      }),
    )
    if (start) {
      // 起飞点就是格子里的白点，不再写字
    } else if (flight) {
      group.appendChild(
        svgEl('path', {
          d: planePath(6.5),
          fill: PALETTE[color],
          transform: 'translate(' + cx + ',' + cy + ')',
          'pointer-events': 'none',
        }),
      )
    }
    group.addEventListener('click', (event) => {
      if (!state.editing) return
      event.stopPropagation()
      onCellClick(index)
    })
    const title = svgEl('title')
    title.textContent =
      t('color.' + ['red', 'blue', 'amber', 'green'][color]) +
      (start ? ' · 起飞格（安全格）' : safe ? ' · 安全格' : '') +
      (flight ? ' · 飞行格 +12' : '')
    group.appendChild(title)
    svg.appendChild(group)
  }

  // 转弯箭头：只画在四个斜角格上，顺着行进方向
  for (let index = 0; index < LOOP; index += 1) {
    if (!isCornerCell(index)) continue
    const [col, row] = cellOf(index)
    const [nc, nr] = cellOf((index + 1) % LOOP)
    const dx = nc - col
    const dy = nr - row
    const cx = col * CELL + CELL / 2
    const cy = row * CELL + CELL / 2
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    svg.appendChild(
      svgEl('path', {
        d: 'M0,-5.5 L4.5,3.5 L0,1.8 L-4.5,3.5 Z',
        fill: 'rgba(25,25,30,.8)',
        transform: 'translate(' + cx + ',' + cy + ') rotate(' + angle.toFixed(1) + ')',
        'pointer-events': 'none',
      }),
    )
  }

  // START 标记：贴在各基地外侧（棋盘边缘外一点），箭头指向该色起飞格
  const START_TAG = [
    [15.15, 12.5],
    [12.5, -0.15],
    [-0.15, 1.5],
    [1.5, 15.15],
  ]
  for (let color = 0; color < 4; color += 1) {
    const px = START_TAG[color][0] * CELL
    const py = START_TAG[color][1] * CELL
    const [tagC, tagR] = cellOf(START[color])
    const tagDx = tagC * CELL + CELL / 2 - px
    const tagDy = tagR * CELL + CELL / 2 - py
    const tagLen = Math.hypot(tagDx, tagDy) || 1
    const arrow = [tagDx / tagLen, tagDy / tagLen]
    const tag = svgEl('g', { 'pointer-events': 'none' })
    tag.appendChild(
      svgEl('circle', {
        cx: px,
        cy: py,
        r: 21,
        fill: 'rgba(255,255,255,.96)',
        stroke: PALETTE[color],
        'stroke-width': 2.4,
      }),
    )
    // 指向起飞格的箭头
    const ax = px + arrow[0] * 30
    const ay = py + arrow[1] * 30
    const angle = (Math.atan2(arrow[1], arrow[0]) * 180) / Math.PI + 90
    tag.appendChild(
      svgEl('path', {
        d: 'M0,-6 L5,4 L0,2 L-5,4 Z',
        fill: PALETTE[color],
        transform: 'translate(' + ax + ',' + ay + ') rotate(' + angle.toFixed(1) + ')',
      }),
    )
    const label = svgEl('text', {
      x: px,
      y: py + 3.4,
      'text-anchor': 'middle',
      'font-size': 9,
      'font-weight': 800,
      fill: PALETTE[color],
    })
    label.textContent = '起点'
    tag.appendChild(label)
    svg.appendChild(tag)
  }

  // 四组方向箭头（绿→ / 黄↓ / 红↑ / 蓝←），画在十字内侧的空白里
  const QUADS = [
    { at: [5.1, 5.1], color: 3, dir: [1, 0] },
    { at: [9.9, 5.1], color: 2, dir: [0, 1] },
    { at: [5.1, 9.9], color: 0, dir: [0, -1] },
    { at: [9.9, 9.9], color: 1, dir: [-1, 0] },
  ]
  for (const quad of QUADS) {
    const angle = (Math.atan2(quad.dir[1], quad.dir[0]) * 180) / Math.PI
    for (let step = 0; step < 3; step += 1) {
      const qx = (quad.at[0] + quad.dir[0] * step * 0.42) * CELL
      const qy = (quad.at[1] + quad.dir[1] * step * 0.42) * CELL
      svg.appendChild(
        svgEl('path', {
          d: 'M-6,-5 L2,0 L-6,5',
          fill: 'none',
          stroke: PALETTE[quad.color],
          'stroke-width': 3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          opacity: 0.9,
          transform: 'translate(' + qx + ',' + qy + ') rotate(' + angle + ')',
          'pointer-events': 'none',
        }),
      )
    }
  }
  fxLayer = svgEl('g', { id: 'fx' })
  hintLayer = svgEl('g', { id: 'hints' })
  tokenLayer = svgEl('g', { id: 'tokens' })
  svg.appendChild(fxLayer)
  svg.appendChild(hintLayer)
  svg.appendChild(tokenLayer)
}

function ensureToken(token) {
  const planeId = token.color + '-' + token.index
  let node = tokenEls.get(planeId)
  if (node) return node
  node = svgEl('g', { class: 'tok' })
  node.style.setProperty('--pc', PALETTE[token.color])
  node.style.transform = 'translate(' + token.x + 'px,' + token.y + 'px)'
  node.appendChild(svgEl('circle', { class: 'ring', r: 19 }))
  const body = svgEl('g', { class: 'tok-body' })
  const dir = svgEl('g', { class: 'tok-dir' })
  dir.appendChild(svgEl('circle', { class: 'halo', r: 13.5, fill: 'rgba(0,0,0,.28)' }))
  dir.appendChild(svgEl('circle', { class: 'disc', r: 12.5, fill: PALETTE[token.color] }))
  dir.appendChild(svgEl('path', { d: planePath(9), fill: '#fff', 'pointer-events': 'none' }))
  body.appendChild(dir)
  node.appendChild(body)
  node.__dir = dir
  const title = svgEl('title')
  title.textContent = token.name + ' · ' + fmt(t('plane'), { n: token.index + 1 })
  node.appendChild(title)
  node.addEventListener('click', () => {
    if (!node.dataset.movable) return
    if (Date.now() < state.rollUntil) return
    sendMove(Number(node.dataset.plane))
  })
  tokenLayer.appendChild(node)
  tokenEls.set(planeId, node)
  return node
}

function syncTokens(room) {
  if (!room || !tokenLayer) return
  const tokens = buildTokens(membersForRender(room))
  const me = room.you
  const game = room.game
  // 服务端状态已经追上（或者换手了），本地预览就该退场
  if (state.ghost && game) {
    const member = room.members[state.ghost.color]
    const pos = member?.planes?.[state.ghost.plane]
    if (pos === state.ghost.to || game.turns !== state.ghost.turns) state.ghost = null
  }
  const awaitingMove = !!(game && me && game.turn === me.color && game.dice !== null && !game.over)
  const movable = new Set(awaitingMove ? (game.moves ?? []).map((move) => move.plane) : [])
  const revealed = Date.now() >= state.rollUntil

  for (const token of tokens) {
    const node = ensureToken(token)
    node.style.transform = 'translate(' + token.x + 'px,' + token.y + 'px)'
    node.style.opacity = token.pos === -1 ? '0.78' : '1'
    // 飞机一律正着放（不按走向旋转）
    if (node.__dir) node.__dir.style.transform = 'rotate(0deg)'
    const canMove =
      !!(me && token.color === me.color && movable.has(token.index)) && revealed && !state.ghost
    node.dataset.plane = String(token.index)
    node.dataset.movable = canMove ? '1' : ''
    node.classList.toggle('movable', canMove)
  }
}

/** 把"我已经点过、但服务端还没回话"的那一步先画上去。 */
function membersForRender(room) {
  const ghost = state.ghost
  if (!ghost || !room?.game) return room.members
  return room.members.map((member) => {
    if (member.color !== ghost.color) return member
    const planes = member.planes.slice()
    planes[ghost.plane] = ghost.to
    return { ...member, planes }
  })
}

/** 点棋子：本地先走，服务端回话后对账。 */
function sendMove(plane) {
  const room = state.room
  if (!room?.game || !room.you || room.game.over) return
  if (state.ghost) return
  if (Date.now() < state.rollUntil) return
  const move = (room.game.moves ?? []).find((item) => item.plane === plane)
  if (!move) return
  state.ghost = {
    color: room.you.color,
    plane,
    to: move.to,
    turns: room.game.turns,
    at: Date.now(),
  }
  send({ t: 'move', plane })
  syncTokens(room)
  renderTurn()
  setTimeout(() => {
    if (state.ghost && Date.now() - state.ghost.at >= 2400) {
      state.ghost = null
      if (state.room) {
        syncTokens(state.room)
        renderTurn()
      }
    }
  }, 2500)
}

function markPlane(color, index, className, ms) {
  const node = tokenEls.get(color + '-' + index)
  if (!node) return
  node.classList.add(className)
  setTimeout(() => node.classList.remove(className), ms)
}

/** 语音播报：用系统 TTS，挑中文音色、开机预热，尽量快、尽量像人说话。 */
let speechVoice = null
let speechReady = false

function pickSpeechVoice() {
  if (typeof speechSynthesis === 'undefined') return
  const list = speechSynthesis.getVoices && speechSynthesis.getVoices ? speechSynthesis.getVoices() : []
  if (!list || !list.length) return
  const zh = list.filter((voice) => /zh[-_]?(CN|Hans)/i.test(voice.lang) || /中文|普通话/i.test(voice.name))
  const order = [/Yaoyao/i, /Xiaoxiao/i, /Xiaoyi/i, /Kangkang/i, /Google/i, /Huihui/i]
  let prefer = null
  for (const pattern of order) {
    prefer = zh.find((voice) => pattern.test(voice.name))
    if (prefer) break
  }
  speechVoice = prefer || zh[0] || null
  speechReady = true
}

function warmSpeech() {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return
  pickSpeechVoice()
  speechSynthesis.onvoiceschanged = pickSpeechVoice
  // 预热：先念一个空串，把引擎叫醒（否则第一次要等 1 秒以上）
  try {
    const warm = new SpeechSynthesisUtterance('。')
    warm.volume = 0
    warm.rate = 3
    speechSynthesis.speak(warm)
  } catch (error) {
    /* ignore */
  }
}

function speak(text) {
  if (!settings.sound || !text) return
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return
  if (!speechReady) pickSpeechVoice()
  // 没有中文音色时别用英文腔硬念，直接退回提示音
  if (speechReady && !speechVoice) {
    audio.play('chat')
    return
  }
  try {
    const line = new SpeechSynthesisUtterance(String(text))
    line.lang = 'zh-CN'
    if (speechVoice) line.voice = speechVoice
    line.rate = 0.98
    line.pitch = 1.0
    line.volume = 1
    if (speechSynthesis.paused) speechSynthesis.resume()
    if (speechSynthesis.speaking) speechSynthesis.cancel()
    speechSynthesis.speak(line)
  } catch (error) {
    /* 不支持就算了 */
  }
}

function playerName(color) {
  const room = state.room
  const member = room && room.members ? room.members.find((item) => item.color === color) : null
  return member ? member.name : ''
}

/** 起飞特效：双扩散环 + 光晕 + 八道速度线 + “起飞!”字 */
function takeoffBurst(color, cell) {
  if (!cell || !fxLayer) return
  const cx = cell[0] * CELL + CELL / 2
  const cy = cell[1] * CELL + CELL / 2
  const hue = PALETTE[color] ?? '#fff'
  const group = svgEl('g', { class: 'fx-takeoff', transform: 'translate(' + cx + ',' + cy + ')' })
  group.appendChild(svgEl('circle', { class: 'takeoff-ring', r: 15, stroke: hue }))
  group.appendChild(svgEl('circle', { class: 'takeoff-ring late', r: 15, stroke: hue }))
  group.appendChild(svgEl('circle', { class: 'takeoff-glow', r: 26, fill: hue }))
  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI * 2 * index) / 8
    group.appendChild(
      svgEl('line', {
        class: 'takeoff-ray',
        x1: Math.cos(angle) * 16,
        y1: Math.sin(angle) * 16,
        x2: Math.cos(angle) * 34,
        y2: Math.sin(angle) * 34,
        stroke: hue,
        'stroke-width': 3.4,
        'stroke-linecap': 'round',
      }),
    )
  }
  const label = svgEl('text', {
    class: 'takeoff-label',
    y: -38,
    'text-anchor': 'middle',
    'font-size': 17,
    'font-weight': 800,
    fill: hue,
    stroke: 'rgba(0,0,0,.25)',
    'stroke-width': 2,
    'paint-order': 'stroke',
  })
  label.textContent = '起飞!'
  group.appendChild(label)
  fxLayer.appendChild(group)

  // 棋盘中央打一个大字，整块棋盘抖一下，保证“谁都看得见”
  const banner = svgEl('text', {
    class: 'takeoff-banner',
    x: BOARD / 2,
    y: BOARD / 2,
    'text-anchor': 'middle',
    'font-size': 64,
    'font-weight': 900,
    fill: hue,
    stroke: 'rgba(0,0,0,.35)',
    'stroke-width': 3,
    'paint-order': 'stroke',
    'pointer-events': 'none',
  })
  banner.textContent = '✈ 起飞!'
  fxLayer.appendChild(banner)
  const board = $('board')
  if (board) {
    board.classList.remove('shake')
    if (typeof board.getBoundingClientRect === 'function') void board.getBoundingClientRect()
    board.classList.add('shake')
    setTimeout(() => board.classList.remove('shake'), 620)
  }
  speak('起飞啦')

  setTimeout(() => {
    if (group.parentNode) group.parentNode.removeChild(group)
    if (banner.parentNode) banner.parentNode.removeChild(banner)
  }, 1200)
}

function fxAt(color, cell, kind, label) {
  if (!cell || !fxLayer) return
  const duration = Math.max(120, Math.round(DURATION.capture * Math.max(0.4, motionFactor())))
  const group = svgEl('g', {
    transform:
      'translate(' + (cell[0] * CELL + CELL / 2) + ',' + (cell[1] * CELL + CELL / 2) + ')',
  })
  if (kind === 'ring') {
    group.appendChild(
      svgEl('circle', { class: 'fx-ring', r: 13, stroke: PALETTE[color] ?? 'var(--ink)' }),
    )
  } else {
    group.appendChild(
      svgEl('circle', {
        class: 'fx-spark',
        r: 16,
        fill: rgba(PALETTE[color] ?? '#fff', 0.4),
      }),
    )
    // 撞击时溅开的小碎片
    for (let index = 0; index < 6; index += 1) {
      const angle = (Math.PI * 2 * index) / 6 + Math.random() * 0.6
      const distance = 18 + Math.random() * 18
      const dot = svgEl('circle', {
        class: 'fx-dot',
        r: 3.2,
        fill: PALETTE[color] ?? '#fff',
      })
      dot.style.setProperty('--dx', (Math.cos(angle) * distance).toFixed(1) + 'px')
      dot.style.setProperty('--dy', (Math.sin(angle) * distance).toFixed(1) + 'px')
      group.appendChild(dot)
    }
  }
  if (label) {
    const text = svgEl('text', { class: 'fx-label', y: -14 })
    text.textContent = label
    group.appendChild(text)
  }
  fxLayer.appendChild(group)
  setTimeout(() => group.remove(), duration + 60)
}

function shakeBoard() {
  const wrap = $('board-wrap')
  if (motionFactor() === 0) return
  wrap.classList.remove('shake')
  void wrap.offsetWidth
  wrap.classList.add('shake')
  setTimeout(() => wrap.classList.remove('shake'), 400)
}

// ------------------------------------------------------------------ 播报 / 特效
function absorbFeed(room) {
  const maxId = room.feed.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0)
  if (state.lastRoomId !== room.id) {
    state.lastRoomId = room.id
    state.lastFeedId = maxId
    return []
  }
  const fresh = room.feed.filter((entry) => (entry.id ?? 0) > state.lastFeedId)
  state.lastFeedId = maxId
  return fresh
}

function fxFromFeed(room, entries) {
  for (const entry of entries) {
    if (entry.kind === 'move') {
      const cell = positionOf(entry.color, entry.to)
      if (entry.via === 'launch') {
        markPlane(entry.color, entry.plane, 'taking-off', Math.round(DURATION.takeoff * Math.max(0.3, motionFactor())))
        takeoffBurst(entry.color, cell)
      } else if (entry.via === 'jump') {
        fxAt(entry.color, cell, 'ring', '+4')
      } else if (entry.via === 'fly') {
        fxAt(entry.color, cell, 'ring', '+12')
      } else if (entry.via === 'home') {
        fxAt(entry.color, cell, 'ring', '到家')
        speak('到家啦')
      }
      continue
    }
    if (entry.kind === 'capture') {
      speak('哎呀，被撞了')
      const lastMove = room.feed
        .filter((item) => item.kind === 'move' && item.color === entry.color)
        .at(-1)
      const cell = lastMove ? positionOf(entry.color, lastMove.to) : null
      fxAt(entry.color, cell, 'spark', '撞回')
      shakeBoard()
      continue
    }
    if (entry.kind === 'reaction' && entry.color !== room.you?.color) {
      floatReaction(entry.color, entry.emoji)
    }
  }
}

/** 互动表情：从那位玩家的机场上飘起来。 */
function floatReaction(color, emoji) {
  if (!fxLayer) return
  const [col, row] = HANGAR_ORIGIN[color]
  const group = svgEl('g', {
    transform: 'translate(' + (col + 2) * CELL + ',' + (row + 2) * CELL + ')',
  })
  const text = svgEl('text', { class: 'fx-emoji', y: 0 })
  text.textContent = emoji
  group.appendChild(text)
  fxLayer.appendChild(group)
  setTimeout(() => group.remove(), 1400)
}

// ------------------------------------------------------------------ 联网
function syncUrl() {
  return new URL('ludo/api/sync', location.href).href
}

function setStatus(status) {
  if (state.status === status) return
  state.status = status
  renderHeader()
}

function send(action) {
  state.seq += 1
  state.queue.push({ ...action, n: state.seq })
  if (abortController) abortController.abort()
  return true
}

function dispatch(message) {
  if (message.t === 'welcome') {
    state.you = message.you
    if (!state.name && message.you?.name) {
      state.name = message.you.name
      $('name').value = state.name
    }
    state.rooms = message.rooms ?? []
    renderRooms()
    return
  }
  if (message.t === 'room') {
    applyRoom(message.room ?? null)
    return
  }
  if (message.t === 'rooms') {
    state.rooms = message.rooms ?? []
    renderRooms()
    return
  }
  if (message.t === 'named') {
    state.name = message.name
    return
  }
  if (message.t === 'error') {
    toast(message.message)
  }
}

async function syncOnce() {
  const wasHello = needHello
  const queued = state.queue.slice()
  const batch = wasHello
    ? [{ t: 'hello', cid: state.cid, name: state.name || undefined }, ...queued]
    : queued
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const controller = new AbortController()
  abortController = controller
  const guard = setTimeout(() => controller.abort(), 32000)
  try {
    const response = await fetch(syncUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sid: state.sid,
        cid: state.cid,
        name: state.name || undefined,
        actions: batch,
        wait: batch.length === 0,
      }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('http ' + response.status)
    const data = await response.json()
    needHello = false
    failures = 0
    state.queue = state.queue.slice(queued.length)
    // 只有"发动作"的请求能测出真实往返；挂着的长轮询要等 20 秒
    if (queued.length > 0 || wasHello) {
      const rtt = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt)
      if (Math.abs(rtt - state.rtt) > 15) {
        state.rtt = rtt
        renderHeader()
      }
    }
    setStatus('online')
    for (const message of data.messages ?? []) dispatch(message)
  } catch (error) {
    if (!alive) return
    if (error && error.name === 'AbortError' && state.queue.length > 0) return
    failures += 1
    needHello = true
    setStatus('offline')
    await sleep(Math.min(6000, 700 + failures * 700))
  } finally {
    clearTimeout(guard)
    if (abortController === controller) abortController = null
  }
}

async function networkLoop() {
  while (alive) {
    try {
      await syncOnce()
    } catch (error) {
      if (!alive) return
      await sleep(1000)
    }
  }
}

// ------------------------------------------------------------------ 渲染
/** 轮到我、且摇出点数时，在每架能走的飞机落点上画一个虚线圆。 */
function renderHints(room) {
  if (!hintLayer) return
  hintLayer.textContent = ''
  const game = room?.game
  if (!game || game.over || !room.you) return
  if (game.turn !== room.you.color || game.dice === null) return
  for (const move of game.moves ?? []) {
    const cell = positionOf(room.you.color, move.to)
    if (!cell) continue
    const x = cell[0] * CELL + CELL / 2
    const y = cell[1] * CELL + CELL / 2
    hintLayer.appendChild(
      svgEl('circle', {
        class: 'hint',
        cx: x,
        cy: y,
        r: 16,
        fill: 'none',
        stroke: PALETTE[room.you.color],
        'stroke-width': 2.6,
        'stroke-dasharray': '5 4',
        'pointer-events': 'none',
      }),
    )
  }
}

function applyRoom(room) {
  const fresh = room ? absorbFeed(room) : []
  for (const item of fresh) {
    if (item.kind === 'chat' && QUICK_PHRASES.includes(item.text) && item.color !== (room.you && room.you.color)) {
      speak(item.text)
    }
  }
  state.room = room
  const nextBoard = room ? room.board || null : null
  const boardChanged = state.boardRef !== nextBoard
  state.boardRef = nextBoard
  setBoardOverride(nextBoard)
  if (boardChanged && room) {
    render()
    buildBoard()
    syncTokens(room)
    renderHints(room)
    renderEditor()
    return
  }
  renderEditor()
  if (!room) {
    state.lastRoomId = null
    state.lastFeedId = 0
    state.armedUntil = 0
    render()
    buildBoard()
    return
  }
  render()
  syncTokens(room)
  renderHints(room)
  if (fresh.length > 0) {
    fxFromFeed(room, fresh)
    soundsFromFeed(fresh)
  }
  syncTurnCue(room)
}

/** 播报对应的音效。 */
function soundsFromFeed(entries) {
  for (const entry of entries) {
    if (entry.kind === 'move') {
      if (entry.via === 'launch') audio.play('launch')
      else if (entry.via === 'home') audio.play('home')
      else audio.play('step')
    } else if (entry.kind === 'capture') {
      audio.play('capture')
    } else if (entry.kind === 'chat') {
      audio.play('chat')
    } else if (entry.kind === 'reaction') {
      audio.play('chat')
    } else if (entry.kind === 'rank') {
      audio.play('home')
    } else if (entry.kind === 'over') {
      audio.play('win')
    }
  }
}

/** 轮到你了：横幅 + 提示音。 */
function syncTurnCue(room) {
  const game = room.game
  if (!game || game.over) {
    state.lastTurnKey = null
    return
  }
  const key = game.turn + ':' + game.turns + ':' + (game.dice ?? '-')
  if (key === state.lastTurnKey) return
  state.lastTurnKey = key
  if (room.you && game.turn === room.you.color && game.dice === null) {
    showBanner(t('yourTurn'))
    audio.play('turn')
  }
}

function showBanner(text) {
  const node = $('banner')
  if (!node) return
  node.textContent = text
  node.hidden = false
  node.classList.remove('show')
  void node.offsetWidth
  node.classList.add('show')
  clearTimeout(showBanner.timer)
  showBanner.timer = setTimeout(() => {
    node.hidden = true
    node.classList.remove('show')
  }, 1700)
}

function renderHeader() {
  const room = state.room
  const chip = $('code')
  chip.hidden = !room
  if (room) chip.textContent = '#' + room.id
  const net = $('net')
  net.classList.toggle('on', state.status === 'online')
  net.classList.toggle('off', state.status === 'offline')
  $('net-text').textContent =
    (state.status === 'online'
      ? t('netOnline')
      : state.status === 'offline'
        ? t('netOffline')
        : t('netConnecting')) + (state.rtt > 0 && state.status === 'online' ? ' · ' + state.rtt + 'ms' : '')
}

function renderRooms() {
  const host = $('rooms')
  host.textContent = ''
  $('rooms-count').textContent = '(' + state.rooms.length + ')'
  if (state.rooms.length === 0) {
    host.appendChild(el('div', 'empty', t('lobbyEmpty')))
    return
  }
  for (const room of state.rooms) {
    const item = el('div', 'room-item')
    item.appendChild(el('b', null, '#' + room.id))
    const playing = room.phase !== 'lobby'
    item.appendChild(
      el(
        'span',
        null,
        (playing ? t('lobbyPlaying') : t('lobbyWaiting')) + ' · ' + room.members + '/' + room.maxMembers,
      ),
    )
    const full = room.members >= room.maxMembers
    const join = button(full ? t('lobbyFull') : t('lobbyJoin'), () => send({ t: 'joinRoom', roomId: room.id }), 'btn tiny')
    join.disabled = playing || full
    item.appendChild(join)
    host.appendChild(item)
  }
}

function renderSeats() {
  const host = $('seats')
  host.textContent = ''
  const room = state.room
  if (!room) return
  for (let seat = 0; seat < 4; seat += 1) {
    const member = room.members[seat]
    const row = el('div', 'seat')
    row.style.setProperty('--pc', PALETTE[seat])
    if (member) {
      if (room.game && room.game.turn === seat && room.phase === 'playing') row.classList.add('active')
      row.appendChild(el('span', 'swatch'))
      const name = el('span', 'name', member.name + (member.cid === room.you?.cid ? ' · ' + t('you') : ''))
      row.appendChild(name)
      if (member.isHost) row.appendChild(el('span', 'tag', t('host')))
      if (member.isBot) row.appendChild(el('span', 'tag', t('bot')))
      if (!member.connected && !member.isBot) row.appendChild(el('span', 'tag', t('offline')))
      if (member.rank > 0) row.appendChild(el('span', 'tag rank', fmt(t('place'), { n: member.rank })))
      const pips = el('span', 'pips')
      for (const pos of member.planes) {
        const pip = el('span', 'pip')
        if (pos === HOME) pip.classList.add('done')
        else if (pos >= 0) pip.classList.add('on')
        pips.appendChild(pip)
      }
      row.appendChild(pips)
    } else {
      row.appendChild(el('span', 'swatch'))
      const name = el('span', 'name', '—')
      name.style.opacity = '0.45'
      row.appendChild(name)
    }
    host.appendChild(row)
  }
}

function paintDice(node, face) {
  if (!node) return
  const pips = DICE_PIPS[face] ?? []
  const dots = node.querySelectorAll('i')
  dots.forEach((dot, index) => dot.classList.toggle('on', pips.includes(index)))
  node.classList.toggle('idle', !face)
}

function buildDice(face, options) {
  const node = el('div', 'dice')
  for (let index = 0; index < 9; index += 1) node.appendChild(el('i'))
  paintDice(node, face)
  if (options?.shaking) node.classList.add('shaking')
  if (options?.canRoll) {
    node.classList.add('can-roll')
    node.title = t('roll')
    node.addEventListener('click', rollNow)
  }
  return node
}

function startButton(room) {
  const armed = Date.now() < state.armedUntil
  const bots = Math.max(0, 4 - room.members.length)
  return button(
    armed ? fmt(t('startConfirm'), { n: bots }) : t('start'),
    () => {
      if (!armed) {
        state.armedUntil = Date.now() + 4000
        renderTurn()
        setTimeout(() => {
          if (Date.now() >= state.armedUntil) {
            state.armedUntil = 0
            renderTurn()
          }
        }, 4100)
        return
      }
      state.armedUntil = 0
      send({ t: 'start' })
      renderTurn()
    },
    'btn primary',
  )
}

function renderTurn() {
  const host = $('turn')
  host.textContent = ''
  diceNode = null
  const room = state.room
  if (!room) return
  const me = room.you

  if (room.phase === 'lobby') {
    const text = el('div', 'turn-text')
    text.appendChild(el('b', null, room.canStart ? t('start') : t('waitHost')))
    text.appendChild(el('span', null, t('fillHint')))
    host.appendChild(text)
    const moves = el('div', 'moves')
    if (room.canStart) moves.appendChild(startButton(room))
    if (room.canAddBot) moves.appendChild(button(t('addBot'), () => send({ t: 'addBot' }), 'btn ghost'))
    host.appendChild(moves)
    return
  }

  const game = room.game
  if (!game) return

  if (game.over) {
    const ordered = room.members.slice().sort((a, b) => (a.rank || 9) - (b.rank || 9))
    const list = el('div', 'moves')
    list.style.flexDirection = 'column'
    list.style.alignItems = 'stretch'
    for (const member of ordered) {
      const row = el('div', 'seat')
      row.style.setProperty('--pc', PALETTE[member.color])
      row.appendChild(el('span', 'swatch'))
      row.appendChild(el('span', 'name', member.name))
      const place = el('span', 'tag rank', member.rank > 0 ? fmt(t('place'), { n: member.rank }) : t('lastPlace'))
      place.style.marginLeft = 'auto'
      row.appendChild(place)
      list.appendChild(row)
    }
    host.appendChild(list)
    if (room.canRestart) {
      host.appendChild(button(t('rematch'), () => send({ t: 'restart' }), 'btn primary'))
    }
    return
  }

  const mine = !!me && game.turn === me.color
  const revealed = Date.now() >= state.rollUntil
  const shaking = Date.now() < state.rollUntil
  const face = shaking ? state.fakeFace : game.dice ?? 0

  const line = el('div', 'turn-line')
  diceNode = buildDice(face, {
    shaking,
    canRoll: mine && game.dice === null && revealed,
  })
  if (shaking) {
    diceNode.classList.add('skippable')
    diceNode.title = '点一下直接看结果'
    diceNode.addEventListener('click', skipRoll)
  }
  line.appendChild(diceNode)

  const text = el('div', 'turn-text')
  if (mine) {
    text.appendChild(el('b', null, game.dice === null ? t('yourTurn') : t('pickPlane')))
    text.appendChild(el('span', null, game.dice === null ? t('rollPrompt') : t('pickHint')))
  } else {
    const member = room.members.find((item) => item.color === game.turn)
    text.appendChild(
      el(
        'b',
        null,
        fmt(game.dice === null ? t('waiting') : t('waitingMove'), { name: member ? member.name : '…' }),
      ),
    )
  }
  line.appendChild(text)

  if (mine && game.dice === null && revealed) {
    line.appendChild(button(t('roll'), rollNow, 'btn primary'))
  }
  host.appendChild(line)

  if (mine && game.dice !== null && revealed && !state.ghost && (game.moves ?? []).length > 0) {
    const moves = el('div', 'moves')
    for (const move of game.moves) {
      const chip = button(moveLabel(move), () => sendMove(move.plane), 'chip')
      chip.style.setProperty('--pc', PALETTE[me.color])
      moves.appendChild(chip)
    }
    host.appendChild(moves)
  }
}

/** 摇到一半点一下骰子：别等了，直接看点数。 */
function skipRoll() {
  if (Date.now() >= state.rollUntil) return
  state.rollUntil = 0
  if (diceTimer) {
    clearInterval(diceTimer)
    diceTimer = null
  }
  renderTurn()
  if (state.room) syncTokens(state.room)
}

function rollNow() {
  const room = state.room
  if (!room?.game || room.game.over) return
  if (!room.you || room.game.turn !== room.you.color) return
  if (room.game.dice !== null) return
  audio.play('dice')
  if (settings.animation === false || settings.speed === 'off') {
    send({ t: 'roll' })
    return
  }
  state.rollUntil = Date.now() + Math.round(DURATION.dice * motionFactor())
  state.fakeFace = 1 + Math.floor(Math.random() * 6)
  send({ t: 'roll' })
  if (diceTimer) clearInterval(diceTimer)
  diceTimer = setInterval(() => {
    if (Date.now() >= state.rollUntil) {
      clearInterval(diceTimer)
      diceTimer = null
      renderTurn()
      if (diceNode) {
        diceNode.classList.add('landed')
        setTimeout(() => diceNode?.classList.remove('landed'), 340)
      }
      if (state.room) syncTokens(state.room)
      return
    }
    state.fakeFace = 1 + Math.floor(Math.random() * 6)
    paintDice(diceNode, state.fakeFace)
  }, 90)
  renderTurn()
}

function renderFeed() {
  const host = $('feed')
  const room = state.room
  if (!room) return
  const pinned = host.scrollHeight - host.scrollTop - host.clientHeight < 48
  host.textContent = ''
  const entries = room.feed.slice(-90)
  if (entries.length === 0 && state.echoes.length === 0) {
    host.appendChild(el('div', 'empty', t('feedEmpty')))
    return
  }
  for (const entry of entries) {
    if (entry.kind === 'voice') {
      const line = el('div', 'line chat')
      if (entry.color === room.you?.color) line.classList.add('mine')
      const who = el('span', 'who', entry.name)
      who.style.color = PALETTE[entry.color] ?? 'var(--ink)'
      line.appendChild(who)
      const play = el(
        'button',
        'voice-chip',
        '▶ ' + (entry.duration ? (entry.duration / 1000).toFixed(1) + 's' : '语音'),
      )
      play.type = 'button'
      play.addEventListener('click', () => playVoice(entry.voiceId))
      line.appendChild(play)
      host.appendChild(line)
      continue
    }
    if (entry.kind === 'chat') {
      const line = el('div', 'line chat')
      if (entry.color === room.you?.color) line.classList.add('mine')
      const who = el('span', 'who', entry.name)
      who.style.color = PALETTE[entry.color] ?? 'var(--ink)'
      line.appendChild(who)
      line.appendChild(document.createTextNode(entry.text))
      host.appendChild(line)
    } else {
      host.appendChild(el('div', 'line', feedText(entry, room.members)))
    }
  }
  // 自己刚发出去、服务端还没回执的那几句，先本地显示，避免"点了没反应"
  const mine = new Set(
    room.feed
      .filter((entry) => entry.kind === 'chat' && entry.color === room.you?.color)
      .map((entry) => entry.text),
  )
  const cutoff = Date.now() - 15000
  state.echoes = state.echoes.filter((echo) => echo.at > cutoff)
  for (const echo of state.echoes) {
    if (mine.has(echo.text)) continue
    const line = el('div', 'line chat mine pending')
    const who = el('span', 'who', room.you?.name ?? t('you'))
    who.style.color = PALETTE[room.you?.color ?? 0] ?? 'var(--ink)'
    line.appendChild(who)
    line.appendChild(document.createTextNode(echo.text))
    host.appendChild(line)
  }
  if (pinned) host.scrollTop = host.scrollHeight
}

function render() {
  renderHeader()
  const room = state.room
  $('lobby').hidden = !!room
  $('game').hidden = !room
  if (room) {
    renderSeats()
    renderTurn()
    renderFeed()
    $('chat-input').disabled = false
    $('chat-send').disabled = false
  } else {
    renderRooms()
    $('chat-input').disabled = true
    $('chat-send').disabled = true
  }
}

// ------------------------------------------------------------------ 设置面板
function renderSettings() {
  const anim = $('anim-toggle')
  anim.setAttribute('aria-checked', settings.animation ? 'true' : 'false')
  const sound = $('sound-toggle')
  sound.setAttribute('aria-checked', settings.sound ? 'true' : 'false')
  for (const [key, speed] of Object.entries(SPEEDS)) {
    const node = $('speed-' + key)
    if (node) node.classList.toggle('on', settings.speed === key)
  }
  for (const key of Object.keys(THEMES)) {
    const node = $('theme-' + key)
    if (node) node.classList.toggle('on', settings.theme === key)
  }
}

function updateSettings(patch) {
  const themeChanged = patch.theme !== undefined && patch.theme !== settings.theme
  Object.assign(settings, patch)
  saveSettings(settings)
  if (patch.sound !== undefined) audio.setEnabled(settings.sound)
  applyLook()
  if (themeChanged) {
    buildBoard()
    if (state.room) syncTokens(state.room)
    render()
  } else {
    if (state.room) syncTokens(state.room)
    renderTurn()
  }
  renderSettings()
}

function buildSettingsControls() {
  const speeds = $('speed-seg')
  for (const [key, speed] of Object.entries(SPEEDS)) {
    const node = button(speed.name, () => updateSettings({ speed: key }), '')
    node.id = 'speed-' + key
    speeds.appendChild(node)
  }
  const themes = $('theme-seg')
  for (const [key, theme] of Object.entries(THEMES)) {
    const node = button(theme.name, () => updateSettings({ theme: key }), '')
    node.id = 'theme-' + key
    themes.appendChild(node)
  }
  $('anim-toggle').addEventListener('click', () => updateSettings({ animation: !settings.animation }))
  $('sound-toggle').addEventListener('click', () => {
    updateSettings({ sound: !settings.sound })
    if (settings.sound) {
      audio.unlock()
      speak('试一下语音，起飞啦')
    }
  })
  $('settings-btn').addEventListener('click', () => {
    $('sheet').hidden = false
  })
  $('sheet-close').addEventListener('click', () => {
    $('sheet').hidden = true
  })
  $('sheet').addEventListener('click', (event) => {
    if (event.target === $('sheet')) $('sheet').hidden = true
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $('sheet').hidden = true
  })
  renderSettings()
}

// ------------------------------------------------------------------ 事件绑定
function commitName() {
  const input = $('name')
  const value = input.value.trim().slice(0, 14)
  state.name = value
  saveName(value)
  send({ t: 'setName', name: value })
}

/** 快捷短语 + 互动表情。 */
function buildQuickActions() {
  const quick = $('quick')
  for (const phrase of QUICK_PHRASES) {
    quick.appendChild(
      button(
        phrase,
        () => {
          state.echoes.push({ text: phrase, at: Date.now() })
          send({ t: 'chat', text: phrase })
          renderFeed()
        },
        'chip',
      ),
    )
  }
  const bar = $('reactions')
  for (const emoji of REACTIONS) {
    bar.appendChild(
      button(
        emoji,
        () => {
          floatReaction(state.room?.you?.color ?? 0, emoji)
          audio.play('chat')
          send({ t: 'reaction', emoji })
        },
        'chip reaction-chip',
      ),
    )
  }
}

let recorder = null
let recordChunks = []
let recordStartedAt = 0
let recordTimer = null
let recordMime = ''

function pickRecordMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (const type of candidates) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

function setVoiceState(text) {
  const node = $('voice-state')
  if (!node) return
  node.textContent = text || ''
  node.hidden = !text
}

async function startRecording() {
  if (recorder) return
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    toast(t('voiceUnsupported'))
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recordMime = pickRecordMime()
    recorder = recordMime ? new MediaRecorder(stream, { mimeType: recordMime }) : new MediaRecorder(stream)
    recordChunks = []
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordChunks.push(event.data)
    }
    recorder.onstop = () => {
      const duration = Date.now() - recordStartedAt
      const type = recorder?.mimeType || recordMime || 'audio/webm'
      const blob = new Blob(recordChunks, { type })
      stream.getTracks().forEach((track) => track.stop())
      recorder = null
      recordChunks = []
      setVoiceState('')
      $('voice-btn').classList.remove('recording')
      if (recordTimer) {
        clearInterval(recordTimer)
        recordTimer = null
      }
      if (duration < 350 || blob.size < 400) {
        toast(t('voiceTooShort'))
        return
      }
      uploadVoice(blob, type, duration)
    }
    recordStartedAt = Date.now()
    recorder.start()
    $('voice-btn').classList.add('recording')
    setVoiceState(t('voiceRecording') + ' · ' + t('voiceSendHint'))
    if (recordTimer) clearInterval(recordTimer)
    recordTimer = setInterval(() => {
      const seconds = ((Date.now() - recordStartedAt) / 1000).toFixed(1)
      setVoiceState(t('voiceRecording') + ' ' + seconds + 's · ' + t('voiceSendHint'))
      if (Date.now() - recordStartedAt > 15000) stopRecording()
    }, 200)
  } catch (error) {
    toast(t('voiceDenied'))
    setVoiceState('')
  }
}

function stopRecording() {
  if (recorder && recorder.state === 'recording') {
    try {
      recorder.stop()
    } catch (error) {
      /* ignore */
    }
  }
}

async function uploadVoice(blob, mime, duration) {
  const url = new URL('ludo/api/voice', document.baseURI || location.href)
  url.searchParams.set('sid', state.sid)
  url.searchParams.set('duration', String(Math.round(duration)))
  try {
    const response = await fetch(url.href, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: blob,
    })
    if (!response.ok) throw new Error('http ' + response.status)
  } catch (error) {
    toast('语音没发出去（' + (error.message ?? '') + '）')
  }
}

function playVoice(id) {
  const url = new URL('ludo/api/voice/' + id, document.baseURI || location.href)
  const audio = new Audio(url.href)
  audio.play().catch(() => {})
}

/** 大厅里显示的"发给朋友"地址：本机打开时去问服务器公网地址是多少。 */
async function refreshShare() {
  const node = $('share-url')
  if (!node) return
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname)
  let url = location.origin
  if (local) {
    try {
      const target = new URL('ludo/api/share', document.baseURI || location.href)
      const data = await (await fetch(target.href, { cache: 'no-store' })).json()
      if (data && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) url = data.url.trim()
    } catch (error) {
      /* 拿不到就用当前地址 */
    }
  }
  shareUrl = url
  node.textContent = url
}

/** 房主在房间大厅里编辑棋盘：点格子改颜色 / 切安全格·飞行格 / 设起飞点。 */
function onCellClick(index) {
  const room = state.room
  if (!state.editing || !room || room.phase !== 'lobby' || !room.you || !room.you.isHost) return
  if (state.editMode === 'color') {
    send({ t: 'paint', cell: index, color: (cellColor(index) + 1) % 4 })
  } else if (state.editMode === 'safe' || state.editMode === 'flight') {
    send({ t: 'mark', cell: index, kind: state.editMode })
  } else if (state.editMode === 'start') {
    send({ t: 'startCell', color: state.editColor, cell: index })
  }
}

function renderEditor() {
  const bar = $('editor')
  if (!bar) return
  const room = state.room
  const host = !!room && room.phase === 'lobby' && room.you && room.you.isHost
  if (!host) {
    state.editing = false
    bar.hidden = true
    return
  }
  bar.hidden = false
  const toggle = $('editor-toggle')
  if (toggle) toggle.textContent = state.editing ? '结束编辑' : '编辑棋盘'
  for (const node of bar.querySelectorAll('[data-mode]')) {
    node.classList.toggle('on', state.editing && node.dataset.mode === state.editMode)
    node.disabled = !state.editing
  }
  const colors = $('editor-colors')
  if (!colors) return
  colors.textContent = ''
  if (state.editMode === 'start') {
    for (let color = 0; color < 4; color += 1) {
      const chip = el('button', 'chip' + (state.editColor === color ? ' on' : ''))
      chip.type = 'button'
      chip.textContent = t('color.' + ['red', 'blue', 'amber', 'green'][color])
      chip.style.setProperty('--pc', PALETTE[color])
      chip.addEventListener('click', () => {
        state.editColor = color
        renderEditor()
      })
      colors.appendChild(chip)
    }
  }
}

// 关页面/锁屏时告诉服务器“我走了”，房间立刻回收
function leaveOnUnload() {
  const room = state.room
  if (!room) return
  try {
    const body = JSON.stringify({ sid: state.sid, cid: state.cid, name: state.name, actions: [{ t: 'leaveRoom', n: ++state.seq }], wait: false })
    if (navigator.sendBeacon) navigator.sendBeacon('ludo/api/sync', new Blob([body], { type: 'application/json' }))
    else fetch('ludo/api/sync', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true })
  } catch (error) {
    /* 尽力而为 */
  }
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', leaveOnUnload)
  window.addEventListener('beforeunload', leaveOnUnload)
}

function bindEvents() {
  $('name').value = state.name
  $('name').addEventListener('change', commitName)
  $('name').addEventListener('blur', commitName)
  $('name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitName()
    }
  })
  $('create').addEventListener('click', () => {
    commitName()
    send({ t: 'createRoom' })
  })
  $('refresh').addEventListener('click', () => send({ t: 'listRooms' }))
  $('join').addEventListener('click', () => {
    const code = $('join-code').value.trim().toUpperCase()
    if (code.length < 4) return
    commitName()
    send({ t: 'joinRoom', roomId: code })
  })
  $('join-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      $('join').click()
    }
  })
  $('copy-url').addEventListener('click', async () => {
    const ok = await copyText(shareUrl)
    toast(ok ? t('copied') : shareUrl)
  })
  $('code').addEventListener('click', async () => {
    if (!state.room) return
    const ok = await copyText('#' + state.room.id + '  ' + location.origin)
    toast(ok ? t('copied') : '#' + state.room.id)
  })
  $('leave').addEventListener('click', () => send({ t: 'leaveRoom' }))

  const editorToggle = $('editor-toggle')
  if (editorToggle) {
    editorToggle.addEventListener('click', () => {
      state.editing = !state.editing
      renderEditor()
    })
  }
  const modeButtons = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[data-mode]') : []
  for (const node of modeButtons) {
    node.addEventListener('click', () => {
      state.editMode = node.dataset.mode
      state.editing = true
      renderEditor()
    })
  }
  const editorDone = $('editor-done')
  if (editorDone) {
    editorDone.addEventListener('click', () => {
      state.editing = false
      renderEditor()
    })
  }

  const mic = $('voice-btn')
  mic.title = TEXT.voiceHold
  mic.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    startRecording()
  })
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    mic.addEventListener(type, () => stopRecording())
  }
  mic.addEventListener('contextmenu', (event) => event.preventDefault())

  $('chat').addEventListener('submit', (event) => {
    event.preventDefault()
    const input = $('chat-input')
    const text = input.value.trim()
    if (!text) return
    state.echoes.push({ text, at: Date.now() })
    send({ t: 'chat', text })
    input.value = ''
    renderFeed()
  })
  $('share-url').textContent = location.origin
}
// ------------------------------------------------------------------ 启动
function applyText() {
  document.title = TEXT.title
  $('tagline').textContent = TEXT.tagline
  $('label-name').textContent = TEXT.lobbyName
  $('name').placeholder = TEXT.lobbyName
  $('create').textContent = TEXT.lobbyCreate
  $('refresh').textContent = TEXT.lobbyRefresh
  $('join').textContent = TEXT.lobbyJoin
  $('join-code').placeholder = TEXT.lobbyCode
  $('share-hint').textContent = TEXT.lobbyShare
  $('copy-url').textContent = TEXT.copy
  $('label-rooms').textContent = TEXT.lobbyRooms
  $('label-seats').textContent = TEXT.seats
  $('leave').textContent = TEXT.leave
  $('chat-input').placeholder = TEXT.chatPlaceholder
  $('chat-send').textContent = TEXT.chatSend
  $('label-settings').textContent = TEXT.settings
  $('label-anim').textContent = TEXT.animation
  $('label-sound').textContent = TEXT.sound
  $('label-speed').textContent = TEXT.speed
  $('label-theme').textContent = TEXT.theme
  $('sheet-close').textContent = TEXT.close
}

function boot() {
  applyLook()
  applyText()
  buildBoard()
  buildSettingsControls()
  buildQuickActions()
  bindEvents()
  if (new URLSearchParams(location.search).get('solo') === '1' && !state.soloStarted) {
    state.soloStarted = true
    send({ t: 'createRoom' })
    send({ t: 'start' })
  }
  renderHeader()
  renderRooms()
  refreshShare()
  setInterval(refreshShare, 20000)
  audio.setEnabled(settings.sound)
  warmSpeech()
  document.addEventListener(
    'pointerdown',
    () => {
      if (!speechReady) warmSpeech()
    },
    { once: true },
  )
  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(type, () => audio.unlock(), { once: true, passive: true })
  }
  networkLoop()
  window.__ludoReady = true
  const note = document.getElementById('boot-note')
  if (note) note.hidden = true
}

boot()



























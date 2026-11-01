/**
 * 联机实时格斗：服务端按固定步长模拟，两端只发操作、只收画面。
 * 世界坐标固定 960x540，跟同屏格斗一样的手感。
 */

export const W = 960
export const H = 540
export const GROUND = 462
const GRAVITY = 2000
const SPEED = 240
const JUMP = 720
const MIN_X = 58
const MAX_X = W - 58

const ATTACKS = {
  punch: { startup: 60, active: 100, recover: 130, damage: 7, range: 66, stun: 200 },
  kick: { startup: 120, active: 120, recover: 220, damage: 12, range: 80, stun: 300 },
}

export function createGame(seats) {
  if (!Array.isArray(seats) || seats.length !== 2) throw new Error('brawl needs exactly 2 seats')
  return {
    kind: 'brawl',
    players: seats.map((seat, index) => ({ cid: seat.cid, name: seat.name, color: index, isBot: !!seat.isBot })),
    fighters: [makeFighter(0), makeFighter(1)],
    tick: 0,
    over: false,
    winner: -1,
    hits: [],
    round: 1,
    lastInput: [null, null],
  }
}

function makeFighter(index) {
  return {
    x: index === 0 ? W * 0.32 : W * 0.68,
    y: GROUND,
    vy: 0,
    facing: index === 0 ? 1 : -1,
    hp: 100,
    attacking: null,
    attackT: 0,
    hitDone: false,
    stun: 0,
    flash: 0,
    block: false,
    input: { left: false, right: false, jump: false, block: false },
  }
}

export function applyInput(game, seat, input) {
  const fighter = game.fighters[seat]
  if (!fighter || game.over) return
  fighter.input = {
    left: !!input.left,
    right: !!input.right,
    jump: !!input.jump,
    block: !!input.block,
  }
  if (input.punch) startAttack(game, seat, 'punch')
  if (input.kick) startAttack(game, seat, 'kick')
}

function startAttack(game, seat, type) {
  const fighter = game.fighters[seat]
  if (!fighter || game.over) return
  if (fighter.stun > 0 || fighter.attacking) return
  fighter.attacking = type
  fighter.attackT = 0
  fighter.hitDone = false
}

/** 推进一帧（dt 秒）。 */
export function step(game, dt) {
  if (game.over) return
  const [a, b] = game.fighters

  for (let index = 0; index < 2; index += 1) {
    const fighter = game.fighters[index]
    const other = game.fighters[1 - index]
    const input = fighter.input || {}

    if (fighter.stun > 0) {
      fighter.stun -= dt * 1000
      fighter.block = false
    } else {
      fighter.block = !!input.block && fighter.y >= GROUND
      let dir = 0
      if (input.left && !input.right) dir = -1
      if (input.right && !input.left) dir = 1
      const speed = fighter.block ? SPEED * 0.35 : SPEED
      fighter.x += dir * speed * dt
      if (!fighter.attacking) fighter.facing = other.x >= fighter.x ? 1 : -1
      if (input.jump && fighter.y >= GROUND && !fighter.block) {
        fighter.vy = -JUMP
        input.jump = false
      }
    }

    fighter.vy += GRAVITY * dt
    fighter.y += fighter.vy * dt
    if (fighter.y >= GROUND) {
      fighter.y = GROUND
      fighter.vy = 0
    }
    fighter.x = Math.max(MIN_X, Math.min(MAX_X, fighter.x))
    if (fighter.flash > 0) fighter.flash -= dt * 1000

    if (fighter.attacking) {
      const spec = ATTACKS[fighter.attacking]
      fighter.attackT += dt * 1000
      if (!fighter.hitDone && fighter.attackT >= spec.startup && fighter.attackT < spec.startup + spec.active) {
        tryHit(game, index, spec)
      }
      if (fighter.attackT >= spec.startup + spec.active + spec.recover) {
        fighter.attacking = null
        fighter.attackT = 0
      }
    }
  }

  // 不重叠
  const gap = 54
  if (Math.abs(a.x - b.x) < gap) {
    const push = (gap - Math.abs(a.x - b.x)) / 2
    const sign = a.x <= b.x ? -1 : 1
    a.x += sign * push
    b.x -= sign * push
    a.x = Math.max(MIN_X, Math.min(MAX_X, a.x))
    b.x = Math.max(MIN_X, Math.min(MAX_X, b.x))
  }

  for (const hit of game.hits) hit.life -= dt * 1000
  game.hits = game.hits.filter((hit) => hit.life > 0)

  game.tick += 1
  if (!game.over && (a.hp <= 0 || b.hp <= 0)) {
    game.over = true
    game.winner = a.hp <= 0 && b.hp <= 0 ? -1 : a.hp <= 0 ? 1 : 0
  }
}

function tryHit(game, seat, spec) {
  const attacker = game.fighters[seat]
  const defender = game.fighters[1 - seat]
  const dx = defender.x - attacker.x
  if (Math.abs(dx) > spec.range) return
  if (Math.sign(dx) !== attacker.facing && Math.abs(dx) > 20) return
  if (Math.abs(attacker.y - defender.y) > 110) return

  attacker.hitDone = true
  let damage = spec.damage
  const blocking = defender.block && Math.sign(-dx) === defender.facing
  if (blocking) damage = Math.round(damage * 0.2)
  defender.hp = Math.max(0, defender.hp - damage)
  defender.flash = 160
  if (!blocking) defender.stun = spec.stun
  game.hits.push({ x: defender.x, y: defender.y - 70, life: 300, damage })
}

/** 给客户端的快照。 */
export function snapshot(game) {
  return {
    kind: 'brawl',
    over: game.over,
    winner: game.winner,
    tick: game.tick,
    fighters: game.fighters.map((fighter) => ({
      x: Math.round(fighter.x),
      y: Math.round(fighter.y),
      facing: fighter.facing,
      hp: fighter.hp,
      attacking: fighter.attacking,
      block: fighter.block,
      flash: fighter.flash > 0,
      stun: fighter.stun > 0,
    })),
    hits: game.hits.map((hit) => ({ x: Math.round(hit.x), y: Math.round(hit.y), damage: hit.damage })),
  }
}

/** 简单电脑：靠近就打。 */
export function botInput(game, seat) {
  const me = game.fighters[seat]
  const other = game.fighters[1 - seat]
  const dx = other.x - me.x
  const input = { left: false, right: false, jump: false, block: false }
  if (game.over) return input
  if (Math.abs(dx) > 80) {
    if (dx > 0) input.right = true
    else input.left = true
  } else if (Math.random() < 0.35) {
    if (Math.random() < 0.6) input.punch = true
    else input.kick = true
  }
  if (Math.random() < 0.08) input.block = true
  return input
}

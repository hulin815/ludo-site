/**
 * 双人擂台：两边各选一招，同时亮出来结算（对网络延迟不敏感）。
 * 比同屏格斗多一层“距离”：前进/后退会改变两人的间距，拳和腿各有射程。
 */

export const HP = 100
export const MOVES = ['forward', 'back', 'punch', 'kick', 'block', 'dodge']
export const FAR = 4
export const START_GAP = 2
const DAMAGE = { punch: 10, kick: 16 }
const REACH = { punch: 1, kick: 2 }

export function createGame(seats) {
  if (!Array.isArray(seats) || seats.length !== 2) throw new Error('duel needs exactly 2 seats')
  return {
    kind: 'duel',
    players: seats.map((seat, index) => ({
      cid: seat.cid,
      name: seat.name,
      color: index,
      isBot: !!seat.isBot,
    })),
    hp: [HP, HP],
    gap: START_GAP,
    round: 1,
    picks: [null, null],
    over: false,
    winner: -1,
    history: [],
    turns: 0,
    last: null,
  }
}

const gapShift = (move) => (move === 'forward' ? -1 : move === 'back' ? 1 : 0)
const isAttack = (move) => move === 'punch' || move === 'kick'

/** 结算一轮。 */
export function resolve(game) {
  const [a, b] = game.picks
  if (!a || !b) return { ok: false, error: '两边都要出招' }

  const gap = Math.max(0, Math.min(FAR, game.gap + gapShift(a) + gapShift(b)))

  function attackDamage(attack, defense) {
    if (!isAttack(attack)) return 0
    if (defense === 'dodge') return 0
    const inReach = gap <= REACH[attack]
    const missed = !inReach
    // 拳快、腿重：贴脸时腿还没抬起来就被拳打断
    if (attack === 'kick' && defense === 'punch' && gap === 0) return 0
    if (missed) return 0
    let amount = DAMAGE[attack]
    if (defense === 'block') amount = Math.round(amount * 0.2)
    return amount
  }

  const dmgToB = attackDamage(a, b)
  const dmgToA = attackDamage(b, a)

  game.gap = gap
  game.hp[0] = Math.max(0, game.hp[0] - dmgToA)
  game.hp[1] = Math.max(0, game.hp[1] - dmgToB)
  game.turns += 1

  const last = { round: game.round, picks: [a, b], damage: [dmgToA, dmgToB], hp: game.hp.slice(), gap }
  game.history.push(last)
  if (game.history.length > 30) game.history.shift()
  game.last = last
  game.picks = [null, null]
  game.round += 1

  if (game.hp[0] <= 0 || game.hp[1] <= 0) {
    game.over = true
    game.winner = game.hp[0] <= 0 && game.hp[1] <= 0 ? -1 : game.hp[0] <= 0 ? 1 : 0
  }
  return { ok: true, last, over: game.over, winner: game.winner }
}

/** 机器人：按距离决定进退，偶尔读你的习惯。 */
export function botPick(game, seat) {
  const other = 1 - seat
  const recent = game.history.slice(-4).map((item) => item.picks[other])
  if (game.gap > 2) return Math.random() < 0.75 ? 'forward' : 'kick'
  if (game.hp[seat] <= 25 && Math.random() < 0.4) return 'block'
  if (recent.filter((pick) => pick === 'punch').length >= 2 && Math.random() < 0.55) return 'block'
  if (recent.filter((pick) => pick === 'block').length >= 2 && Math.random() < 0.5) return 'kick'
  const pool = ['punch', 'punch', 'kick', 'block', 'dodge', 'back']
  return pool[Math.floor(Math.random() * pool.length)]
}

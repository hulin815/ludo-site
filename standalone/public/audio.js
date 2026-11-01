/**
 * 合成音效。不加载任何音频文件，全部用 WebAudio 现场合成，
 * 所以断网、换机器都不会缺资源。
 *
 * 浏览器要求先有一次用户操作才能出声：界面在第一次点击/触摸时调用 unlock()。
 */

function tone(context, at, options) {
  const osc = context.createOscillator()
  const gain = context.createGain()
  osc.type = options.type ?? 'sine'
  osc.frequency.setValueAtTime(options.freq, at)
  if (options.to) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, options.to), at + options.dur)
  }
  const peak = options.gain ?? 0.08
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.linearRampToValueAtTime(peak, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + options.dur)
  osc.connect(gain)
  gain.connect(context.destination)
  osc.start(at)
  osc.stop(at + options.dur + 0.03)
}

function noise(context, at, options) {
  const length = Math.max(1, Math.floor(context.sampleRate * options.dur))
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) {
    const decay = 1 - i / length
    data[i] = (Math.random() * 2 - 1) * decay * decay
  }
  const source = context.createBufferSource()
  source.buffer = buffer
  const filter = context.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = options.freq ?? 1400
  filter.Q.value = options.q ?? 0.9
  const gain = context.createGain()
  gain.gain.value = options.gain ?? 0.12
  source.connect(filter)
  filter.connect(gain)
  gain.connect(context.destination)
  source.start(at)
}

const VOICES = {
  // 摇骰子：几声木质的碰撞
  dice(context, at) {
    for (let i = 0; i < 4; i += 1) {
      noise(context, at + i * 0.075, { dur: 0.05, freq: 900 + i * 260, gain: 0.1 })
    }
    tone(context, at + 0.32, { freq: 180, to: 90, dur: 0.16, gain: 0.07, type: 'triangle' })
  },
  // 棋子走一格
  step(context, at) {
    tone(context, at, { freq: 720, to: 560, dur: 0.07, gain: 0.05, type: 'sine' })
  },
  // 起飞
  launch(context) {
    const at = context.currentTime + 0.01
    tone(context, at, { freq: 260, to: 900, dur: 0.34, gain: 0.07, type: 'triangle' })
    noise(context, at + 0.04, { dur: 0.3, freq: 2200, gain: 0.05 })
  },
  // 撞回对手
  capture(context) {
    const at = context.currentTime + 0.01
    noise(context, at, { dur: 0.22, freq: 700, gain: 0.18 })
    tone(context, at, { freq: 190, to: 60, dur: 0.28, gain: 0.12, type: 'square' })
  },
  // 一架飞机到家
  home(context) {
    const at = context.currentTime + 0.01
    tone(context, at, { freq: 880, dur: 0.11, gain: 0.07 })
    tone(context, at + 0.1, { freq: 1320, dur: 0.16, gain: 0.06 })
  },
  // 轮到你了
  turn(context) {
    const at = context.currentTime + 0.01
    tone(context, at, { freq: 520, dur: 0.1, gain: 0.06 })
    tone(context, at + 0.1, { freq: 780, dur: 0.14, gain: 0.06 })
  },
  chat(context) {
    tone(context, context.currentTime + 0.01, { freq: 960, dur: 0.05, gain: 0.045 })
  },
  win(context) {
    const at = context.currentTime + 0.02
    const notes = [523, 659, 784, 1046]
    notes.forEach((freq, index) => {
      tone(context, at + index * 0.12, { freq, dur: 0.22, gain: 0.08, type: 'triangle' })
    })
  },
}

export function createAudio() {
  let context = null
  let enabled = true

  function ensure() {
    if (context) return context
    const Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null
    if (!Ctor) return null
    try {
      context = new Ctor()
    } catch (error) {
      context = null
    }
    return context
  }

  function unlock() {
    const ctx = ensure()
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {})
    }
  }

  function play(name) {
    if (!enabled) return
    const ctx = ensure()
    if (!ctx || ctx.state !== 'running') return
    const voice = VOICES[name]
    if (!voice) return
    try {
      voice(ctx, ctx.currentTime + 0.01)
    } catch (error) {
      /* 音效永远不能影响对局 */
    }
  }

  return {
    play,
    unlock,
    setEnabled(value) {
      enabled = !!value
      if (enabled) unlock()
    },
    get enabled() {
      return enabled
    },
    get ready() {
      return !!context && context.state === 'running'
    },
  }
}

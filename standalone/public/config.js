/**
 * 想自己改东西，基本都在这个文件里：
 *   THEMES   四色棋子 + 界面底色（改颜色）
 *   SPEEDS   动画快慢（改节奏）
 *   DURATION 各段动画原本的毫秒数（改手感）
 */

export const DURATION = {
  move: 320,      // 飞机平移
  dice: 560,      // 摇骰子（点一下可以跳过）
  takeoff: 620,   // 起飞
  capture: 700,   // 撞击
  hop: 260,       // 跳跃/飞行的小跳
}

export const THEMES = {
  classic: {
    name: '经典',
    red: '#e5484d',
    blue: '#3a7bd5',
    amber: '#d99a1c',
    green: '#2fa84f',
    base: '#0e1524',
    panel: '#151d2e',
    line: '#243049',
    ink: '#e9eefc',
    muted: '#98a6bd',
    accent: '#5b8def',
  },
  vivid: {
    name: '鲜明',
    red: '#ff4d6d',
    blue: '#4d8dff',
    amber: '#ffb300',
    green: '#22d17a',
    base: '#0a1220',
    panel: '#122036',
    line: '#1e3355',
    ink: '#eaf3ff',
    muted: '#8fa6c7',
    accent: '#00c2ff',
  },
  candy: {
    name: '糖果',
    red: '#ef6461',
    blue: '#5d9cec',
    amber: '#f5b041',
    green: '#58c27d',
    base: '#1b1524',
    panel: '#241b30',
    line: '#3a2c4a',
    ink: '#f6efff',
    muted: '#b9a8cd',
    accent: '#b085f5',
  },
}

export const SPEEDS = {
  slow: { name: '慢', factor: 1.7 },
  normal: { name: '标准', factor: 1 },
  fast: { name: '快', factor: 0.55 },
  off: { name: '关', factor: 0 },
}

const STORE_KEY = 'ludo.settings.v1'

export function loadSettings() {
  const fallback = { theme: 'classic', animation: true, speed: 'normal', sound: true }
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
    if (!stored || typeof stored !== 'object') return fallback
    return {
      theme: THEMES[stored.theme] ? stored.theme : fallback.theme,
      animation: stored.animation !== false,
      speed: SPEEDS[stored.speed] ? stored.speed : fallback.speed,
      sound: stored.sound !== false,
    }
  } catch (error) {
    return fallback
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings))
  } catch (error) {
    /* ignore */
  }
}

/** 当前动画倍率：设置关掉或速度为 0 时返回 0（等于瞬间完成）。 */
export function speedFactor(settings) {
  if (!settings.animation) return 0
  return SPEEDS[settings.speed]?.factor ?? 1
}

export function applyTheme(settings) {
  const theme = THEMES[settings.theme] ?? THEMES.classic
  const root = document.documentElement
  for (const key of ['red', 'blue', 'amber', 'green', 'base', 'panel', 'line', 'ink', 'muted', 'accent']) {
    root.style.setProperty('--' + key, theme[key])
  }
  root.dataset.theme = settings.theme
  root.dataset.motion = settings.animation && settings.speed !== 'off' ? 'on' : 'off'
  root.style.setProperty('--speed', String(speedFactor(settings)))
  return theme
}

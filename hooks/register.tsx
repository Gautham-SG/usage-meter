import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-meter', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const isHidden = atom({ plugin: 'usage-meter', key: 'isHidden' } as const, false)
// Bumped by the timers and by turn start/end; a write redraws the band.
const frame = atom({ plugin: 'usage-meter', key: 'frame' } as const, 0)

const LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
  ctx: 'Context',
}
const SHORT: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'Week',
  spend_limit: 'Spend',
}

// terminal colours
const INK = {
  title: '#c4b5fd',
  track: '#3f3f46',
  ok: '#4ade80',
  warn: '#fbbf24',
  hot: '#f87171',
  money: '#f0abfc',
  sep: '#52525b',
  glint: '#f4f4f5',
}
const tone = (pct: number) => (pct >= 85 ? INK.hot : pct >= 60 ? INK.warn : INK.ok)
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const TWEEN_MS = 900
const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
const clamp = (n: number) => Math.max(0, Math.min(100, n))

// ---- formatting ------------------------------------------------------------

const span = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}
const tight = (t: string) => t.replace(' ', '').replace(/(\d+h)(\d)m$/, '$1 0$2m').replace(' ', '')

const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`
const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)

const toSnapshot = (u: any): Snapshot => ({
  limits: u.rateLimits.map((l: any) => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    resetsAt: l.resetsAt,
  })),
  contextPercent: u.context.percent ?? null,
  contextTokens: u.context.tokens ?? null,
  contextWindow: u.context.window,
  costUsd: u.cost?.usd ?? null,
  startedAt: u.startedAt,
})

const targets = (s: Snapshot) => {
  const t: Record<string, number> = {}
  for (const l of s.limits) t[l.kind] = l.percentUsed
  if (s.contextPercent !== null) t.ctx = s.contextPercent
  if (s.costUsd !== null) t.cost = s.costUsd
  return t
}

// ---- the desktop capsules (SVG) -----------------------------------------------

type Hue = [string, string]
const HUE: Record<string, Hue> = {
  five_hour: ['#f0845a', '#c9502a'],
  seven_day: ['#9580f5', '#5f4ce0'],
  spend_limit: ['#f0845a', '#c9502a'],
  ctx: ['#35c9c0', '#1793b0'],
}
const WARN: Hue = ['#f5b82e', '#d98606']
const HOT: Hue = ['#f4476b', '#c3123f']
const hueFor = (key: string, pct: number): Hue =>
  pct >= 85 ? HOT : pct >= 60 ? WARN : (HUE[key] ?? HUE.ctx)

type Pill = {
  key: string
  label: string
  value: string
  note: string
  pct?: number
  fromPct?: number
}

// The slot, measured: 768 wide, rows 20px, columns 8px, padding 10px down and
// 8px across. The top 10px of the drawing hangs above the slot, clipped. Painted
// the page's own colour, so the slot itself disappears and the capsules float.
const PAGE = '#191919'
const W = 768
const H = 50
// Painted past the slot on the right and bottom, so no sliver of it shows.
const BLEED_W = W + 8
const BLEED_H = H + 6
const COST_W = 124
const GAP = 8
const TOP = 17
const TALL = 30

const WAVE = `M-900 -12 L0 -12 ${'q4 3 0 6 q-4 3 0 6 '.repeat(7)}L-900 72 Z`

const capsule = (p: Pill, x: number, w: number, i: number, isBusy: boolean) => {
  const clip = `<clipPath id="c-${p.key}"><rect x="${x}" y="${TOP}" width="${w}" height="${TALL}" rx="${TALL / 2}"/></clipPath>`
  let liquid = ''
  let edge = 'stroke="none"'
  if (p.pct !== undefined) {
    const hue = hueFor(p.key, p.pct)
    const to = (clamp(p.pct) / 100) * w
    const from = (clamp(p.fromPct ?? p.pct) / 100) * w
    const sweep =
      from === to
        ? ''
        : `<animateTransform attributeName="transform" type="translate" from="${x + from} 0" to="${x + to} 0" dur="1s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>`
    const wave = `<path d="${WAVE}" fill="url(#g-${p.key})"><animateTransform attributeName="transform" type="translate" from="0 0" to="0 12" dur="${isBusy ? '0.9s' : '2.6s'}" repeatCount="indefinite"/></path>`
    liquid = `<defs><linearGradient id="g-${p.key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hue[0]}"/><stop offset="1" stop-color="${hue[1]}"/></linearGradient></defs>
    ${p.pct > 0 ? `<g transform="translate(${x + to} 0)">${sweep}${wave}</g>` : ''}`
    if (p.pct >= 85) {
      edge = `stroke="${hue[0]}" stroke-opacity="0.9"`
    }
  }
  const pulse =
    p.pct !== undefined && p.pct >= 85
      ? '<animate attributeName="stroke-opacity" values="0.25;1;0.25" dur="1.4s" repeatCount="indefinite"/>'
      : ''
  // Light runs along each capsule, one after the other, while a turn runs.
  const shimmer = isBusy
    ? `<rect x="${x - 90}" y="${TOP}" width="70" height="${TALL}" fill="url(#shine)"><animate attributeName="x" from="${x - 90}" to="${x + w + 20}" dur="2s" begin="${(i * 0.25).toFixed(2)}s" repeatCount="indefinite"/></rect>`
    : ''
  const base = TOP + TALL / 2 + 4.5
  return `${clip}
  <rect x="${x}" y="${TOP}" width="${w}" height="${TALL}" rx="${TALL / 2}" fill="#26252e"/>
  <g clip-path="url(#c-${p.key})">
    ${liquid}
    <rect x="${x}" y="${TOP}" width="${w}" height="${TALL / 2}" fill="url(#gloss)"/>
    ${shimmer}
  </g>
  <rect x="${x + 0.5}" y="${TOP + 0.5}" width="${w - 1}" height="${TALL - 1}" rx="${TALL / 2 - 0.5}" fill="none" ${edge}>${pulse}</rect>
  <text x="${x + 15}" y="${base}" class="lab">${p.label}</text>
  ${p.note === '' ? '' : `<text x="${x + w - 52}" y="${base}" text-anchor="end" class="note">${p.note}</text>`}
  <text x="${x + w - 15}" y="${base}" text-anchor="end" class="val">${p.value}</text>`
}

const capsules = (pills: Pill[], isBusy: boolean) => {
  const meters = pills.filter(p => p.pct !== undefined).length
  const hasCost = meters < pills.length
  const room = W - 2 - (hasCost ? COST_W + GAP : 0) - GAP * Math.max(0, meters - 1)
  const mw = room / Math.max(1, meters)
  let x = 0
  const body = pills
    .map((p, i) => {
      const w = p.pct === undefined ? COST_W : mw
      const out = capsule(p, x, w, i, isBusy)
      x += w + GAP
      return out
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BLEED_W}" height="${BLEED_H}" viewBox="0 0 ${BLEED_W} ${BLEED_H}" style="display:block">
  <defs>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.13"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <style>
      text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-variant-numeric: tabular-nums; }
      .lab { font-size: 12px; font-weight: 600; fill: #f1f0f6; }
      .val { font-size: 13px; font-weight: 700; fill: #ffffff; }
      .note { font-size: 10.5px; fill: #ffffff; fill-opacity: 0.62; }
    </style>
  </defs>
  <rect width="${BLEED_W}" height="${BLEED_H}" fill="${PAGE}"/>
  ${body}
</svg>`
}

// ---- the mod ------------------------------------------------------------------

export const register: Register = on => {
  // The terminal band glides values with a timer; the card hands the glide to
  // the SVG itself (from -> to), so it needs no timer.
  let from: Record<string, number> = {}
  let to: Record<string, number> = {}
  let changedAt = 0
  let isRunning = false
  let drawnOn = ''
  let fresh = false // the next draw sweeps from the last reading
  let cardFrom: Record<string, number> = {}
  let ticker: { cancel: () => void } | undefined

  const shown = (key: string, now: number) => {
    const b = to[key] ?? 0
    const a = from[key] ?? 0
    return a + (b - a) * ease((now - changedAt) / TWEEN_MS)
  }

  const take = (s: Snapshot, now: number) => {
    const next = targets(s)
    const was: Record<string, number> = {}
    for (const k of Object.keys(next)) was[k] = shown(k, now)
    const before = to
    from = was
    to = next
    changedAt = now
    cardFrom = { ...before }
    fresh = true
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meter',
      description: 'Show or hide the usage capsules',
    })
    const u = await $.session.usage()
    const s = toSnapshot(u)
    take(s, await $.clock.now())
    await update($, snapshot, () => s)
    // One beat: quick while the terminal band animates; otherwise a redraw about
    // every minute for the countdowns. The card animates itself between redraws.
    let idle = 0
    ticker?.cancel()
    ticker = $.clock.every(110, async () => {
      const now = await $.clock.now()
      idle += 1
      const isMoving =
        drawnOn === 'terminal' && (isRunning || now - changedAt < TWEEN_MS + 150)
      if (isMoving || idle >= 545) {
        idle = 0
        await update($, frame, n => n + 1)
      }
    })
    $.ui.status(undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isRunning = true
    await update($, frame, n => n + 1)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isRunning = false
    await update($, frame, n => n + 1)
    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    return { text: hidden ? 'Usage shown.' : 'Usage hidden.' }
  })

  on('session.measure', async ($, e, next) => {
    const u = await $.session.usage()
    const s = toSnapshot(u)
    take(s, await $.clock.now())
    await update($, snapshot, () => s)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null || (await read($, isHidden))) {
      return next(e)
    }
    const tick = await read($, frame)
    const now = await $.clock.now()
    const els: any = $.ui.resolve(e)
    drawnOn = String(e.surface)

    // Desktop: floating capsules. Interactive, or SMIL won't run.
    if (els.Svg) {
      const { Box, Svg } = els
      const animate = fresh
      fresh = false
      const from0 = (k: string) => (animate ? (cardFrom[k] ?? 0) : (to[k] ?? 0))

      const pills: Pill[] = s.limits.map(l => ({
        key: l.kind,
        label: LABEL[l.kind] ?? l.kind,
        value: `${Math.round(l.percentUsed)}%`,
        note: span(l.resetsAt, now),
        pct: l.percentUsed,
        fromPct: from0(l.kind),
      }))
      if (s.contextPercent !== null) {
        pills.push({
          key: 'ctx',
          label: LABEL.ctx,
          value: `${Math.round(s.contextPercent)}%`,
          note: s.contextTokens !== null ? tokens(s.contextTokens) : '',
          pct: s.contextPercent,
          fromPct: from0('ctx'),
        })
      }
      if (s.costUsd !== null) {
        pills.push({ key: 'cost', label: 'Cost', value: money(s.costUsd), note: '' })
      }

      return (
        <Box position="relative" height={1}>
          <Box position="absolute" top={-1} left={-1} right={-2}>
            <Svg
              source={capsules(pills, isRunning)}
              alt={`Claude usage. ${pills.map(p => `${p.label} ${p.value}`).join('. ')}.`}
              width={BLEED_W}
              height={BLEED_H}
              isInteractive={true}
            />
          </Box>
        </Box>
      )
    }

    // Terminal: an aligned text band with a glide, a spinner and a glint.
    const { Box, Text } = els
    const cols = (e as any).viewport?.columns ?? 100
    const isWide = cols >= 100
    const barW = isWide ? 10 : 6

    const metrics: { key: string; label: string; note: string }[] = s.limits.map(l => ({
      key: l.kind,
      label: SHORT[l.kind] ?? l.kind,
      note: isWide ? tight(span(l.resetsAt, now)) : '',
    }))
    if (s.contextPercent !== null) metrics.push({ key: 'ctx', label: 'Ctx', note: '' })

    const worst = Math.max(0, ...metrics.map(m => shown(m.key, now)))
    const isHot = worst >= 85
    const frameColor = isHot ? (tick % 10 < 5 ? INK.hot : '#7f1d1d') : worst >= 60 ? INK.warn : INK.track
    const glyph = isRunning ? SPIN[tick % SPIN.length] : '◆'
    const costNow = shown('cost', now)

    const parts: any[] = []
    metrics.forEach((m, i) => {
      const v = shown(m.key, now)
      const filled = Math.max(0, Math.min(barW, Math.round((v / 100) * barW)))
      const sweep = isRunning ? tick % (barW + 6) : -1
      const col = tone(v)
      const bar: any[] = []
      for (let c = 0; c < barW; c++) {
        const isOn = c < filled
        const isGlint = isOn && (c === sweep || c === sweep - 1)
        bar.push(
          <Text key={c} color={isOn ? (isGlint ? INK.glint : col) : INK.track}>
            {isOn ? '▰' : '▱'}
          </Text>,
        )
      }
      const isFlash = v >= 85 && tick % 10 < 5
      if (i > 0) parts.push(<Text key={`s${m.key}`} color={INK.sep}> │ </Text>)
      parts.push(
        <Text key={m.key}>
          <Text dimColor>{m.label.padEnd(5)}</Text>
          {bar}
          <Text bold color={isFlash ? INK.glint : col}>{` ${Math.round(v)}%`.padStart(5)}</Text>
          {m.note !== '' && <Text dimColor>{` ↻${m.note}`.padEnd(7)}</Text>}
        </Text>,
      )
    })

    return (
      <Box borderStyle="round" borderColor={frameColor} paddingX={1}>
        <Text bold color={isRunning ? INK.glint : INK.title}>{`${glyph} Usage`}</Text>
        <Text color={INK.sep}> │ </Text>
        {metrics.length === 0 ? <Text dimColor>limits appear after your first reply</Text> : parts}
        <Box flexGrow={1} />
        {s.costUsd !== null && (
          <Text>
            <Text dimColor>Cost </Text>
            <Text bold color={INK.money}>{money(costNow)}</Text>
          </Text>
        )}
      </Box>
    )
  })
}

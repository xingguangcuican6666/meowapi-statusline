/*
Copyright (C) 2026 xingguangcuican6666

This file is part of cc-quota-statusline, licensed under the GNU Affero
General Public License v3.0.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Renders subscription quota bars for Claude Code's status line.
//
// Claude Code only parses anthropic-ratelimit-unified-* for claude.ai
// subscriber logins; an ANTHROPIC_AUTH_TOKEN / API-key session is hard-gated
// out of that path, so the native bars never appear. The status line command
// is not gated, so this reads the same snapshot from the gateway's
// GET /api/oauth/usage and draws it.
//
// Two invariants matter more than the rendering:
//   - A failed refresh replays the last good line instead of printing nothing.
//     Claude Code replaces the whole status line with whatever we print, empty
//     string included, so printing "" makes the bar vanish.
//   - Every failure path exits 0 with no stderr noise; a status line must never
//     be the reason a prompt fails.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_REFRESH_INTERVAL = 20
// A cold request through Cloudflare has been measured at 2.4s. Anything tighter
// than this turns normal latency into apparently random missing bars.
export const FETCH_TIMEOUT_MS = 18_000
export const CACHE_TTL_MS = 20_000
// Retry soon after a failure so one dropped connection costs a single interval
// of staleness rather than a stuck value.
export const FAIL_TTL_MS = 5_000

const BAR_WIDTH = 5
const CACHE_FILE = path.join(os.tmpdir(), 'cc-quota-statusline.cache')

const RESET = '\u001b[0m'
const DIM = '\u001b[2m'

function colorize(utilization, text) {
  const code = utilization >= 85 ? '31' : utilization >= 60 ? '33' : '32'
  return `\u001b[${code}m${text}${RESET}`
}

export function bar(utilization) {
  const clamped = Math.min(100, Math.max(0, Number(utilization) || 0))
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  return '▰'.repeat(filled) + '▱'.repeat(BAR_WIDTH - filled)
}

export function human(seconds) {
  const total = Math.trunc(Number(seconds) || 0)
  if (total <= 0) return 'now'
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

// The gateway reports utilization as a 0-100 percentage; Claude Code's own
// headers use a 0-1 fraction. normalizeUsage accepts either so the same package
// also works against a proxy that mirrors Anthropic's JSON literally.
export function normalizeUsage(data) {
  const periods = []
  for (const [key, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
    ['seven_day_opus', '7d-opus'],
    ['seven_day_sonnet', '7d-sonnet'],
  ]) {
    const period = data?.[key]
    if (!period || typeof period !== 'object') continue
    const raw = Number(period.utilization)
    if (!Number.isFinite(raw)) continue
    const utilization = raw <= 1 && raw > 0 ? raw * 100 : raw
    periods.push({
      label,
      utilization: Math.min(100, Math.max(0, utilization)),
      resetsAt: Number(period.resets_at) || 0,
    })
  }
  return periods
}

export function renderLine(data, nowSeconds = Date.now() / 1000) {
  const segments = []
  for (const period of normalizeUsage(data)) {
    const percent = Math.round(period.utilization)
    let segment = colorize(period.utilization, `${period.label} ${bar(period.utilization)} ${percent}%`)
    if (period.resetsAt > 0) {
      segment += ` ${DIM}↻${human(period.resetsAt - nowSeconds)}${RESET}`
    }
    segments.push(segment)
  }
  return segments.join(' │ ')
}

function readCacheFile(cacheFile) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch {
    return null
  }
}

function writeCacheFile(cacheFile, line, ok, at = Date.now() / 1000) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ at, ok, line }))
  } catch {
    // A read-only or missing temp dir must not break the status line.
  }
}

// statusline is the whole refresh cycle: cache hit, fetch, render, freeze on
// failure. Timestamps come from the same clock as expiry checks so injected
// clocks stay consistent. fetchUsage is injected so tests can exercise both
// paths without a network.
export async function statusline({ cacheFile = CACHE_FILE, fetchUsage, nowSeconds } = {}) {
  const now = () => nowSeconds ?? Date.now() / 1000
  const cached = readCacheFile(cacheFile)
  if (cached) {
    const ttl = cached.ok ? CACHE_TTL_MS : FAIL_TTL_MS
    if (now() - Number(cached.at ?? 0) < ttl / 1000) {
      return cached.line ?? ''
    }
  }
  // Whatever we showed last, even once its cache entry has expired. This is
  // what makes a failure freeze the bar instead of blanking it.
  const previous = cached?.line ?? ''

  let line
  try {
    line = renderLine(await fetchUsage(), now())
  } catch {
    writeCacheFile(cacheFile, previous, false, now())
    return previous
  }
  writeCacheFile(cacheFile, line, true, now())
  return line
}

// settingsEnv reads the env block of ~/.claude/settings.json: the status line
// subprocess does not always inherit the variables the REPL was started with.
function settingsEnv() {
  try {
    const file = path.join(os.homedir(), '.claude', 'settings.json')
    return JSON.parse(fs.readFileSync(file, 'utf8')).env ?? {}
  } catch {
    return {}
  }
}

export function credentials(env = process.env) {
  const stored = settingsEnv()
  const base = (env.CC_QUOTA_BASE_URL || env.ANTHROPIC_BASE_URL || stored.ANTHROPIC_BASE_URL || '').trim()
  const token = (
    env.CC_QUOTA_TOKEN ||
    env.ANTHROPIC_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    stored.ANTHROPIC_AUTH_TOKEN ||
    stored.ANTHROPIC_API_KEY ||
    ''
  ).trim()
  if (!base || !token) return null
  const root = base.replace(/\/+$/, '')
  const usageUrl = root.endsWith('/api') ? `${root}/oauth/usage` : `${root}/api/oauth/usage`
  return { usageUrl, token }
}

export async function fetchUsage({ usageUrl, token }, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetch(usageUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Cloudflare's browser-integrity check rejects node's default agent
      // persona on this zone, so present a stable client name.
      'User-Agent': 'cc-quota-statusline/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`usage endpoint returned ${response.status}`)
  }
  return response.json()
}

// drainStdin consumes the session JSON Claude Code writes to us. Leaving it
// unread is harmless for small payloads, but the writer should see the pipe
// closed cleanly rather than an EPIPE.
export async function drainStdin(stream = process.stdin, timeoutMs = 500) {
  if (stream.isTTY) return
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      stream.destroy?.()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    stream.on('data', () => {})
    stream.on('end', done)
    stream.on('error', done)
    stream.resume?.()
  })
}
/*
Copyright (C) 2026 xingguangcuican6666

This file is part of meowapi-statusline, licensed under the GNU Affero
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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  bar,
  CACHE_TTL_MS,
  credentials,
  FAIL_TTL_MS,
  human,
  isPlausibleReset,
  normalizeUsage,
  renderLine,
  RESET_SKEW_SECONDS,
  statusline,
} from '../lib/statusline.js'

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'meowapi-statusline-test-'))
after(() => fs.rmSync(WORK, { recursive: true, force: true }))

let seq = 0
function cachePath() {
  seq += 1
  return path.join(WORK, `cache-${seq}.json`)
}

const USAGE = {
  five_hour: { utilization: 55, resets_at: 1000 + 4 * 3600 + 43 * 60 },
  seven_day: { utilization: 5, resets_at: 1000 + 6 * 86400 + 23 * 3600 },
}

describe('bar', () => {
  it('fills proportional cells and clamps out-of-range input', () => {
    assert.equal(bar(0), '▱▱▱▱▱')
    assert.equal(bar(50), '▰▰▰▱▱')
    assert.equal(bar(100), '▰▰▰▰▰')
    assert.equal(bar(-20), '▱▱▱▱▱')
    assert.equal(bar(320), '▰▰▰▰▰')
  })
})

describe('human', () => {
  it('renders days, hours and minutes', () => {
    assert.equal(human(6 * 86400 + 23 * 3600), '6d23h')
    assert.equal(human(4 * 3600 + 43 * 60), '4h43m')
    assert.equal(human(90), '1m')
    assert.equal(human(0), 'now')
  })
})

describe('normalizeUsage', () => {
  it('reads the gateway percentage fields', () => {
    assert.deepEqual(
      normalizeUsage(USAGE).map((p) => [p.label, Math.round(p.utilization)]),
      [
        ['5h', 55],
        ['7d', 5],
      ],
    )
  })

  it('accepts a 0-1 fraction and drops unknown periods', () => {
    const periods = normalizeUsage({ five_hour: { utilization: 0.62 }, seven_day_opus: null })
    assert.deepEqual(
      periods.map((p) => [p.label, Math.round(p.utilization)]),
      [['5h', 62]],
    )
  })
})

describe('renderLine', () => {
  it('renders both windows with reset countdowns', () => {
    const line = renderLine(USAGE, 1000)
    assert.match(line, /5h ▰▰▰▱▱ 55%/)
    assert.match(line, /↻4h43m/)
    assert.match(line, /7d ▱▱▱▱▱ 5%/)
    assert.match(line, /↻6d23h/)
    assert.match(line, / │ /)
  })

  it('renders an empty line for a payload with no periods', () => {
    assert.equal(renderLine({}, 1000), '')
  })

  // A window that just opened reports a reset a full window out. That is a real
  // countdown from the first refresh, not an echo, so it must be drawn.
  it('keeps a reset that is one window away', () => {
    const fresh = { five_hour: { utilization: 0, resets_at: 1000 + 5 * 3600 } }
    assert.match(renderLine(fresh, 1000), /↻5h00m/)
  })

  it('keeps a reset that is inside the window', () => {
    const line = renderLine({ five_hour: { utilization: 100, resets_at: 1000 + 2 * 3600 } }, 1000)
    assert.match(line, /↻2h00m/)
  })
})

describe('isPlausibleReset', () => {
  it('accepts a future reset up to one window away, with skew slack', () => {
    assert.equal(isPlausibleReset(1000 + 3600, 1000, 5 * 3600), true)
    assert.equal(isPlausibleReset(1000 + 5 * 3600 - 1, 1000, 5 * 3600), true)
    assert.equal(isPlausibleReset(1000 + 5 * 3600, 1000, 5 * 3600), true)
    assert.equal(isPlausibleReset(1000 + 5 * 3600 + RESET_SKEW_SECONDS, 1000, 5 * 3600), true)
  })

  it('rejects a reset beyond the window or already past', () => {
    assert.equal(isPlausibleReset(1000 + 5 * 3600 + RESET_SKEW_SECONDS + 1, 1000, 5 * 3600), false)
    assert.equal(isPlausibleReset(1000 + 30 * 86400, 1000, 5 * 3600), false)
    assert.equal(isPlausibleReset(1000, 1000, 5 * 3600), false)
    assert.equal(isPlausibleReset(900, 1000, 5 * 3600), false)
  })
})

describe('statusline', () => {
  it('fetches once, then serves the cache within its TTL', async () => {
    const cacheFile = cachePath()
    let calls = 0
    const fetchUsage = async () => {
      calls += 1
      return USAGE
    }
    const first = await statusline({ cacheFile, fetchUsage, nowSeconds: 1000 })
    const second = await statusline({ cacheFile, fetchUsage, nowSeconds: 1000 + CACHE_TTL_MS / 2000 })
    assert.equal(calls, 1)
    assert.equal(first, second)
    assert.match(first, /5h/)
  })

  it('freezes the previous line when the fetch fails', async () => {
    const cacheFile = cachePath()
    const fetchedAt = Math.floor(Date.now() / 1000) - 3600
    const good = await statusline({ cacheFile, fetchUsage: async () => USAGE, nowSeconds: fetchedAt })
    assert.match(good, /5h/)

    // Straight past the success TTL: the fetch runs and throws.
    const now = fetchedAt + CACHE_TTL_MS / 1000 + 1
    const frozen = await statusline({
      cacheFile,
      fetchUsage: async () => {
        throw new Error('timeout')
      },
      nowSeconds: now,
    })
    assert.equal(frozen, good)

    // The failed entry is held for FAIL_TTL_MS only, and still carries the line.
    const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    assert.equal(entry.ok, false)
    assert.equal(entry.line, good)

    let retried = 0
    const afterFailTtl = await statusline({
      cacheFile,
      fetchUsage: async () => {
        retried += 1
        return USAGE
      },
      nowSeconds: now + FAIL_TTL_MS / 1000 + 1,
    })
    assert.equal(retried, 1)
    assert.equal(afterFailTtl, good)
  })

  it('prints nothing only when it never had a line to show', async () => {
    const cacheFile = cachePath()
    const line = await statusline({
      cacheFile,
      fetchUsage: async () => {
        throw new Error('offline')
      },
      nowSeconds: 1000,
    })
    assert.equal(line, '')
  })
})

describe('credentials', () => {
  it('builds the usage URL from a base URL with or without /api', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-1' }
    assert.equal(credentials(env).usageUrl, 'https://gw.example.com/api/oauth/usage')
    assert.equal(credentials({ ...env, ANTHROPIC_BASE_URL: 'https://gw.example.com/api/' }).usageUrl, 'https://gw.example.com/api/oauth/usage')
    assert.equal(credentials({ ...env, ANTHROPIC_BASE_URL: 'https://gw.example.com/v1' }).usageUrl, 'https://gw.example.com/v1/api/oauth/usage')
  })

  it('returns null without both a base URL and a token', () => {
    assert.equal(credentials({}), null)
    assert.equal(credentials({ ANTHROPIC_BASE_URL: 'https://gw.example.com' }), null)
    assert.equal(credentials({ ANTHROPIC_AUTH_TOKEN: 'sk-1' }), null)
  })
})
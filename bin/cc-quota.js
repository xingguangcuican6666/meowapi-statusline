#!/usr/bin/env node
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

import {
  credentials,
  DEFAULT_REFRESH_INTERVAL,
  drainStdin,
  fetchUsage,
  statusline,
} from '../lib/statusline.js'

function printSettings() {
  process.stdout.write(
    `${JSON.stringify(
      {
        statusLine: {
          type: 'command',
          command: 'npx -y cc-quota-statusline',
          padding: 0,
          refreshInterval: DEFAULT_REFRESH_INTERVAL,
        },
      },
      null,
      2,
    )}\n`,
  )
}

async function main(argv) {
  if (argv.includes('--print-config')) {
    printSettings()
    return
  }

  await drainStdin()

  const auth = credentials()
  const line = await statusline({
    fetchUsage: async () => {
      if (!auth) throw new Error('no gateway credentials in env or ~/.claude/settings.json')
      return fetchUsage(auth)
    },
  })
  if (line) process.stdout.write(line + '\n')
}

main(process.argv.slice(2)).catch(() => {
  // Exit quietly: a status line failure must not surface as prompt noise.
  process.exit(0)
})
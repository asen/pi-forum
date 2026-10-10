#!/usr/bin/env node
// Stands in for npm in pi-integration.test.ts's consumer installs, linked as npm in a directory
// ahead of the real one on PATH: appends { cwd, args } for each call to PI_FORUM_TEST_NPM_LOG, one JSON
// line each, then runs the real npm at PI_FORUM_TEST_NPM with the same arguments and exit status.
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export interface NpmCall {
  cwd: string
  args: string[]
}

// The test sets both for every Pi it runs with this npm.
const call: NpmCall = { cwd: process.cwd(), args: process.argv.slice(2) }
appendFileSync(process.env.PI_FORUM_TEST_NPM_LOG!, JSON.stringify(call) + '\n')
const result = spawnSync(process.env.PI_FORUM_TEST_NPM!, process.argv.slice(2), { stdio: 'inherit' })
process.exitCode = result.status ?? 1

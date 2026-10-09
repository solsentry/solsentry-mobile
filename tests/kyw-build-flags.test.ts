import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { API_BASE_OVERRIDE, SELFTEST_BUILD } from '../src/kyw/build-flags'

const ROOT = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) return name === 'node_modules' || name === 'android' ? [] : sources(rel)
    return /\.(ts|tsx|js)$/.test(name) ? [rel] : []
  })
}

describe('build variants', () => {
  it('a normal build has the self-test off and no API override', () => {
    expect(SELFTEST_BUILD).toBe(false)
    expect(API_BASE_OVERRIDE).toBeNull()
  })

  // An inlined environment value stays in the bundler's transform cache: a release built after a
  // self-test build carried the self-test screen, the vectors and the local API address.
  it('app code never reads the environment', () => {
    const offenders = [...sources('app'), ...sources('src'), ...sources('modules'), 'index.js'].filter((f) =>
      /process\.env/.test(readFileSync(join(ROOT, f), 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})

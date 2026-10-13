import { describe, expect, it } from 'vitest'
import { isAllowedDownloadUrl, parseLatest, updateToOffer } from '../src/kyw/update'

const good = {
  versionCode: 19,
  name: '0.1.19',
  url: 'https://solsentry.app/app/solsentry-0.1.19.apk',
  sha256: '4E95AB71174F74F110785AA816640D0C0C5E9F9FD568AB9E1FFD478DD58D09DB',
  notes: 'Fixes the cap line.',
}

describe('the published latest build', () => {
  it('reads a well-formed file and lowercases the sha256', () => {
    expect(parseLatest(good)).toEqual({ ...good, sha256: good.sha256.toLowerCase() })
  })
  it('accepts a GitHub release link and a SolSentry subdomain', () => {
    expect(parseLatest({ ...good, url: 'https://github.com/solsentry/solsentry-mobile/releases/download/v19/app.apk' })).not.toBeNull()
    expect(parseLatest({ ...good, url: 'https://api.solsentry.app/app/app.apk' })).not.toBeNull()
  })
  it('refuses links that are not https or point to another host', () => {
    expect(parseLatest({ ...good, url: 'http://solsentry.app/app.apk' })).toBeNull()
    expect(parseLatest({ ...good, url: 'https://evil.example/app.apk' })).toBeNull()
    expect(parseLatest({ ...good, url: 'https://solsentry.app.evil.example/app.apk' })).toBeNull()
    expect(parseLatest({ ...good, url: 'https://user@solsentry.app/app.apk' })).toBeNull()
  })
  it('refuses a missing or bad versionCode or name', () => {
    expect(parseLatest({ ...good, versionCode: '19' })).toBeNull()
    expect(parseLatest({ ...good, versionCode: 1.5 })).toBeNull()
    expect(parseLatest({ ...good, name: '' })).toBeNull()
    expect(parseLatest(null)).toBeNull()
    expect(parseLatest('x')).toBeNull()
  })
  it('drops a malformed sha256 or empty notes without refusing the build', () => {
    expect(parseLatest({ ...good, sha256: 'abc', notes: '  ' })).toMatchObject({ sha256: null, notes: null })
  })
})

describe('which build to offer', () => {
  const latest = parseLatest(good)
  it('offers only a strictly newer build', () => {
    expect(updateToOffer(18, latest, null)).toBe(latest)
    expect(updateToOffer(19, latest, null)).toBeNull()
    expect(updateToOffer(20, latest, null)).toBeNull()
  })
  it('stays quiet when this build does not know its versionCode or the file did not load', () => {
    expect(updateToOffer(null, latest, null)).toBeNull()
    expect(updateToOffer(18, null, null)).toBeNull()
  })
  it('hides a build the user set aside, and shows the next one', () => {
    expect(updateToOffer(18, latest, 19)).toBeNull()
    expect(updateToOffer(18, parseLatest({ ...good, versionCode: 20 }), 19)).not.toBeNull()
  })
})

describe('the download link the app opens', () => {
  it('accepts https on SolSentry hosts and GitHub', () => {
    expect(isAllowedDownloadUrl('https://api.solsentry.app/app/solsentry-0.1.22.apk')).toBe(true)
    expect(isAllowedDownloadUrl('https://solsentry.app/app/x.apk')).toBe(true)
    expect(isAllowedDownloadUrl('https://github.com/solsentry/solsentry-mobile/releases/download/v1/x.apk')).toBe(true)
  })

  it('refuses other schemes and look-alike hosts', () => {
    for (const url of [
      'http://api.solsentry.app/app/x.apk',
      'intent://scan#Intent;scheme=zxing;end',
      'solsentry://account',
      'https://solsentry.app.evil.example/x.apk',
      'https://evilsolsentry.app/x.apk',
      'https://github.com.evil.example/x.apk',
      'https://api.solsentry.app@evil.example/x.apk',
      'javascript:alert(1)',
    ]) {
      expect(isAllowedDownloadUrl(url)).toBe(false)
    }
  })
})

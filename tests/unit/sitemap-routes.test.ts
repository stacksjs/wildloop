import { describe, expect, it } from 'bun:test'

describe('the trail sitemap route', () => {
  it('serves only real trail sitemap chunks, so unknown API paths fall through to a 404', async () => {
    const { trailSitemapPage } = await import('../../app/Support/sitemap')

    expect(trailSitemapPage('/api/sitemap-trails-3.xml')).toBe(3)
    expect(trailSitemapPage('/sitemap-trails-1.xml')).toBe(1)
    expect(trailSitemapPage('/api/nope')).toBeNull()
    expect(trailSitemapPage('/api/sitemap-trails-x.xml')).toBeNull()
  })
})

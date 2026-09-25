import { describe, expect, it } from 'bun:test'
import {
  expectHtmlContaining,
  expectStatus,
  SMOKE_CHECKS,
  type SmokeContext,
  verifyReviewersPayload,
} from '../../scripts/smoke'

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
})

const html = (body: string, status = 200) => ({
  status,
  contentType: 'text/html; charset=utf-8',
  body,
})

describe('status and content checks', () => {
  it('names the status it got', () => {
    expect(expectStatus({ status: 200, contentType: '', body: '' })).toBeNull()
    expect(expectStatus({ status: 502, contentType: '', body: '' })).toBe('expected HTTP 200, got 502')
  })

  it('names the markup that was missing', () => {
    expect(expectHtmlContaining(html('<b>All filters</b>'), ['All filters'])).toBeNull()
    expect(expectHtmlContaining(html('<b>nothing</b>'), ['All filters'])).toContain('"All filters"')
  })

  it('refuses a page that is not HTML, whatever its status', () => {
    expect(expectHtmlContaining(json({ success: true }), ['>Wildloop<'])).toContain('expected HTML')
  })
})

describe('the reviewers payload', () => {
  it('accepts a real answer, empty included', () => {
    expect(verifyReviewersPayload(json({ success: true, windowDays: 30, trails: {} }))).toBeNull()
    expect(verifyReviewersPayload(json({
      success: true,
      windowDays: 30,
      trails: { 7: { recentCount: 31, reviewers: [{ id: 2, name: 'Ada' }] } },
    }))).toBeNull()
  })

  it('catches the route not being registered, which answers the page shell', () => {
    // A missing API route falls through to the SPA: HTTP 200, but HTML.
    const shell = html('<!doctype html><title>WildLoop</title>')
    expect(verifyReviewersPayload(shell)).toContain('may not be registered')
  })

  it('catches a payload that is the wrong shape', () => {
    expect(verifyReviewersPayload(json({ success: false, trails: {} }))).toContain('answered')
    expect(verifyReviewersPayload(json({ success: true, windowDays: 30 }))).toContain('no `trails` object')
    expect(verifyReviewersPayload(json({ success: true, windowDays: 0, trails: {} }))).toContain('windowDays')
    expect(verifyReviewersPayload(json({
      success: true,
      windowDays: 30,
      trails: { 7: { reviewers: [] } },
    }))).toContain('no recentCount')
    expect(verifyReviewersPayload(json({
      success: true,
      windowDays: 30,
      trails: { 7: { recentCount: 2 } },
    }))).toContain('no reviewers array')
  })
})

describe('the check list itself', () => {
  it('asks about trail ids the catalog actually returned', () => {
    const context: SmokeContext = { trailIds: [] }
    const catalog = SMOKE_CHECKS.find(check => check.name === 'trail catalog API')!
    const reviewers = SMOKE_CHECKS.find(check => check.name === 'recent reviewers API')!

    expect(catalog.verify(json({ success: true, trails: [{ id: 41 }, { id: 42 }] }), context)).toBeNull()
    expect(context.trailIds).toEqual([41, 42])
    expect(reviewers.path(context)).toBe('/api/trails/reviewers?ids=41,42')
  })

  it('fails the catalog check on an empty catalog rather than passing an empty page', () => {
    const context: SmokeContext = { trailIds: [] }
    const catalog = SMOKE_CHECKS.find(check => check.name === 'trail catalog API')!

    expect(catalog.verify(json({ success: true, trails: [] }), context)).toContain('no trails')
  })

  it('covers the pages and endpoints a release can break', () => {
    expect(SMOKE_CHECKS.map(check => check.name)).toEqual([
      'home page',
      'trail catalog API',
      'catalog coverage',
      'recent reviewers API',
      'trails page, with its filter bar',
      'trail page shell',
      'search suggestions',
    ])
  })
})

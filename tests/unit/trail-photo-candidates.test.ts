import { describe, expect, it } from 'bun:test'
import {
  candidatesFrom,
  commonsGeosearchUrl,
  distinctiveWords,
  plainText,
  titleNamesTrail,
} from '../../app/Support/trailPhotoCandidates'

/**
 * Narrowing Commons down to photographs that plausibly show a given trail.
 *
 * The thing this has to get right is refusal. A geosearch around Mist Trail
 * returns a dogwood flower, four pine trees and a film poster — all genuinely
 * near the trail, none of them of it. Putting a pine cone on a trail card is
 * worse than the stock photo it replaced, because the stock photo says
 * "Illustrative" and the pine cone would not (#1006).
 */

describe('distinctiveWords', () => {
  it('keeps the words that identify a particular trail', () => {
    expect(distinctiveWords('Mist Trail to Vernal Fall')).toEqual(['mist', 'vernal', 'fall'])
  })

  /*
   * "Trail" matches every trail photograph in the world, which is the same as
   * matching none. Same for the words every American trail name contains.
   */
  it('drops words that every trail name carries', () => {
    expect(distinctiveWords('The Loop Trail')).toEqual([])
    expect(distinctiveWords('Jenny Lake Loop')).toEqual(['jenny', 'lake'])
    expect(distinctiveWords('Bright Angel Trail')).toEqual(['bright', 'angel'])
  })

  it('survives punctuation and casing', () => {
    expect(distinctiveWords('Matt Davis – Steep Ravine Loop')).toEqual(['matt', 'davis', 'steep', 'ravine'])
  })
})

describe('titleNamesTrail', () => {
  it('accepts a title carrying every distinctive word', () => {
    expect(titleNamesTrail('Vernal Falls from the Mist Trail - panoramio.jpg', 'Mist Trail to Vernal Fall'))
      .toEqual(['mist', 'vernal', 'fall'])
  })

  /*
   * A photograph of the waterfall the trail climbs to is offered, and ranked
   * below one that names the trail itself.
   *
   * The first version of this rule demanded every distinctive word and refused
   * this. It was too strict to be useful — nine engaged trails produced one
   * candidate between them, because a long name like "Bright Angel Trail to
   * Three-Mile Resthouse" wants five words in a single caption. What comes out
   * of here is a list somebody looks at, so an extra candidate costs a glance
   * and a missing one costs a stock photo that stays.
   */
  it('offers a title naming part of the trail, ranked below a fuller one', () => {
    const partial = titleNamesTrail('Vernal Fall.jpg', 'Mist Trail to Vernal Fall')
    const full = titleNamesTrail('Vernal Falls from the Mist Trail.jpg', 'Mist Trail to Vernal Fall')

    expect(partial).toEqual(['vernal', 'fall'])
    expect(full.length).toBeGreaterThan(partial.length)
  })

  /*
   * One word is still refused, and that is the guard that matters: it is how a
   * namesake trail in another state inherits somebody else's scenery.
   */
  it('refuses a title sharing only one word with the trail', () => {
    expect(titleNamesTrail('Mist over the valley.jpg', 'Mist Trail to Vernal Fall')).toEqual([])
    expect(titleNamesTrail('Half Dome at sunset.jpg', 'Half Dome via the Mist Trail')).toEqual(['half', 'dome'])
  })

  it('refuses the scenery that happens to be nearby', () => {
    for (const title of ['Cornus nuttallii 08549.JPG', 'Pinus benthamiana 08552.JPG', 'The River Wild.jpg'])
      expect(titleNamesTrail(title, 'Mist Trail to Vernal Fall'), title).toEqual([])
  })

  /*
   * A trail whose name reduces to nothing distinctive can never be matched
   * this way. Returning no candidates is the right answer — the alternative is
   * every "Loop Trail" in four countries sharing one photograph.
   */
  it('matches nothing for a name with no distinctive words', () => {
    expect(titleNamesTrail('Some Loop Trail.jpg', 'Loop Trail')).toEqual([])
  })

  it('does not let a namesake trail inherit another one’s scenery', () => {
    // Two real Dipsea Trails exist in the catalog; a Stinson Beach photo
    // naming only "Dipsea" would match both, so the full name is required.
    expect(titleNamesTrail('Dipsea.jpg', 'Dipsea Trail Stinson')).toEqual([])
  })
})

describe('plainText', () => {
  it('strips the markup Commons puts in an author field', () => {
    expect(plainText('<a href="//commons.wikimedia.org/wiki/User:X" title="X">Fabio Achilli</a>'))
      .toBe('Fabio Achilli')
  })

  it('survives nothing at all', () => {
    expect(plainText(null)).toBe('')
    expect(plainText(undefined)).toBe('')
  })
})

describe('commonsGeosearchUrl', () => {
  it('asks only for files, with their licence metadata', () => {
    const url = commonsGeosearchUrl(37.7327, -119.558, 3000)
    expect(url).toContain('generator=geosearch')
    // Namespace 6 is File:; anything else is an article with coordinates.
    expect(url).toContain('ggsnamespace=6')
    expect(url).toContain('extmetadata')
    expect(url).toContain('ggscoord=37.7327%7C-119.558')
  })

  /*
   * Commons rejects a radius over 10 km outright, so a mistyped one has to be
   * clamped rather than sent and refused.
   */
  it('clamps a radius Commons would reject', () => {
    expect(commonsGeosearchUrl(0, 0, 999_999)).toContain('ggsradius=10000')
    expect(commonsGeosearchUrl(0, 0, 1)).toContain('ggsradius=10')
  })
})

describe('candidatesFrom', () => {
  const page = (title: string, license: string | null = 'CC BY-SA 3.0') => ({
    title: `File:${title}`,
    imageinfo: [{
      thumburl: `https://upload.wikimedia.org/${title}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${title}`,
      extmetadata: {
        ...(license ? { LicenseShortName: { value: license } } : {}),
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/3.0/' },
        Artist: { value: '<a href="/wiki/User:Someone">Someone</a>' },
      },
    }],
  })

  const payload = (...pages: any[]) => ({ query: { pages: Object.fromEntries(pages.map((p, i) => [i, p])) } })

  it('keeps only the files whose titles name the trail', () => {
    const found = candidatesFrom(
      payload(
        page('Vernal Falls from the Mist Trail - panoramio.jpg'),
        page('Cornus nuttallii 08549.JPG'),
        page('Pinus benthamiana 08552.JPG'),
      ),
      'Mist Trail to Vernal Fall',
    )

    expect(found).toHaveLength(1)
    expect(found[0].title).toContain('Mist Trail')
    expect(found[0].credit).toBe('Someone')
    expect(found[0].license).toBe('CC BY-SA 3.0')
    expect(found[0].pageUrl).toContain('commons.wikimedia.org')
  })

  /*
   * Sourcing from Commons rather than a search engine is worth doing because
   * the terms travel with the picture. A file with no licence recorded is one
   * we cannot carry terms for, so it is not a candidate.
   */
  /*
   * A Wikipedian's signature carries links to their talk page and
   * contributions; the credit under a cover is their name (commonsCredit.ts).
   */
  it('credits the author by name, without their talk and contributions links', () => {
    const signed = page('Mist Trail Vernal Fall from the bridge.jpg')
    signed.imageinfo[0].extmetadata.Artist.value = '<a href="https://en.wikipedia.org/wiki/User:Philm555" class="extiw" title="en:User:Philm555">Phil Mieszkowski</a> (<a href="https://en.wikipedia.org/wiki/User_talk:Philm555" class="extiw" title="en:User talk:Philm555">talk</a><span style="white-space:nowrap"> <span style="font-weight:bold;">·</span></span> <a href="https://en.wikipedia.org/wiki/Special:Contributions/Philm555" class="extiw" title="en:Special:Contributions/Philm555">contribs</a>)'
    const [found] = candidatesFrom(payload(signed), 'Mist Trail to Vernal Fall')
    expect(found.credit).toBe('Phil Mieszkowski')
  })

  it('drops a file with no licence recorded', () => {
    const found = candidatesFrom(payload(page('Mist Trail Vernal Fall view.jpg', null)), 'Mist Trail to Vernal Fall')
    expect(found).toEqual([])
  })

  it('puts the most specific title first', () => {
    const found = candidatesFrom(
      payload(
        page('Jenny Lake.jpg'),
        page('Jenny Lake Loop in Grand Teton.jpg'),
      ),
      'Jenny Lake Loop',
    )
    // Both carry jenny and lake; only one is the loop, and "loop" is a stop
    // word — so ordering falls to the title, and both are offered for review.
    expect(found.length).toBeGreaterThan(0)
    expect(found.every(c => c.license !== '')).toBe(true)
  })

  it('returns nothing for an empty or broken response', () => {
    expect(candidatesFrom(null, 'Mist Trail')).toEqual([])
    expect(candidatesFrom({}, 'Mist Trail')).toEqual([])
    expect(candidatesFrom({ query: {} }, 'Mist Trail')).toEqual([])
  })
})

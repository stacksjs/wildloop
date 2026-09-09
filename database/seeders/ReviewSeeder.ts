import { Seeder } from '@stacksjs/database'
import Review from '../../app/Models/Review'
import User from '../../app/Models/User'
import { trailIdBySeedSourceId } from './TrailSeeder'
import { seededTrails } from '../support/trails'

/**
 * Trail reviews from the seeded athletes.
 *
 * This used to be `factory.generate(Review, { count: 100 })`, which stopped
 * working when `factory` was removed from @stacksjs/database — so every trail
 * page showed "no reviews yet", and the rating and review count on the explore
 * cards had nothing behind them.
 *
 * A hundred rows of `faker.lorem.paragraphs(2)` would not have been worth
 * much either. A review is the one piece of content on a trail page that is
 * read rather than counted, and a page of Lorem ipsum tells you nothing about
 * whether the page works — you cannot see truncation, a broken star rating, or
 * a sort by helpfulness in text that means nothing. These are written about
 * the trails they are attached to, by the athletes who ran them.
 *
 * Ratings are NOT written back onto the trail here. `trails.rating` and
 * `trails.review_count` are denormalized over this table, and CounterSeeder
 * recomputes both from these rows with the same function
 * `buddy counters:recompute` uses. A rating typed in beside a review is
 * exactly how the two drift apart.
 *
 * Idempotent on (user, trail), which is the table's own unique index — one
 * review per athlete per trail, upserted the way TrailReviewStoreAction does.
 */

type Condition = 'excellent' | 'good' | 'fair' | 'poor' | 'muddy' | 'icy'

interface SeedReview {
  /** `source_id` of the trail, as seeded by TrailSeeder. */
  trail: string
  /** Name of the seeded athlete who wrote it. */
  author: string
  rating: number
  title: string
  content: string
  conditions: Condition
  helpful: number
  /** Days before today the athlete was there. */
  daysAgo: number
}

const REVIEWS: SeedReview[] = [
  {
    trail: 'romo-emerald-lake',
    author: 'Kim Gottwald',
    rating: 5,
    title: 'Three lakes for very little climbing',
    content: 'Nymph, Dream and then Emerald, all inside a mile and a half of each other. The last pitch above Dream Lake is the only part that feels like work. Bear Lake lot is full by seven, take the shuttle.',
    conditions: 'excellent',
    helpful: 42,
    daysAgo: 9,
  },
  {
    trail: 'romo-emerald-lake',
    author: 'Mark Dowdle',
    rating: 4,
    title: 'Busy, and worth it anyway',
    content: 'You will not have it to yourself at any hour I have tried. The views do not care. Ice on the shaded switchbacks well into June, microspikes were not overkill.',
    conditions: 'icy',
    helpful: 18,
    daysAgo: 63,
  },
  {
    trail: 'romo-sky-pond',
    author: 'Kim Gottwald',
    rating: 5,
    title: 'The scramble is the point',
    content: 'Everything up to The Loch is a normal hike. The climb beside Timberline Falls is a genuine scramble on wet rock and it is where the crowd thins out. Sky Pond behind it is the best cirque in the park.',
    conditions: 'good',
    helpful: 76,
    daysAgo: 12,
  },
  {
    trail: 'whiteriver-maroon-lake',
    author: 'Chris Breuer',
    rating: 4,
    title: 'Short, flat, and the best view of the week',
    content: 'Barely a walk, but the Bells are straight down the lake and the light before eight is worth the reservation slot. Did a wider lap on the Scenic Loop after and had it almost to myself.',
    conditions: 'excellent',
    helpful: 31,
    daysAgo: 2,
  },
  {
    trail: 'whiteriver-maroon-lake',
    author: 'Kim Gottwald',
    rating: 5,
    title: 'Take the earliest bus',
    content: 'Flat enough to walk with anyone and paved most of the way round. Reserve the shuttle the day it opens; the road is closed to cars in season and the walk-up slots go fast.',
    conditions: 'good',
    helpful: 55,
    daysAgo: 3,
  },
  {
    trail: 'whiteriver-hanging-lake',
    author: 'Mark Dowdle',
    rating: 4,
    title: 'Steeper than the mileage suggests',
    content: 'A thousand feet in a mile and a bit, over loose boulder steps most of the way. The lake at the top is exactly as green as the photos. Permit is enforced and the shuttle is the only way up in summer.',
    conditions: 'good',
    helpful: 64,
    daysAgo: 40,
  },
  {
    trail: 'yose-mist-vernal',
    author: 'Chris Breuer',
    rating: 5,
    title: 'You will get soaked and you will not mind',
    content: 'Six hundred granite steps with the fall breaking over them. In May the spray is constant — waterproof the phone, not the jacket. Coming down is harder than going up on wet stone.',
    conditions: 'excellent',
    helpful: 121,
    daysAgo: 21,
  },
  {
    trail: 'yose-half-dome',
    author: 'Harvey Lewis',
    rating: 5,
    title: 'Long day, and the cables are the easy part',
    content: 'Fourteen miles with five thousand feet in it. Start in the dark. The subdome in full sun is what breaks people, not the cables. Gloves at the bottom of the cables, take a pair and leave them.',
    conditions: 'excellent',
    helpful: 208,
    daysAgo: 34,
  },
  {
    trail: 'osm-relation-2698343',
    author: 'Chris Breuer',
    rating: 5,
    title: 'The stairs, then everything else',
    content: 'Six hundred and seventy-one steps out of Mill Valley before the trail even starts. Then rolling coastal singletrack for six miles to the beach. Run it once and you understand why the race exists.',
    conditions: 'good',
    helpful: 89,
    daysAgo: 5,
  },
  {
    trail: 'osm-way-24417702',
    author: 'Chris Breuer',
    rating: 5,
    title: 'Best loop on the mountain',
    content: 'Open grassland and ocean on the Matt Davis side, then redwoods and a ladder beside the creek coming down Steep Ravine. Two completely different trails in one seven-mile lap.',
    conditions: 'good',
    helpful: 97,
    daysAgo: 1,
  },
  {
    trail: 'osm-way-24417702',
    author: 'Kim Gottwald',
    rating: 4,
    title: 'Slick in the ravine after rain',
    content: 'The ladder and the rock steps in Steep Ravine hold water for days. Went anti-clockwise so the descent was on the open side instead, much better call.',
    conditions: 'muddy',
    helpful: 23,
    daysAgo: 47,
  },
  {
    trail: 'goga-lands-end',
    author: 'Chris Breuer',
    rating: 4,
    title: 'A city walk that does not feel like one',
    content: 'Gravel path along the cliffs with the bridge in view for most of it. Flat enough to run easy. Go at low tide and you can pick out the shipwrecks off Mile Rock.',
    conditions: 'good',
    helpful: 37,
    daysAgo: 4,
  },
  {
    trail: 'mora-skyline-loop',
    author: 'Mark Dowdle',
    rating: 5,
    title: 'Rainier the whole way round',
    content: 'Up to Panorama Point and back down past Myrtle Falls. Snow across the upper traverse into July most years — the ranger board at Paradise is accurate, believe it.',
    conditions: 'good',
    helpful: 143,
    daysAgo: 3,
  },
  {
    trail: 'mora-skyline-loop',
    author: 'Kim Gottwald',
    rating: 3,
    title: 'Cloud in, saw nothing',
    content: 'No fault of the trail. Turned back at the traverse when visibility went and the snow got firm without spikes. Going back for it — everyone says the top half is the whole point.',
    conditions: 'poor',
    helpful: 11,
    daysAgo: 2,
  },
  {
    trail: 'osm-way-236152387',
    author: 'Mark Dowdle',
    rating: 4,
    title: 'Two miles up, one great view',
    content: 'Even switchbacks through second growth, no scrambling, then a ledge over the lake. Busy every weekend of the year. Fine on a wet day since it is all under trees.',
    conditions: 'good',
    helpful: 58,
    daysAgo: 71,
  },
  {
    trail: 'zion-angels-landing',
    author: 'Harvey Lewis',
    rating: 5,
    title: 'The chains are shorter than they look',
    content: 'Walter\'s Wiggles gets you most of the height. The chained section is half a mile and there are places to stand aside. If exposure is not for you, Scout Lookout is a fine turnaround.',
    conditions: 'excellent',
    helpful: 176,
    daysAgo: 55,
  },
  {
    trail: 'zion-angels-landing',
    author: 'Pawel Dregan',
    rating: 4,
    title: 'Get the permit or do not bother',
    content: 'Rangers check at the bottom of the chains. The lottery is quick to enter and the seasonal draw has better odds than the day-before. Hot by nine on the exposed switchbacks.',
    conditions: 'good',
    helpful: 44,
    daysAgo: 88,
  },
  {
    trail: 'arch-delicate-arch',
    author: 'Pawel Dregan',
    rating: 4,
    title: 'No shade, none at all',
    content: 'Slickrock the whole way with cairns for a route. Take twice the water you think. The last ledge round to the bowl is narrow but flat. Sunset is crowded and still worth it.',
    conditions: 'good',
    helpful: 92,
    daysAgo: 92,
  },
  {
    trail: 'brca-navajo-queens',
    author: 'Mark Dowdle',
    rating: 5,
    title: 'Do it counter-clockwise',
    content: 'Down Wall Street between the hoodoos and back up through Queen\'s Garden, so the steep switchbacks are the descent. Under three miles and the best short hike in the state.',
    conditions: 'good',
    helpful: 134,
    daysAgo: 2,
  },
  {
    trail: 'grca-bright-angel',
    author: 'Harvey Lewis',
    rating: 5,
    title: 'The way down lies to you',
    content: 'Easy going out and a real climb coming back. Three-Mile Resthouse is the right turnaround for a half day. Water at the resthouses is seasonal, check before you rely on it.',
    conditions: 'excellent',
    helpful: 187,
    daysAgo: 66,
  },
  {
    trail: 'crgnsa-multnomah-wahkeena',
    author: 'Kim Gottwald',
    rating: 5,
    title: 'Six waterfalls in five miles',
    content: 'Paved up to the Multnomah bridge and then proper trail. Wet the whole way round, which is the point. Parking at Multnomah needs a timed permit in summer; start at Wahkeena instead.',
    conditions: 'muddy',
    helpful: 73,
    daysAgo: 5,
  },
  {
    trail: 'grte-jenny-lake-loop',
    author: 'Harvey Lewis',
    rating: 5,
    title: 'Flat lap under the Cathedral Group',
    content: 'Seven miles with almost no climb, and the Tetons are directly above you for the western half. Add Hidden Falls and Inspiration Point from the boat dock if the legs are willing.',
    conditions: 'excellent',
    helpful: 68,
    daysAgo: 5,
  },
  {
    trail: 'acad-precipice',
    author: 'Pawel Dregan',
    rating: 5,
    title: 'A via ferrata pretending to be a hike',
    content: 'Iron rungs and open ledges straight up the east face. Two miles that take as long as six elsewhere. Closed in spring for the peregrines — check the park page before you drive out.',
    conditions: 'good',
    helpful: 112,
    daysAgo: 79,
  },
  {
    trail: 'osm-way-42104432',
    author: 'Chris Breuer',
    rating: 4,
    title: 'Train there, scramble, train back',
    content: 'Metro-North drops you at the trailhead, which makes this the easiest big day out of the city. Hands-on rock for the first mile. Go on a weekday, the queue on the scramble is real.',
    conditions: 'good',
    helpful: 81,
    daysAgo: 3,
  },
  {
    trail: 'grsm-alum-cave',
    author: 'Harvey Lewis',
    rating: 5,
    title: 'Every mile has something in it',
    content: 'Arch Rock, then the bluffs, then cable handrails on the ledges up to LeConte. Eleven miles that never feel repetitive. The lodge at the top does not serve day hikers, plan accordingly.',
    conditions: 'good',
    helpful: 158,
    daysAgo: 2,
  },
  {
    trail: 'grsm-at-clingmans-newfound',
    author: 'Harvey Lewis',
    rating: 4,
    title: 'Ridgeline the whole way',
    content: 'Sixteen miles along the crest with the highest point on the AT at one end. Almost entirely downhill going north from Clingmans. Shuttle from Newfound Gap or leave two cars.',
    conditions: 'good',
    helpful: 64,
    daysAgo: 3,
  },
  {
    trail: 'osm-way-27204418',
    author: 'Pawel Dregan',
    rating: 5,
    title: 'Galleries cut into the rock',
    content: 'The gorge itself is barely a kilometre and you will spend an hour in it. Come out at the top and take the forest road back round for a proper loop. Small entry fee at the mouth, cash.',
    conditions: 'good',
    helpful: 96,
    daysAgo: 2,
  },
  {
    trail: 'osm-way-25848873',
    author: 'Pawel Dregan',
    rating: 5,
    title: 'The wet way to the Zugspitze',
    content: 'Tunnels, spray and a lot of noise. The hut above the gorge is the natural turnaround unless you are going for the summit. Helmet is genuinely recommended for rockfall past the klamm.',
    conditions: 'good',
    helpful: 88,
    daysAgo: 1,
  },
  {
    trail: 'osm-way-38155610',
    author: 'Pawel Dregan',
    rating: 4,
    title: 'Green lake, big mountain behind it',
    content: 'Gravel road up to the alm, proper path from there. The cable car takes the climb out of it if you are short on time. Busy midday, quiet by five.',
    conditions: 'good',
    helpful: 39,
    daysAgo: 30,
  },
  {
    trail: 'osm-way-33218840',
    author: 'Pawel Dregan',
    rating: 5,
    title: 'High traverse, then back down to the water',
    content: 'The Panoramaweg keeps you well above the lake with the Blüemlisalp opposite the whole time. Comes back down to the shore at the end, which is the right way round.',
    conditions: 'excellent',
    helpful: 71,
    daysAgo: 4,
  },
  {
    trail: 'osm-way-33218840',
    author: 'Kim Gottwald',
    rating: 4,
    title: 'Gondola up, walk down',
    content: 'Did it the lazy way and still got the views. Path is wide and well graded; fine with kids on the lower half. Steep and loose on the direct descent, take the long way.',
    conditions: 'good',
    helpful: 26,
    daysAgo: 120,
  },
]

const DAY = 24 * 60 * 60 * 1000

export default class ReviewSeeder extends Seeder {
  // After TrailSeeder (-92) and UserSeeder (-100): a review needs both ends.
  static override order = -70

  async run(): Promise<void> {
    const users = (await User.all().catch(() => [])) as any[]
    // Only the trails these reviews name — see support/trails.
    const trails = await seededTrails(REVIEWS.map(review => review.trail))
    const byName = new Map(users.map(u => [u.name, u]))
    /**
     * Resolve a seeded trail reference to the row that represents it.
     *
     * TrailSeeder inserts a trail only when the catalog does not already have it;
     * on an environment where the national ingest has run, it adopts the ingested
     * row instead and records the id. So the source id declared in the seed data
     * is not always a key in the table, and looking only there silently left every
     * seeded activity, review and bookmark unlinked.
     */
    const bySourceId = new Map(trails.map(t => [t.source_id, t]))
    const byId = new Map(trails.map((t: any) => [t.id, t]))
    // The adoption map first: it is TrailSeeder's own answer about which row
    // represents this trail, and it is the only one that knows about a
    // superseded copy still sitting in the table under the same source id.
    const resolveTrail = (sourceId: string) =>
      byId.get(trailIdBySeedSourceId.get(sourceId) as number) ?? bySourceId.get(sourceId) ?? null


    if (!byName.size || !bySourceId.size) {
      console.warn('[seed] no users or trails yet; skipping reviews')
      return
    }

    const now = Date.now()

    for (const seed of REVIEWS) {
      const author = byName.get(seed.author)
      const trail = resolveTrail(seed.trail)
      if (!author || !trail) {
        console.warn(`[seed] review by ${seed.author} on ${seed.trail} has no author or trail; skipping`)
        continue
      }

      const payload = {
        user_id: author.id,
        trail_id: trail.id,
        rating: seed.rating,
        title: seed.title,
        content: seed.content,
        visit_date: new Date(now - seed.daysAgo * DAY).toISOString().split('T')[0],
        conditions: seed.conditions,
        helpful_count: seed.helpful,
        photos: null,
      }

      const existing = await Review
        .where('user_id', '=', author.id)
        .where('trail_id', '=', trail.id)
        .first()
        .catch(() => null)

      if (existing)
        await Review.forceUpdate(existing.id, payload)
      else
        await Review.forceCreate(payload)
    }
  }
}

/**
 * What a trail page says about a trail beyond its own fields: the breadcrumb
 * trail back to the catalog, the questions people ask about it, where to look
 * next, and summaries of its reviews and forecast.
 *
 * Every answer is built from what the catalog actually knows. A trail whose
 * source recorded no climb gets no "how much elevation" question, rather than
 * one answering "0 ft" — which reads as flat, and is a guess.
 */

export interface PageTrail {
  id: number
  name: string
  location?: string
  distance?: number
  elevation?: number
  difficulty?: string
  estimatedTime?: string
  routeType?: string
  rating?: number
  reviewCount?: number
  state?: string
  stateName?: string
  country?: string
  managedBy?: string
  dogsAllowed?: boolean | null
  wheelchairAccessible?: boolean | null
  lat?: number
  lng?: number
}

export interface Crumb {
  label: string
  href: string
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  DE: 'Germany',
  AT: 'Austria',
  CH: 'Switzerland',
}

export function countryLabel(code: string | undefined): string {
  const value = String(code ?? '').toUpperCase()
  return COUNTRY_NAMES[value] ?? value
}

const ROUTE_WORDS: Record<string, string> = {
  'loop': 'loop',
  'out-and-back': 'out-and-back',
  'point-to-point': 'point-to-point',
  'network': 'network of',
}

function stateQuery(trail: PageTrail): string {
  const params = new URLSearchParams()
  if (trail.country)
    params.set('country', trail.country)
  if (trail.state)
    params.set('state', trail.state)
  return params.toString()
}

/** Explore › United States › California › Santa Monica Mountains NRA. */
export function trailBreadcrumbs(trail: PageTrail): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Explore', href: '/trails' }]
  if (trail.country)
    crumbs.push({ label: countryLabel(trail.country), href: `/trails?country=${encodeURIComponent(trail.country)}` })
  if (trail.state)
    crumbs.push({ label: trail.stateName || trail.state, href: `/trails?${stateQuery(trail)}` })
  if (trail.managedBy)
    crumbs.push({ label: trail.managedBy, href: `/trails?q=${encodeURIComponent(trail.managedBy)}` })
  return crumbs
}

function miles(value: number | undefined): string {
  const number = Number(value) || 0
  return `${Number.isInteger(number) ? number : number.toFixed(1)} mi`
}

export interface FaqEntry {
  question: string
  answer: string
}

/** The questions people search for about a trail, answered from its facts. */
export function trailFaq(trail: PageTrail): FaqEntry[] {
  const name = trail.name
  const faq: FaqEntry[] = []
  const where = trail.managedBy || trail.location || ''

  if (Number(trail.distance) > 0) {
    const shape = ROUTE_WORDS[trail.routeType ?? '']
    const time = trail.estimatedTime ? ` Most people take about ${trail.estimatedTime} to complete it.` : ''
    faq.push({
      question: `How long is ${name}?`,
      answer: `${name} is ${miles(trail.distance)}${shape ? `, ${shape === 'network of' ? 'a network of trails' : `${/^[aeiou]/.test(shape) ? 'an' : 'a'} ${shape} route`}` : ''}.${time}`,
    })
  }

  if (trail.difficulty) {
    const climb = Number(trail.elevation) > 0 ? ` with ${Math.round(Number(trail.elevation)).toLocaleString('en-US')} ft of elevation gain` : ''
    faq.push({
      question: `How difficult is ${name}?`,
      answer: `It is rated ${trail.difficulty}${climb}. Difficulty comes from its length and climb, so check the route and conditions against your own experience.`,
    })
  }

  if (where) {
    faq.push({
      question: `Where is ${name}?`,
      answer: `${name} is in ${where}${trail.stateName && !where.includes(trail.stateName) ? `, ${trail.stateName}` : ''}. The route map shows the trailhead, and directions open in Apple or Google Maps.`,
    })
  }

  if (trail.dogsAllowed === true || trail.dogsAllowed === false) {
    faq.push({
      question: `Are dogs allowed on ${name}?`,
      answer: trail.dogsAllowed
        ? `Yes, the managing agency lists dogs as allowed. Rules often require a leash, so check signs at the trailhead.`
        : `No, the managing agency does not allow dogs on this trail.`,
    })
  }

  if (trail.wheelchairAccessible === true) {
    faq.push({
      question: `Is ${name} wheelchair accessible?`,
      answer: `Yes, the managing agency lists it as wheelchair accessible.`,
    })
  }

  if (Number(trail.rating) > 0 && Number(trail.reviewCount) > 0) {
    const count = Number(trail.reviewCount)
    faq.push({
      question: `What do people think of ${name}?`,
      answer: `It is rated ${Number(trail.rating).toFixed(1)} out of 5 across ${count.toLocaleString('en-US')} review${count === 1 ? '' : 's'} on Wildloop.`,
    })
  }

  return faq
}

export interface LinkGroup {
  title: string
  links: Crumb[]
}

/** "Explore near …": the catalog around this trail, in a few useful cuts. */
export function exploreNearLinks(trail: PageTrail): LinkGroup[] {
  const groups: LinkGroup[] = []
  const region = trail.stateName || trail.state
  const inRegion = trail.state ? stateQuery(trail) : ''

  if (inRegion) {
    groups.push({
      title: `In ${region}`,
      links: [
        { label: `All trails in ${region}`, href: `/trails?${inRegion}` },
        { label: `Easy trails in ${region}`, href: `/trails?${inRegion}&difficulty=easy` },
        { label: `Hard trails in ${region}`, href: `/trails?${inRegion}&difficulty=hard` },
        { label: `Loop trails in ${region}`, href: `/trails?${inRegion}&routeType=loop` },
        { label: `Dog-friendly trails in ${region}`, href: `/trails?${inRegion}&dogs=true` },
      ],
    })
  }

  const around: Crumb[] = []
  if (Number.isFinite(trail.lat) && Number.isFinite(trail.lng)) {
    const place = (trail.location || trail.name).split(',')[0].trim()
    around.push({ label: `Trails near ${place}`, href: `/trails?near=${encodeURIComponent(place)}&lat=${trail.lat}&lng=${trail.lng}` })
  }
  if (trail.managedBy)
    around.push({ label: `More in ${trail.managedBy}`, href: `/trails?q=${encodeURIComponent(trail.managedBy)}` })
  around.push({ label: 'Plan a route of your own', href: '/routes' })
  groups.push({ title: 'Nearby', links: around })

  return groups
}

export interface RatingSummary {
  average: number
  count: number
  bars: Array<{ stars: number, count: number, percent: number }>
}

/** The big number and the five bars above a trail's reviews. */
export function ratingSummary(reviews: Array<{ rating?: number }>): RatingSummary {
  const ratings = reviews
    .map(review => Math.round(Number(review.rating)))
    .filter(rating => rating >= 1 && rating <= 5)
  const count = ratings.length
  const average = count ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / count) * 10) / 10 : 0
  const bars = [5, 4, 3, 2, 1].map((stars) => {
    const matching = ratings.filter(rating => rating === stars).length
    return { stars, count: matching, percent: count ? Math.round((matching / count) * 100) : 0 }
  })
  return { average, count, bars }
}

/** "Today", then weekday names — the way a forecast is read. */
export function forecastDayLabel(date: string, index: number): string {
  if (index === 0)
    return 'Today'
  const parsed = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
}

/**
 * Where a day's low-to-high bar sits on the week's temperature scale, in
 * percent, so a cold day and a hot one read at a glance.
 */
export function forecastBar(day: { low: number, high: number }, weekLow: number, weekHigh: number): { left: number, width: number } {
  const span = Math.max(1, weekHigh - weekLow)
  const left = Math.max(0, Math.min(100, ((day.low - weekLow) / span) * 100))
  const width = Math.max(4, Math.min(100 - left, ((day.high - day.low) / span) * 100))
  return { left: Math.round(left), width: Math.round(width) }
}

import { describe, expect, it } from 'bun:test'
import {
  groupNotificationsByDay,
  matchesNotificationFilter,
  NOTIFICATION_FILTERS,
  notificationRowsFrom,
  timeAgo,
} from '../../resources/functions/notifications'

/**
 * The notification list, as both screens compute it.
 *
 * Extracted from `useNotifications`, the notifications page and the `wl` store
 * when the native screen became the second consumer. Three screens describing
 * the same instant three ways is the failure this prevents.
 */

const NOW = Date.parse('2026-10-13T12:00:00.000Z')

describe('notificationRowsFrom', () => {
  it('maps the API shape to the row both screens render', () => {
    const [row] = notificationRowsFrom({
      notifications: [{
        id: 9,
        type: 'kudos',
        actorName: 'Kim Gottwald',
        body: 'gave you kudos',
        link: '/activity/4',
        read: false,
        createdAt: '2026-10-13T11:00:00.000Z',
      }],
    })

    expect(row).toEqual({
      id: 9,
      type: 'kudos',
      title: 'Kim Gottwald',
      message: 'gave you kudos',
      link: '/activity/4',
      read: false,
      created_at: '2026-10-13T11:00:00.000Z',
    })
  })

  /*
   * A notification with no actor is one Wildloop sent, and the fallback is the
   * product rather than an empty line where a name goes.
   */
  it('attributes an actorless notification to Wildloop', () => {
    const [row] = notificationRowsFrom({ notifications: [{ id: 1, type: 'system', body: 'Welcome' }] })

    expect(row.title).toBe('Wildloop')
    expect(row.link).toBe('#')
    expect(row.read).toBe(false)
  })

  it('returns nothing for a payload that is not a list', () => {
    expect(notificationRowsFrom(null)).toEqual([])
    expect(notificationRowsFrom({})).toEqual([])
    expect(notificationRowsFrom({ notifications: 'soon' })).toEqual([])
  })
})

describe('matchesNotificationFilter', () => {
  const kudos = { type: 'kudos', read: true }
  const attack = { type: 'conquest_attack', read: false }

  it('passes everything under all, and only unread under unread', () => {
    expect(matchesNotificationFilter(kudos, 'all')).toBe(true)
    expect(matchesNotificationFilter(kudos, 'unread')).toBe(false)
    expect(matchesNotificationFilter(attack, 'unread')).toBe(true)
  })

  /*
   * Conquest is a prefix, not a type: the attack, the defence and the win are
   * three types and one thing somebody is looking for.
   */
  it('treats conquest as the family it is', () => {
    for (const type of ['conquest_attack', 'conquest_defend', 'conquest_win'])
      expect(matchesNotificationFilter({ type, read: false }, 'conquest'), type).toBe(true)
    expect(matchesNotificationFilter(kudos, 'conquest')).toBe(false)
  })

  it('matches the remaining chips by exact type', () => {
    expect(matchesNotificationFilter({ type: 'challenge', read: false }, 'challenge')).toBe(true)
    expect(matchesNotificationFilter(kudos, 'challenge')).toBe(false)
  })

  it('has a rule for every chip the screens offer', () => {
    for (const { key } of NOTIFICATION_FILTERS)
      expect(typeof matchesNotificationFilter({ type: 'kudos', read: false }, key), key).toBe('boolean')
  })
})

describe('groupNotificationsByDay', () => {
  const at = (iso: string) => ({ created_at: iso })

  it('splits today, yesterday and earlier, and drops empty headings', () => {
    const groups = groupNotificationsByDay([
      at('2026-10-13T11:00:00.000Z'),
      at('2026-10-12T11:00:00.000Z'),
      at('2026-09-30T11:00:00.000Z'),
    ], NOW)

    expect(groups.map(group => group.label)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(groups.every(group => group.items.length === 1)).toBe(true)
  })

  it('returns no headings at all for an empty list', () => {
    expect(groupNotificationsByDay([], NOW)).toEqual([])
  })

  /*
   * An unreadable date lands under Earlier rather than Today: a row with no
   * usable timestamp is old news, and putting it at the top would claim
   * something the data does not say.
   */
  it('files an unreadable timestamp under Earlier', () => {
    const groups = groupNotificationsByDay([at('not a date')], NOW)

    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Earlier')
  })
})

describe('timeAgo', () => {
  it('reads in the units somebody would say out loud', () => {
    expect(timeAgo('2026-10-13T11:59:30.000Z', NOW)).toBe('just now')
    expect(timeAgo('2026-10-13T11:45:00.000Z', NOW)).toBe('15m ago')
    expect(timeAgo('2026-10-13T08:00:00.000Z', NOW)).toBe('4h ago')
    expect(timeAgo('2026-10-10T12:00:00.000Z', NOW)).toBe('3d ago')
    expect(timeAgo('2026-09-20T12:00:00.000Z', NOW)).toBe('3w ago')
  })

  it('says nothing when there is nothing to say', () => {
    expect(timeAgo('', NOW)).toBe('')
    expect(timeAgo('not a date', NOW)).toBe('')
  })
})

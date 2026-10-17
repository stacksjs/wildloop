/** Shared destinations for the native Menu and the website's phone menu. */
export const MOBILE_MENU_GROUPS = [
  { title: 'Explore', items: [
    { label: 'Trails', href: '/trails', symbol: 'map' },
    { label: 'Plans', href: '/plans', symbol: 'calendar' },
    { label: 'Draw a route', href: '/routes', symbol: 'point.topleft.down.to.point.bottomright.curvepath' },
    { label: 'Saved trails', href: '/trails?list=saved', symbol: 'heart' },
    { label: 'Completed trails', href: '/trails?list=completed', symbol: 'checkmark.circle' },
  ] },
  { title: 'You', items: [
    { label: 'Your profile', href: '/profile', symbol: 'person.crop.circle' },
    { label: 'Achievements', href: '/achievements', symbol: 'trophy' },
    { label: 'Stats', href: '/stats', symbol: 'chart.bar' },
    { label: 'Settings', href: '/settings', symbol: 'gearshape' },
  ] },
  { title: 'Compete', items: [
    { label: 'Territory', href: '/territories', symbol: 'flag' },
    { label: 'Leaderboard', href: '/leaderboard', symbol: 'crown' },
    { label: 'Battles', href: '/battles', symbol: 'bolt' },
    { label: 'Conquests', href: '/conquests', symbol: 'scope' },
    { label: 'Challenges', href: '/challenges', symbol: 'medal' },
    { label: 'Records', href: '/records', symbol: 'timer' },
  ] },
  { title: 'People', items: [
    { label: 'Find athletes', href: '/athletes', symbol: 'person.2' },
    { label: 'Clubs', href: '/clubs', symbol: 'person.3' },
    { label: 'Events', href: '/events', symbol: 'calendar' },
  ] },
] as const

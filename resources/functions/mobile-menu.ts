/** Shared destinations for the native Menu and the website's phone menu. */
export const MOBILE_MENU_GROUPS = [
  { title: 'Explore', items: [
    { label: 'Trails', href: '/trails', icon: 'i-lucide-map', symbol: 'map' },
    { label: 'Plans', href: '/plans', icon: 'i-lucide-calendar-days', symbol: 'calendar' },
    { label: 'Draw a route', href: '/routes', icon: 'i-lucide-route', symbol: 'point.topleft.down.to.point.bottomright.curvepath' },
    { label: 'Saved trails', href: '/trails?list=saved', icon: 'i-lucide-heart', symbol: 'heart' },
    { label: 'Completed trails', href: '/trails?list=completed', icon: 'i-lucide-circle-check', symbol: 'checkmark.circle' },
  ] },
  { title: 'You', items: [
    { label: 'Your profile', href: '/profile', icon: 'i-lucide-user-round', symbol: 'person.crop.circle' },
    { label: 'Achievements', href: '/achievements', icon: 'i-lucide-trophy', symbol: 'trophy' },
    { label: 'Stats', href: '/stats', icon: 'i-lucide-chart-column', symbol: 'chart.bar' },
    { label: 'Notifications', href: '/notifications', icon: 'i-lucide-bell', symbol: 'bell' },
    { label: 'Settings', href: '/settings', icon: 'i-lucide-settings', symbol: 'gearshape' },
  ] },
  { title: 'Compete', items: [
    { label: 'Territory', href: '/territories', icon: 'i-lucide-flag', symbol: 'flag' },
    { label: 'Leaderboard', href: '/leaderboard', icon: 'i-lucide-crown', symbol: 'crown' },
    { label: 'Battles', href: '/battles', icon: 'i-lucide-swords', symbol: 'bolt' },
    { label: 'Conquests', href: '/conquests', icon: 'i-lucide-target', symbol: 'scope' },
    { label: 'Challenges', href: '/challenges', icon: 'i-lucide-medal', symbol: 'medal' },
    { label: 'Records', href: '/records', icon: 'i-lucide-timer', symbol: 'timer' },
  ] },
  { title: 'People', items: [
    { label: 'Find athletes', href: '/athletes', icon: 'i-lucide-user-search', symbol: 'person.2' },
    { label: 'Clubs', href: '/clubs', icon: 'i-lucide-users', symbol: 'person.3' },
    { label: 'Events', href: '/events', icon: 'i-lucide-calendar-days', symbol: 'calendar' },
  ] },
] as const

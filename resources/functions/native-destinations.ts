import { appShortcutRoute } from './app-shortcuts'

/** App events carry destinations, never permission to open an arbitrary host. */
export function nativeDestination(value: unknown): string | null {
  if (typeof value !== 'string' || /[\\\s\u0000-\u001f]/.test(value)) return null
  const path=value.replace(/^https:\/\/wildloop\.org(?=\/|$)/i,'').replace(/^wildloop:\/\//i,'/')
  if (!path.startsWith('/') || path.startsWith('//')) return null
  try {
    const decoded=decodeURIComponent(path.split(/[?#]/)[0])
    if (decoded.includes('\\') || decoded.startsWith('//') || decoded.split('/').some(part=>part==='.' || part==='..')) return null
    return path
  } catch {return null}
}

export function nativeShortcutDestination(value: unknown): string | null {
  if (!value || typeof value!=='object')return null
  const detail=value as {type?:unknown,action?:unknown,url?:unknown,userInfo?:{url?:unknown}}
  for(const id of [detail.type,detail.action]) {
    const route=typeof id==='string' ? appShortcutRoute(id) : null
    if(route)return route
  }
  return nativeDestination(detail.url ?? detail.userInfo?.url)
}

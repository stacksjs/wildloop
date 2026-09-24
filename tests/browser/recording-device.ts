/** Test-only hardware/network fault controls. Served only by the loopback QA proxy. */
import { apiFetch } from '../../resources/assets/scripts/auth'

const callbacks = new Map<number, PositionCallback>()
let nextWatch = 0
let step = 0
let uploadsFail = false
let queueFails = false
let locationDenied = false
const fix = (): GeolocationPosition => ({
  timestamp: Date.now(),
  coords: {
    latitude: 34.01 + step * 0.00001,
    longitude: -118.49,
    accuracy: 5,
    altitude: 10,
    altitudeAccuracy: 5,
    heading: 0,
    speed: 1,
    toJSON() { return { latitude: this.latitude, longitude: this.longitude } },
  },
  toJSON() { return { timestamp: this.timestamp, coords: this.coords } },
})

Object.defineProperty(navigator, 'geolocation', {
  configurable: true,
  value: {
    getCurrentPosition(callback: PositionCallback, error?: PositionErrorCallback) {
      setTimeout(() => {
        if (locationDenied)
          error?.({ code: 1, message: 'QA: permission denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
        else callback(fix())
      }, 0)
    },
    watchPosition(callback: PositionCallback) { callbacks.set(++nextWatch, callback); return nextWatch },
    clearWatch(id: number) { callbacks.delete(id) },
  },
})

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input, init) => {
  const pathname = new URL(input instanceof Request ? input.url : String(input), location.href).pathname
  if (uploadsFail && pathname === '/api/activities' && init?.method === 'POST')
    return Promise.reject(new TypeError('QA: offline activity upload'))
  const response = await originalFetch(input, init)
  if (pathname === '/api/activities' && init?.method === 'POST' && !response.ok) {
    const error = await response.clone().json().catch(() => ({})) as { fields?: unknown }
    panel.querySelector('output')!.textContent = `Upload HTTP ${response.status}: ${JSON.stringify(error.fields ?? {})}`
  }
  return response
}) as typeof fetch
const originalPut = IDBObjectStore.prototype.put
IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
  const request = originalPut.apply(this, args)
  if (queueFails && this.name === 'run-uploads')
    request.addEventListener('success', () => this.transaction.abort())
  return request
}

const panel = document.createElement('fieldset')
panel.setAttribute('aria-label', 'Local recording QA controls')
panel.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:#fff;color:#111;padding:6px;font:12px system-ui;max-width:390px'
panel.innerHTML = '<legend>LOCAL QA: synthetic GPS only</legend><button type="button">Advance GPS</button><label><input type="checkbox" name="offline"> Fail uploads</label><label><input type="checkbox" name="storage"> Fail queue</label><output>0 GPS fixes</output>'
panel.querySelector('button')!.addEventListener('click', () => {
  step++
  for (const callback of callbacks.values()) callback(fix())
  panel.querySelector('output')!.textContent = `${step} GPS fixes; ${callbacks.size} watchers`
})
panel.querySelector('[name=offline]')!.addEventListener('change', (event) => { uploadsFail = (event.target as HTMLInputElement).checked })
panel.querySelector('[name=storage]')!.addEventListener('change', (event) => { queueFails = (event.target as HTMLInputElement).checked })
document.body.append(panel)
const permission = document.createElement('label')
permission.innerHTML = '<input type="checkbox"> Deny location'
permission.addEventListener('change', event => { locationDenied = (event.target as HTMLInputElement).checked })
panel.append(permission)
const expire = document.createElement('button')
expire.type = 'button'
expire.textContent = 'Expire session'
expire.addEventListener('click', () => {
  void apiFetch('/api/me', { headers: { Authorization: 'Bearer qa-expired-session' } })
})
panel.append(expire)

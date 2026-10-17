/** Parse only the fixed callback owned by Wildloop, without browser URL globals. */
export function nativeOAuthCallback(url: unknown): {code:string,state:string,error:string} | null {
  if (typeof url !== 'string' || !/^wildloop:\/\/settings\?/i.test(url) || url.length > 10000) return null
  const values: Record<string,string> = {}
  try {
    for (const pair of url.split('?')[1].split('#')[0].split('&')) {
      const separator=pair.indexOf('=')
      const key=decodeURIComponent(separator<0 ? pair : pair.slice(0,separator))
      const value=decodeURIComponent(separator<0 ? '' : pair.slice(separator+1).replace(/\+/g,' '))
      if (Object.hasOwn(values,key)) return null
      values[key]=value
    }
    return {code:values.code ?? '',state:values.state ?? '',error:values.error ?? ''}
  }
  catch { return null }
}

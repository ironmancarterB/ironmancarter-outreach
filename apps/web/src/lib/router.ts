import { useEffect, useState } from 'react'

// Tiny hash router: "#/prospects/12" → { page: 'prospects', parts: ['12'] }.
export function parseHash(hash = window.location.hash) {
  const [page = 'overview', ...parts] = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return { page, parts }
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const navigate = (path: string) => { window.location.hash = path }

// robots.txt parsing and matching (RFC 9309): the group for our user agent, or "*", decides;
// the longest matching Allow/Disallow rule wins and Allow wins ties. Supports * and $ wildcards.
export interface RobotsRules {
  allow: string[]
  disallow: string[]
}

export function parseRobots(text: string, agentToken: string): RobotsRules {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = []
  let current: (typeof groups)[number] | null = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current) continue
    if (key === 'allow' && value) current.allow.push(value)
    if (key === 'disallow' && value) current.disallow.push(value)
  }
  const token = agentToken.toLowerCase()
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)))
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'))
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) }
}

function ruleRegex(rule: string) {
  const anchored = rule.endsWith('$')
  const body = (anchored ? rule.slice(0, -1) : rule).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`)
}

export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null
  const consider = (rule: string, allow: boolean) => {
    if (!ruleRegex(rule).test(pathAndQuery)) return
    if (!best || rule.length > best.len || (rule.length === best.len && allow)) best = { len: rule.length, allow }
  }
  rules.allow.forEach((r) => consider(r, true))
  rules.disallow.forEach((r) => consider(r, false))
  return best ? (best as { allow: boolean }).allow : true
}

export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [] }
export const DISALLOW_ALL: RobotsRules = { allow: [], disallow: ['/'] }

#!/bin/zsh
# Started by the macOS login agent (com.ironmancarter.outreach): runs the outreach app (API, dashboard, worker)
# exactly like `npm run dev`. launchd restarts it if it exits. Logs go to data/app.log.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "/Users/cartercoates/Projects/Email outreach for brands" || exit 1
exec npm run dev

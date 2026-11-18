// UGC campaign defaults: categories, the starter candidate list and settings.
// Candidates are only places to look. Research fetches each official site and records what it finds;
// nothing here is evidence, and no contact details are included. A domain already in the sponsorship
// pool or CRM is skipped, so a company is only ever in one campaign.

export const UGC_CATEGORIES = [
  { slug: 'ugc-ai-tools', name: 'UGC · AI tools', description: 'AI assistants, AI video, voice, writing and image tools that need product demos.' },
  { slug: 'ugc-saas', name: 'UGC · SaaS products', description: 'Business and creator SaaS where a walkthrough video shows the product better than a landing page.' },
  { slug: 'ugc-consumer-apps', name: 'UGC · Consumer apps', description: 'Mobile and desktop consumer apps that buy app-install and social ads.' },
  { slug: 'ugc-gaming', name: 'UGC · Gaming companies', description: 'Game studios, publishers, game stores and gaming services that run creator-style ads.' },
  { slug: 'ugc-creator-tools', name: 'UGC · Creator tools', description: 'Video, audio, scheduling and monetization tools for creators.' },
  { slug: 'ugc-tech-products', name: 'UGC · Technology products', description: 'Consumer tech, accessories and gadgets that suit unboxing and first-use videos.' },
  { slug: 'ugc-productivity', name: 'UGC · Productivity software', description: 'Task, notes, calendar, email and focus software.' },
  { slug: 'ugc-agencies', name: 'UGC · Marketing and creative agencies', description: 'Influencer, UGC, growth and creative agencies that hire creators for client work.' },
]

export const UGC_SEEDS: Record<string, [name: string, website: string][]> = {
  'ugc-ai-tools': [
    ['Copy.ai', 'https://www.copy.ai'], ['Writer', 'https://writer.com'], ['Otter.ai', 'https://otter.ai'], ['Fireflies.ai', 'https://fireflies.ai'],
    ['Beautiful.ai', 'https://www.beautiful.ai'], ['Fathom', 'https://fathom.video'], ['LOVO', 'https://lovo.ai'], ['PlayHT', 'https://play.ht'],
    ['invideo', 'https://invideo.io'], ['Pictory', 'https://pictory.ai'], ['Colossyan', 'https://www.colossyan.com'], ['D-ID', 'https://www.d-id.com'],
    ['Kapwing', 'https://www.kapwing.com'], ['Wordtune', 'https://www.wordtune.com'], ['QuillBot', 'https://quillbot.com'], ['Photoroom', 'https://www.photoroom.com'],
    ['Looka', 'https://looka.com'], ['Durable', 'https://durable.co'], ['Taskade', 'https://www.taskade.com'], ['Tactiq', 'https://tactiq.io'],
    ['Lovable', 'https://lovable.dev'], ['Replit', 'https://replit.com'], ['Poe', 'https://poe.com'], ['You.com', 'https://you.com'],
  ],
  'ugc-saas': [
    ['Loom', 'https://www.loom.com'], ['Calendly', 'https://calendly.com'], ['Zapier', 'https://zapier.com'], ['Airtable', 'https://www.airtable.com'],
    ['Miro', 'https://miro.com'], ['Webflow', 'https://webflow.com'], ['Framer', 'https://www.framer.com'], ['Typeform', 'https://www.typeform.com'],
    ['Jotform', 'https://www.jotform.com'], ['Pipedrive', 'https://www.pipedrive.com'], ['Hootsuite', 'https://www.hootsuite.com'], ['Buffer', 'https://buffer.com'],
    ['Later', 'https://later.com'], ['Semrush', 'https://www.semrush.com'], ['Ahrefs', 'https://ahrefs.com'], ['FreshBooks', 'https://www.freshbooks.com'],
    ['Kit', 'https://kit.com'], ['beehiiv', 'https://www.beehiiv.com'], ['Gumroad', 'https://gumroad.com'], ['Stan', 'https://stan.store'],
    ['Carrd', 'https://carrd.co'], ['Mailchimp', 'https://mailchimp.com'],
  ],
  'ugc-consumer-apps': [
    ['Duolingo', 'https://www.duolingo.com'], ['Headspace', 'https://www.headspace.com'], ['Calm', 'https://www.calm.com'], ['Strava', 'https://www.strava.com'],
    ['Picsart', 'https://picsart.com'], ['VSCO', 'https://www.vsco.co'], ['Lightricks', 'https://www.lightricks.com'], ['Splice', 'https://splice.com'],
    ['Fitbod', 'https://fitbod.me'], ['Fabulous', 'https://www.thefabulous.co'], ['Opal', 'https://www.opal.so'], ['Forest', 'https://www.forestapp.cc'],
    ['Structured', 'https://structured.app'], ['Tiimo', 'https://www.tiimoapp.com'], ['Speak', 'https://www.speak.com'], ['Busuu', 'https://www.busuu.com'],
    ['Goodnotes', 'https://www.goodnotes.com'], ['Day One', 'https://dayoneapp.com'], ['Bear', 'https://bear.app'], ['Meetup', 'https://www.meetup.com'],
  ],
  'ugc-gaming': [
    ['Scopely', 'https://scopely.com'], ['Playtika', 'https://www.playtika.com'], ['Zynga', 'https://www.zynga.com'], ['Moon Active', 'https://www.moonactive.com'],
    ['Voodoo', 'https://voodoo.io'], ['Kabam', 'https://kabam.com'], ['Jam City', 'https://www.jamcity.com'], ['Big Fish Games', 'https://www.bigfishgames.com'],
    ['Rovio', 'https://www.rovio.com'], ['Miniclip', 'https://www.miniclip.com'], ['Lilith Games', 'https://www.lilithgames.com'], ['FunPlus', 'https://funplus.com'],
    ['Gameloft', 'https://www.gameloft.com'], ['Devolver Digital', 'https://www.devolverdigital.com'], ['Humble Bundle', 'https://www.humblebundle.com'],
    ['GOG', 'https://www.gog.com'], ['Fanatical', 'https://www.fanatical.com'], ['Green Man Gaming', 'https://www.greenmangaming.com'],
    ['Kongregate', 'https://www.kongregate.com'], ['Boosteroid', 'https://boosteroid.com'], ['Shadow', 'https://shadow.tech'],
  ],
  'ugc-creator-tools': [
    ['Frame.io', 'https://frame.io'], ['Wistia', 'https://wistia.com'], ['Vimeo', 'https://vimeo.com'], ['Vidyard', 'https://www.vidyard.com'],
    ['Screen Studio', 'https://screen.studio'], ['Tella', 'https://www.tella.tv'], ['TechSmith', 'https://www.techsmith.com'], ['Motion Array', 'https://motionarray.com'],
    ['Soundstripe', 'https://www.soundstripe.com'], ['Pond5', 'https://www.pond5.com'], ['Metricool', 'https://metricool.com'], ['Planoly', 'https://www.planoly.com'],
    ['Podia', 'https://www.podia.com'], ['Teachable', 'https://teachable.com'], ['Thinkific', 'https://www.thinkific.com'], ['Circle', 'https://circle.so'],
    ['Passionfroot', 'https://www.passionfroot.me'], ['Pallyy', 'https://pallyy.com'], ['Typefully', 'https://typefully.com'], ['Hypefury', 'https://hypefury.com'],
  ],
  'ugc-tech-products': [
    ['Insta360', 'https://www.insta360.com'], ['DJI', 'https://www.dji.com'], ['GoPro', 'https://gopro.com'], ['Belkin', 'https://www.belkin.com'],
    ['Nothing', 'https://nothing.tech'], ['Sonos', 'https://www.sonos.com'], ['Ultrahuman', 'https://www.ultrahuman.com'], ['Oura', 'https://ouraring.com'],
    ['WHOOP', 'https://www.whoop.com'], ['Ember', 'https://ember.com'], ['Satechi', 'https://satechi.net'], ['Nomad', 'https://nomadgoods.com'],
    ['Peak Design', 'https://www.peakdesign.com'], ['Twelve South', 'https://www.twelvesouth.com'], ['Elevation Lab', 'https://elevationlab.com'],
    ['reMarkable', 'https://remarkable.com'], ['Hollyland', 'https://www.hollyland.com'], ['Sennheiser', 'https://www.sennheiser.com'],
  ],
  'ugc-productivity': [
    ['Superhuman', 'https://superhuman.com'], ['Linear', 'https://linear.app'], ['Craft', 'https://www.craft.do'], ['Obsidian', 'https://obsidian.md'],
    ['Evernote', 'https://evernote.com'], ['TickTick', 'https://ticktick.com'], ['Sunsama', 'https://www.sunsama.com'], ['Akiflow', 'https://akiflow.com'],
    ['Raycast', 'https://www.raycast.com'], ['1Password', 'https://1password.com'], ['Bitwarden', 'https://bitwarden.com'], ['Readwise', 'https://readwise.io'],
    ['Spark', 'https://sparkmailapp.com'], ['Cal.com', 'https://cal.com'], ['Doodle', 'https://doodle.com'], ['Clockify', 'https://clockify.me'],
    ['Toggl', 'https://toggl.com'], ['RescueTime', 'https://www.rescuetime.com'], ['Freedom', 'https://freedom.to'], ['Motion', 'https://www.usemotion.com'],
    ['Reclaim.ai', 'https://reclaim.ai'],
  ],
  'ugc-agencies': [
    ['Insense', 'https://insense.pro'], ['Social Native', 'https://www.socialnative.com'], ['#paid', 'https://hashtagpaid.com'], ['Aspire', 'https://www.aspire.io'],
    ['Viral Nation', 'https://www.viralnation.com'], ['Open Influence', 'https://openinfluence.com'], ['The Influencer Marketing Factory', 'https://theinfluencermarketingfactory.com'],
    ['Obviously', 'https://www.obvious.ly'], ['Whalar', 'https://www.whalar.com'], ['Lemonlight', 'https://www.lemonlight.com'], ['NoGood', 'https://nogood.io'],
    ['Single Grain', 'https://www.singlegrain.com'], ['Power Digital', 'https://powerdigitalmarketing.com'], ['Disruptive Advertising', 'https://disruptiveadvertising.com'],
    ['Common Thread Collective', 'https://commonthreadco.com'], ['Movers+Shakers', 'https://www.moversshakers.co'], ['Freaks 4U Gaming', 'https://www.freaks4u.com'],
  ],
}

// Starting prices are quoting guidelines only. The app never quotes them by itself and never quotes the lowest
// one automatically; you choose what goes into a proposal.
export const UGC_DEFAULT_SETTINGS: Record<string, unknown> = {
  // Your live UGC portfolio page (/ugc on your creator website). Links go into emails only after a check confirms it is live.
  'ugc.portfolioUrl': '',
  'ugc.portfolioCheck': { url: null, ok: false, status: null, detail: null, checkedAt: null },
  // Research volume is separate from sending volume: these never raise any sending limit.
  'ugc.research': { dailyTarget: 25, autoDaily: true, minScore: 50, autoDraft: true },
  'ugc.followUps': { firstAfterBusinessDays: 5, secondAfterBusinessDays: 11, max: 2 },
  'ugc.pricing': { oneVideoUsd: 250, threeVideosUsd: 650, fiveVideosUsd: 1000, monthlyFourFromUsd: 900 },
  'ugc.costs': { dailyAlertUsd: 1 },
  // What the daily UGC run did last (written by the worker).
  'ugc.lastDaily': null,
}

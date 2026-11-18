// Default UGC email templates (data only, so the database seed can use it without import cycles).
export type TemplateKind = 'initial' | 'follow_up_1' | 'follow_up_2' | 'reply' | 'proposal'

const INTRO = "I'm Carter, a short-form creator in gaming and tech. I make UGC-style videos: on-camera product walkthroughs, software demos and ad-ready edits that a brand can run on its own channels and in paid social."

export interface TemplateDefault { slug: string; kind: TemplateKind; name: string; subject: string | null; body: string; sort_order: number }

export const DEFAULT_TEMPLATES: TemplateDefault[] = [
  {
    slug: 'ugc_initial', kind: 'initial', name: 'Initial UGC pitch', sort_order: 1,
    subject: 'Video ideas for {{company}}',
    body: `{{greeting}}

${INTRO}

{{brand_line}}

A couple of ideas I'd make for {{company}}:
{{concepts}}

I script, film and edit everything myself, so you get finished, captioned videos ready to post. {{portfolio_line}}

Would you be open to trying a test video?`,
  },
  {
    slug: 'ugc_saas_demo', kind: 'initial', name: 'SaaS product demo pitch', sort_order: 2,
    subject: 'Product demo videos for {{company}}',
    body: `{{greeting}}

I'm Carter, a short-form creator in gaming and tech. I make UGC-style software demos: on-camera walkthroughs that show a real task from start to finish, edited for TikTok, Reels, Shorts and paid social.

{{brand_line}}

Two demo ideas for {{company}}:
{{concepts}}

I handle the script, screen recording, on-camera parts and the edit. {{portfolio_line}}

Would a test video be worth a try?`,
  },
  {
    slug: 'ugc_gaming', kind: 'initial', name: 'Gaming UGC pitch', sort_order: 3,
    subject: 'Creator-style video ideas for {{company}}',
    body: `{{greeting}}

I'm Carter, a gaming and tech creator. Besides my own channel, I make UGC-style videos that brands run as their own content and ads: gameplay-led hooks, on-camera reactions and quick, captioned edits.

{{brand_line}}

Two ideas for {{company}}:
{{concepts}}

I know how players talk about games, so the videos sound like a player, not an ad read. {{portfolio_line}}

Would you be open to a test video?`,
  },
  {
    slug: 'ugc_ai_software', kind: 'initial', name: 'AI software pitch', sort_order: 4,
    subject: 'Showing {{company}} in action',
    body: `{{greeting}}

I'm Carter, a short-form creator in gaming and tech. I make UGC-style videos for AI and software products: the real prompt, the real result and an honest reaction on camera, edited for short-form and paid social.

{{brand_line}}

Two ideas for {{company}}:
{{concepts}}

I script, record and edit everything myself. {{portfolio_line}}

Would you like to try one test video?`,
  },
  {
    slug: 'ugc_agency', kind: 'initial', name: 'Agency introduction', sort_order: 5,
    subject: 'UGC creator for your gaming and tech clients',
    body: `{{greeting}}

I'm Carter, a short-form creator in gaming and tech. I make UGC-style videos (product walkthroughs, software demos and ad-ready edits) and I'm looking to work with agencies that run creator content for their clients.

{{brand_line}}

For gaming, AI, software or tech briefs, I can turn around:
{{concepts}}

I script, film and edit everything myself. {{portfolio_line}}

If you keep a creator roster, I'd love to be considered for upcoming briefs.`,
  },
  {
    slug: 'ugc_follow_up_1', kind: 'follow_up_1', name: 'First follow-up', sort_order: 6,
    subject: null,
    body: `{{greeting}}

Following up on my note from {{original_date}} about UGC videos for {{company}}. If it helps, I'm happy to start with a single test video around the "{{concept_short}}" idea, so you can see how it does before committing to more.

{{portfolio_line}}`,
  },
  {
    slug: 'ugc_follow_up_2', kind: 'follow_up_2', name: 'Final follow-up', sort_order: 7,
    subject: null,
    body: `{{greeting}}

One last check-in on my note from {{original_date}}. If creator videos aren't a focus for {{company}} right now, no problem at all, and I won't follow up again. If that changes, I'd be glad to put a test video together.`,
  },
  {
    slug: 'ugc_reply_interested', kind: 'reply', name: 'Reply to an interested brand', sort_order: 8,
    subject: null,
    body: `Hi {{contact_name}},

Thanks for getting back to me. To put the right proposal together, could you share:
- which product or feature you want to highlight
- where the videos will run (organic social, paid ads, your website)
- how many videos you have in mind, and your timeline
- whether you'll need raw footage or ad usage beyond organic posting

Once I know that, I'll send a short proposal with concepts and pricing.`,
  },
  {
    slug: 'ugc_pricing_proposal', kind: 'proposal', name: 'Pricing proposal', sort_order: 9,
    subject: null,
    body: `Hi {{contact_name}},

Here's what I'd suggest for {{company}}: {{deliverables}}

Edited UGC videos for organic use on your own channels:
- 1 video: {{price_1}}
- 3 videos: {{price_3}}
- 5 videos: {{price_5}}

Each video includes the concept, script, filming, editing, captions and {{revisions}} round(s) of revisions. Paid ad usage, whitelisting, raw footage and exclusivity are quoted separately, depending on duration and scope.

Let me know which option works and I'll send over a simple agreement.`,
  },
  {
    slug: 'ugc_retainer_proposal', kind: 'proposal', name: 'Monthly retainer proposal', sort_order: 10,
    subject: null,
    body: `Hi {{contact_name}},

If you'd like a steady flow of creative, I offer a monthly package for {{company}}: 4 edited UGC videos a month, starting at {{price_monthly}}, with fresh concepts each month based on what performs.

That covers concepts, scripts, filming, editing, captions and {{revisions}} round(s) of revisions per video for organic use. Paid ad usage, whitelisting, raw footage and exclusivity are priced separately.

Happy to start with a one-month trial if that's easier.`,
  },
]


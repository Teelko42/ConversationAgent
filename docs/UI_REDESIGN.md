# Aizen UI redesign — removing the "AI-generated" look

**Date:** 2026-06-04 · **Branch:** `UI_Updates` · **Scope:** `packages/server/public/` (vanilla HTML/CSS/JS, no framework)

This document records (1) the deep research into what makes a web UI read as
"AI-generated," (2) the diagnosis of Aizen's old design against that consensus,
and (3) the concrete changes shipped to move Aizen to an intentional,
human-designed look while keeping it polished and usable.

---

## 1. Executive summary

The "AI slop" look is a recognized, well-documented visual signature with a
tight consensus set of tells: **Inter / system fonts with no distinctive
headline face, purple-to-blue (indigo) gradients, heavy glassmorphism,
uniformly rounded cards, ambient glows, faint large-blur shadows, emoji icons,
and vague centered hero copy.** Aizen's previous design hit nearly every one.

The redesign attacks the four highest-leverage tells and balances them against
**Jakob's Law** (users prefer interfaces that work like the ones they know): all
distinctiveness was pushed into the *visual identity* layer — type, color,
icons, copy — while the *functional dashboard* (transcript + explanation
panels, stat cards, modals, nav) keeps conventional, familiar interaction
patterns.

---

## 2. Research: what reads as "AI-generated" (with citations)

Findings below survived a fan-out deep-research pass (21 sources fetched, 25
claims adversarially verified; 18 confirmed, 7 killed).

### Confirmed (high confidence)
- **A tight consensus tell-list exists.** Inter/Roboto/system fonts, indigo
  gradients in heroes/buttons, glassy panels, repeated rounded-card grids, big
  empty hero sections, subtle shadows — "recognizable, overused, and weakly
  connected to the product."
  Sources: [925studios](https://www.925studios.co/blog/ai-slop-web-design-guide),
  [prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website),
  [Trilogy AI](https://trilogyai.substack.com/p/fixing-visual-ai-slop),
  [Medium/dminhk](https://medium.com/@dminhk/why-do-ai-generated-websites-all-look-identical-02a68015613d),
  [Jack Pearce](https://www.jackpearce.co.uk/notes/purple-gradient-ai-aesthetics/).
- **Anthropic's own frontend-design skill names the exact tells** (verified in
  `anthropics/skills` and `anthropics/claude-code`): *"NEVER use generic
  AI-generated aesthetics like overused font families (Inter, Roboto, Arial,
  system fonts), cliched color schemes (particularly purple gradients on white
  backgrounds), predictable layouts and component patterns, and cookie-cutter
  design that lacks context-specific character."*
- **Typography is the highest-leverage fix:** abandon Inter; pair ONE
  distinctive display/headline face with a separate readable body face; never
  use the expressive face for body copy.
  ([NN/g pairing typefaces](https://www.nngroup.com/articles/pairing-typefaces/), 925studios.)
- **Build color in a perceptual space (OKLCH/HCT), not HSL**, so lightness and
  chroma behave predictably across hues when generating a distinctive palette.
  ([LogRocket](https://blog.logrocket.com/oklch-css-consistent-accessible-color-palettes),
  [Evil Martians](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl),
  [Ottosson](https://bottosson.github.io/posts/colorpicker/).)
- **Use glassmorphism sparingly** (depth on a few key elements, ~4–6px blur),
  not 16–18px across every card; translucent panels harm text readability, and
  busy ambient backgrounds harm focus.
  ([NN/g glassmorphism](https://www.nngroup.com/articles/glassmorphism/).)
- **Visible craft signals "human-made":** varied weights, asymmetry, texture,
  "nothing perfectly centered or perfectly smooth."
  ([NN/g handmade designs](https://www.nngroup.com/articles/handmade-designs/).)
- **Balance against Jakob's Law:** novelty has a real usability cost; express
  distinctiveness in identity, keep core interaction patterns conventional.
  ([Laws of UX](https://lawsofux.com/jakobs-law/).)

### Refuted / important caveats
- The **causal "Tailwind `bg-indigo-500` caused it"** story (0–3), the
  "distributional convergence" explanation (0–3), and the "Linear Magic Blue
  imitation" theory (0–3) were all refuted. The *descriptive* tells are real;
  the *causal just-so stories* are not.
- The claim that **constant OKLCH lightness yields equal contrast** across hues
  was refuted (0–3). OKLCH helps build palettes systematically but does **not**
  guarantee WCAG contrast — always check independently.
- "At most two typefaces" and "identical 16px radius = AI" were **not** upheld
  as hard rules (1–2 each).
- **No quantitative studies** prove these tells reduce trust/conversion — this
  is strong design *consensus*, not measured fact.
- This is a fast-moving 2025–26 discourse; today's distinctive picks (e.g.
  Playfair Display) can become tomorrow's clichés. Treat the *principle*
  (be intentional, context-specific) as durable, the *specific picks* as
  perishable.

---

## 3. Diagnosis: Aizen's old tells

| Consensus tell | Old Aizen code |
|---|---|
| Inter everywhere, no display face | `font: 15px/1.6 "Inter"…` |
| Indigo→violet gradient on buttons/brand | `--accent-grad: linear-gradient(135deg,#5b78ff,#2536e8)` |
| Heavy glassmorphism | `--glass` translucent fills + `backdrop-filter: blur(16–18px)` on every card/chrome |
| Ambient glow + grid + film-grain stack | `.app-bg` 3 radial glows + 58px grid + SVG turbulence noise |
| Soft large-blur shadows | `--glow-soft: 0 18px 44px -30px …`, blue `--glow-blue` |
| Pill buttons + 24px rounded cards | `--r-lg:24px`, `.btn` `border-radius:var(--r-pill)` |
| Glowing pulse dots | `.pulse-dot { box-shadow: 0 0 10px 1px … }` |
| Emoji as UI icons | 🎙 🖥 🌙 ✨ 🔗 👤 in topbar/buttons/provider modal/source chips |
| Vague centered hero copy | "Live Conversation Intelligence" |
| Cool blue "fintech" canvas | `--bg: #eef1f8` |

(Cards were already square — `border-radius:0` — from a prior commit, so that
one tell was already gone.)

---

## 4. What changed (implementation)

All changes are token-driven where possible, so both light and dark themes
follow automatically and the brand direction stays easy to re-tune.

### Typography — `styles.css`, `index.html`
- New Google Fonts link: **Space Grotesk** (display) + **IBM Plex Sans** (body),
  replacing Inter.
- Added `--font-display` / `--font-body` tokens; `body` uses Plex; `h1–h3`,
  `.brand-name`, `.card-eyebrow`, `.stat-value`, `.stat-label` use Space
  Grotesk. Display face is reserved for headers/numerals, never body copy.

### Color — `styles.css` (`:root` + dark), `index.html` (favicon)
- **Off cool-indigo → warm paper + deep teal + terracotta.** Derived in OKLCH,
  shipped as hex for render-path reliability (the PiP/clone path copies
  stylesheets and must not depend on newer color syntax).
  - Canvas `--bg` `#eef1f8` → **`#f4f2ec`** (warm paper).
  - Primary `--accent` `#2f4bda` → **`#0f6e6c`** (deep teal; white-on-fill and
    teal-as-text both pass AA).
  - `--accent-grad` demoted to a **same-hue** subtle teal gradient, used only on
    the brand mark (the one gradient moment).
  - `--violet` repurposed → **terracotta `#a8502f`** — the warm "Aizen AI"
    accent (badge, avatar, source chips), deliberately *not* AI-purple.
  - Semantic red/amber/green warmed and tuned for ≥4.5:1 as small text.
  - Warm charcoal dark theme (`#16140f`) instead of cool near-black blue.
- **Every hard-coded indigo/violet/cyan wash** (focus rings, hovers, icon
  backgrounds, active wells — ~25 literals across the file) was swept to the new
  teal/terracotta family. Verified: **0 indigo literals remain.**

### Surfaces & depth — `styles.css`
- **Glassmorphism removed from bulk UI:** `--glass*` tokens are now solid;
  `backdrop-filter` dropped from the sidebar and all cards. One light `blur(8px)`
  kept on the sticky topbar (the single allowed glass moment).
- **Ambient stack deleted:** `.app-bg` is now a flat warm canvas — radial glows,
  58px grid, and film-grain are gone (they harmed readability behind text).
- **Per-card glow** (`.stat-card::before` radial) removed.
- **Shadows neutralized & tightened:** `--glow-*` tokens are now small,
  neutral, two-tier shadows instead of large blue-blur glows.
- **De-bubbled radii:** `--r-lg` 24→**14**, `--r-md` 18→**11**, `--r-sm` 12→**8**;
  buttons and the search field moved from pill to `--r-sm` (square-ish, more
  intentional). Status/badge chips stay pill (they're status, not actions).
- **Calmer motion:** the live pulse-dot keeps its subtle scale/opacity pulse but
  loses the glowing halo.

### Iconography — `index.html`, `client.js`
- Replaced **all emoji-as-icons** with inline Lucide-style stroke SVGs (matching
  the icon style already used in the nav/stat cards — no new dependency):
  - Topbar: mic, monitor, audio-waves (mic+computer), moon/sun, external-link
    (pop-out), user (sign-in).
  - `client.js` capture buttons: idle/recording icons now SVG (innerHTML), incl.
    a stop-square recording icon.
  - Providers modal: mic / sparkles / search / lock.
  - Source-citation chips: gem (vault) / file / pencil (note).

### Microcopy — `index.html`
- Hero `<h1>` "Live Conversation Intelligence" → **"Hear it. Read it.
  Understand it."** with a concrete sub: *"Live transcription, instant
  word-by-word breakdowns, and web-grounded answers — as the conversation
  happens."*

### Files touched
- `packages/server/public/styles.css` — tokens, fonts, `.app-bg`, glass/blur,
  shadows, radii, buttons, pulse, washes, `.prov-ico`, `.src-chip*`.
- `packages/server/public/index.html` — font link, favicon, hero copy, topbar
  SVG icons.
- `packages/server/public/client.js` — capture-button SVGs, provider-modal
  SVGs, source-chip SVGs.

---

## 5. The distinctive ↔ usable trade-off

Per Jakob's Law, the redesign deliberately **does not** touch the live
dashboard's interaction model, information density, or layout grid. The
two-column transcript/explanation, stat row, modals, and nav remain conventional
and familiar. Distinctiveness lives entirely in **type, color, iconography,
shadow/▢ treatment, and copy** — the identity layer. For enterprise real-time
software, polish still signals trust; "handmade imperfection" was intentionally
*not* applied to the functional UI.

---

## 6. How to view & tune

**View locally** (serve the static folder; any static server works):
```
node -e "const h=require('http'),f=require('fs'),p=require('path');const r='packages/server/public';h.createServer((q,s)=>{let u=q.url.split('?')[0];if(u=='/')u='/index.html';f.readFile(p.join(r,u),(e,d)=>{e?(s.writeHead(404),s.end()):(s.writeHead(200),s.end(d))})}).listen(4179)"
```
…then open `http://localhost:4179/`. (Live data needs the real server + API
keys; the static serve is enough to review the visual redesign.)

**Re-tune the brand** — everything routes through `:root` in `styles.css`:
- **Brand hue:** change `--accent` / `--accent-deep` / `--accent-grad` (and the
  matching teal wash literals `rgba(15,110,108,…)` if you want hovers to follow).
- **Secondary/AI accent:** `--violet` (currently terracotta).
- **Font personality:** swap the Google Fonts link + `--font-display`/`--font-body`.
  Editorial alternative: Fraunces or Bricolage Grotesque (display) + Public Sans.

---

## 7. Verification status
- Static: CSS braces balanced (360/360); **0 indigo literals remain**; server
  serves updated HTML (Space Grotesk, new hero) and CSS (`#0f6e6c`, `#f4f2ec`).
- **Live screenshot not captured:** the Claude-in-Chrome automation browser in
  this environment can't reach the Windows host's loopback, so a rendered
  screenshot wasn't possible here. Open the URL above to eyeball it.

## 8. Suggested follow-ups (optional)
- Add a bespoke **anchor element** (e.g. a distinctive live-waveform viz for the
  transcript) — the one place to invest custom craft.
- Light **type-scale** pass for stronger header↔body contrast.
- Independent **WCAG contrast audit** of the new palette (OKLCH doesn't
  guarantee it).

#!/usr/bin/env node
// tog178-catalogue-revalidate.mjs — read-only pre-flight for the TOG-178 deployment.
//
// WHY THIS EXISTS: TOG-178-apply.sh phase 3 ("dry-run — live catalogue check for every
// planned leaf id") can only run on the operator's host, because the rest of that script needs a
// manage-scoped key. But phase 3 itself reads the CATALOGUE, which lives on the inference
// plane (/v1/models) and answers to an ordinary read key that agents already hold.
//
// So the single most likely cause of a failed operator run — a leg id that has churned out
// of the catalogue since the spec was generated on 2026-08-23 — is detectable by an agent,
// today, for free. Every operator round trip on this issue has cost days; eight runbook
// cards have died waiting. This turns "phase 3 fails on the operator's host" into "phase 3
// was known-green before the operator started".
//
// READ-ONLY, BY CONSTRUCTION. It performs exactly one HTTP call, a GET of the model
// catalogue. It never touches :20128/api/* (agents are denied there by design and that
// boundary is correct), never writes, and never echoes a credential.
//
// EXIT: 0 = every check passed, the spec is still deployable as written.
//       1 = at least one check failed; the spec must be regenerated before the operator
//           run. Read the FAIL lines. Never hand-edit the spec — fix the leg table.
//       2 = could not run the check at all (bad input, unreachable catalogue). This is
//           NOT a pass, and is deliberately distinct from 1 so a broken harness can never
//           be mistaken for a clean spec.
//
// ENV:
//   OMNIROUTE_MODELS_URL  default http://omniroute:20129/v1/models
//                         (from an agent container only the 'omniroute' alias resolves;
//                          127.0.0.1 is the HOST's view and the two are not interchangeable)
//   OMNIROUTE_API_KEY     ordinary read key. Required, unless a fixture is used.
//   TOG178_DIR            default /paperclip/operator-handoff
//   TOG178_CATALOGUE_FIXTURE
//         Path to a saved /v1/models JSON body, used INSTEAD of the live GET. This exists
//         so the mutation suite (tests/tog178-preflight.spec.ts) can prove this checker
//         still has teeth without network access. A fixture run is NOT a live check and
//         says so, loudly, in the banner and in the RESULT line — because a checker that
//         can be silently pointed at a stale corpus is worse than no checker.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TOG178_DIR || join(import.meta.dirname, '..', 'tests', 'fixtures', 'tog178')
const MODELS_URL = process.env.OMNIROUTE_MODELS_URL || 'http://omniroute:20129/v1/models'
const KEY = process.env.OMNIROUTE_API_KEY

// The family regex the TOG-178 brief mandates. A `claude` SUBSTRING match is not
// sufficient and is the documented trap: Claude-bearing aug/* aliases contain no
// `claude` string, so a substring audit clears them all.
const CLAUDE_RE = /(claude|sonnet|opus|haiku|fable|mythos|prism)/i

const PROTECTED_PREFIXES = ['hindsight/', 'auto/', 'qtSd/']

let failures = 0
let checks = 0
const fail = (check, msg, detail) => {
  failures++
  console.error(`FAIL  [${check}] ${msg}`)
  if (detail?.length) for (const d of detail.slice(0, 20)) console.error(`        ${d}`)
  if (detail?.length > 20) console.error(`        … and ${detail.length - 20} more`)
}
const pass = (check, msg) => console.error(`pass  [${check}] ${msg}`)
const die = (msg) => { console.error(`\nUNABLE TO CHECK: ${msg}`); process.exit(2) }

const readJson = (f) => {
  try { return JSON.parse(readFileSync(join(DIR, f), 'utf8')) }
  catch (e) { die(`cannot read ${f}: ${e.message}`) }
}

// Glob semantics matching OmniRoute's mapping resolution: `*` and `?` wildcards,
// everything else literal. Used to prove a pattern cannot capture a Claude id.
const globToRe = (g) =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')

const FIXTURE = process.env.TOG178_CATALOGUE_FIXTURE

// ---------------------------------------------------------------- inputs
if (!KEY && !FIXTURE) die('OMNIROUTE_API_KEY is not set — this check needs an ordinary read key.')

const specs = readJson('TOG-178-combo-specs.json')
const mappings = readJson('TOG-178-mapping-plan.json')
let allowlist
try {
  allowlist = readFileSync(join(DIR, 'TOG-178-combo-allowlist.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]) // strip any trailing !nonclaude-style annotation
} catch (e) { die(`cannot read TOG-178-combo-allowlist.txt: ${e.message}`) }

if (!Array.isArray(specs) || !specs.length) die('combo-specs.json is not a non-empty array')
if (!Array.isArray(mappings) || !mappings.length) die('mapping-plan.json is not a non-empty array')

console.error(`TOG-178 catalogue revalidation`)
console.error(`  specs=${specs.length}  mappings=${mappings.length}  allowlist=${allowlist.length}`)
console.error(`  catalogue=${FIXTURE ? `FIXTURE ${FIXTURE}` : MODELS_URL}`)
if (FIXTURE) console.error(`  ****  FIXTURE MODE — this is NOT a live check and proves nothing about deployability  ****`)
console.error('')

// ---------------------------------------------------------------- catalogue
let catalogue
try {
  const body = FIXTURE
    ? JSON.parse(readFileSync(FIXTURE, 'utf8'))
    : await (async () => {
        const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${KEY}` } })
        if (!res.ok) die(`catalogue GET returned HTTP ${res.status}`)
        return res.json()
      })()
  catalogue = (body.data || []).map((m) => m.id).filter(Boolean)
} catch (e) { die(`catalogue read failed: ${e.message}`) }

if (!catalogue.length) die('catalogue returned zero models — refusing to validate against an empty set')
const live = new Set(catalogue)
const claudeIds = catalogue.filter((id) => CLAUDE_RE.test(id))
checks++; pass('C0', `catalogue reachable: ${catalogue.length} live model ids (${claudeIds.length} Claude-family)`)

// ---- C1  every allowlisted leaf id still exists ------------------------------------
checks++
{
  const missing = allowlist.filter((id) => !live.has(id))
  if (missing.length) fail('C1', `${missing.length}/${allowlist.length} allowlisted leaf ids are GONE from the live catalogue`, missing)
  else pass('C1', `all ${allowlist.length} allowlisted leaf ids present in the live catalogue`)
}

// ---- C2  every spec leg exists live, and is allowlisted -----------------------------
checks++
{
  const missingLive = [], notAllowed = [], badProvider = []
  const allow = new Set(allowlist)
  for (const s of specs) {
    for (const leg of s.models || []) {
      if (!live.has(leg.model)) missingLive.push(`${s.name} -> ${leg.model}`)
      if (!allow.has(leg.model)) notAllowed.push(`${s.name} -> ${leg.model}`)
      // providerId must agree with the id's own routing prefix; a mismatch is the
      // TOG-149 failure mode (the prefix in a model id outranks `providers`).
      const prefix = leg.model.split('/')[0]
      if (leg.providerId && prefix && leg.providerId !== prefix) badProvider.push(`${s.name} -> ${leg.model} declares providerId=${leg.providerId}`)
    }
  }
  const legCount = specs.reduce((n, s) => n + (s.models?.length || 0), 0)
  if (missingLive.length) fail('C2a', `${missingLive.length}/${legCount} combo legs reference a model id that no longer exists`, missingLive)
  else pass('C2a', `all ${legCount} combo legs resolve against the live catalogue`)
  if (notAllowed.length) fail('C2b', `${notAllowed.length} legs are outside the deny-by-default allowlist`, notAllowed)
  else pass('C2b', `all ${legCount} legs are inside the allowlist`)
  if (badProvider.length) fail('C2c', `${badProvider.length} legs declare a providerId that contradicts their id prefix`, badProvider)
  else pass('C2c', `every leg's providerId agrees with its id prefix`)
}

// ---- C3  every combo has a terminal PAYG leg ----------------------------------------
// The whole point of the design: opencode-go first, openrouter terminal. A combo whose
// last leg is not the PAYG provider has no always-works fallback.
checks++
{
  const bad = []
  for (const s of specs) {
    const legs = s.models || []
    if (legs.length < 2) { bad.push(`${s.name} has ${legs.length} leg(s)`); continue }
    if (!legs[0].model.startsWith('opencode-go/')) bad.push(`${s.name} leg1 is ${legs[0].model}, not opencode-go/*`)
    if (!legs[legs.length - 1].model.startsWith('openrouter/')) bad.push(`${s.name} terminal leg is ${legs[legs.length - 1].model}, not openrouter/*`)
  }
  if (bad.length) fail('C3', `${bad.length} combos do not have the [opencode-go … openrouter-terminal] shape`, bad)
  else pass('C3', `all ${specs.length} combos are opencode-go-first with an openrouter terminal leg`)
}

// ---- C4  Claude containment ---------------------------------------------------------
checks++
{
  const hits = []
  for (const s of specs) {
    if (CLAUDE_RE.test(s.name)) hits.push(`combo name ${s.name}`)
    for (const leg of s.models || []) if (CLAUDE_RE.test(leg.model)) hits.push(`leg ${s.name} -> ${leg.model}`)
  }
  for (const m of mappings) if (CLAUDE_RE.test(m.pattern)) hits.push(`mapping pattern ${m.pattern}`)
  if (hits.length) fail('C4', `${hits.length} Claude-family references inside a pc/* combo or mapping — containment breach`, hits)
  else pass('C4', `zero Claude-family ids in any combo name, leg, or mapping pattern (${CLAUDE_RE})`)
}

// ---- C5  no mapping pattern can capture a Claude id ---------------------------------
// Resolution is first-match-wins over globs. One broad pattern would capture everything,
// including the Claude-bearing ids. This proves each pattern against the LIVE corpus.
checks++
{
  const wild = mappings.filter((m) => /[*?]/.test(m.pattern))
  const captures = []
  for (const m of mappings) {
    const re = globToRe(m.pattern)
    const caught = claudeIds.filter((id) => re.test(id))
    if (caught.length) captures.push(`${m.pattern} captures ${caught.length}: ${caught.slice(0, 3).join(', ')}`)
  }
  if (wild.length) fail('C5a', `${wild.length} mapping patterns contain a wildcard — the brief requires exact patterns only`, wild.map((m) => m.pattern))
  else pass('C5a', `all ${mappings.length} mapping patterns are wildcard-free (exact)`)
  if (captures.length) fail('C5b', `${captures.length} mapping patterns match a live Claude-family id`, captures)
  else pass('C5b', `no mapping pattern matches any of the ${claudeIds.length} live Claude-family ids`)
}

// ---- C6  mapping integrity ----------------------------------------------------------
// Ties break on created_at, which is invisible and reorders silently on recreate — so
// every mapping needs an explicit UNIQUE priority.
checks++
{
  const names = new Set(specs.map((s) => s.name))
  const dupPat = [], dupPri = [], orphan = [], noPri = []
  const seenPat = new Set(), seenPri = new Set()
  for (const m of mappings) {
    if (seenPat.has(m.pattern)) dupPat.push(m.pattern); else seenPat.add(m.pattern)
    if (typeof m.priority !== 'number') noPri.push(`${m.pattern} priority=${m.priority}`)
    else if (seenPri.has(m.priority)) dupPri.push(`${m.pattern} priority=${m.priority}`)
    else seenPri.add(m.priority)
    if (!names.has(m.comboName)) orphan.push(`${m.pattern} -> ${m.comboName} (no such combo in the spec)`)
  }
  if (dupPat.length) fail('C6a', `${dupPat.length} duplicate mapping patterns`, dupPat)
  else pass('C6a', `all ${mappings.length} mapping patterns are unique`)
  if (noPri.length || dupPri.length) fail('C6b', `${noPri.length + dupPri.length} mappings lack an explicit unique priority`, [...noPri, ...dupPri])
  else pass('C6b', `every mapping carries an explicit, unique priority`)
  if (orphan.length) fail('C6c', `${orphan.length} mappings point at a combo that is not in the spec`, orphan)
  else pass('C6c', `every mapping resolves to a combo in the spec`)
}

// ---- C7  additivity ------------------------------------------------------------------
// New combos must be additive. If a pc/* name is ALREADY live, applying the spec would be
// an overwrite, not a create — and the 19 agent bindings in other companies are the reason
// that distinction matters.
checks++
{
  const collide = specs.map((s) => s.name).filter((n) => live.has(n))
  const protectedHit = specs.map((s) => s.name).filter((n) => PROTECTED_PREFIXES.some((p) => n.startsWith(p)))
  if (collide.length) fail('C7a', `${collide.length} pc/* names already exist live — applying would overwrite, not add`, collide)
  else pass('C7a', `none of the ${specs.length} combo names collide with a live id (deployment is purely additive)`)
  if (protectedHit.length) fail('C7b', `${protectedHit.length} combo names fall inside a PROTECTED prefix`, protectedHit)
  else pass('C7b', `no combo name touches ${PROTECTED_PREFIXES.join(' ')}`)
}

// ---- C8  strategy is the value everything normalises to ------------------------------
// `priority` is TOG-178's declared INTERIM. normalizeRoutingStrategy() silently coerces
// unknown values, so a typo here would not error — it would quietly become something else.
checks++
{
  const bad = specs.filter((s) => s.strategy !== 'priority').map((s) => `${s.name} strategy=${s.strategy}`)
  if (bad.length) fail('C8', `${bad.length} combos carry a strategy other than the declared interim 'priority'`, bad)
  else pass('C8', `all ${specs.length} combos carry strategy='priority' (TOG-178 interim, expires with TOG-210)`)
}

// ---------------------------------------------------------------- verdict
console.error('')
if (failures) {
  console.error(`RESULT: FAIL — ${failures} failed check(s) across ${checks} groups.`)
  console.error(`The TOG-178 spec is NOT deployable as written. Regenerate the leg table; do not hand-edit the spec.`)
  process.exit(1)
}
if (FIXTURE) {
  console.error(`RESULT: PASS (FIXTURE — NOT A LIVE CHECK) — ${checks} check groups clean against ${catalogue.length} fixture ids.`)
  console.error(`Re-run without TOG178_CATALOGUE_FIXTURE before drawing any conclusion about the real deployment.`)
  process.exit(0)
}
console.error(`RESULT: PASS — ${checks} check groups clean against ${catalogue.length} live model ids.`)
console.error(`TOG-178-apply.sh phase 3 will pass. Everything past phase 3 still needs a manage-scoped key.`)
process.exit(0)

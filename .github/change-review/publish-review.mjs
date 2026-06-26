#!/usr/bin/env node
// Publish a single GitHub PR review from the structured output of
// `tessl change review`. The CLI emits review data and never posts to GitHub
// itself; this script is the GitHub-side caller that turns that data into
// exactly one `pulls.createReview` call:
//
//   - summary.overview         -> the parent review body
//   - summary.warnings         -> a collapsible section appended to the body
//   - summary.unplacedFindings -> a collapsible section appended to the body
//   - comments[]               -> inline review comments
//   - metadata.headSha         -> commit_id (the review is pinned to that SHA)
//   - metadata.skills          -> the "Reviewed against skills:" line
//
// Exit 0 = review created. Exit 1 = a config/input/publish failure (red check).
import { readFileSync, writeFileSync } from 'node:fs'

function fail(msg) {
  console.error(`publish-review.mjs: ${msg}`)
  process.exit(1)
}

function requireEnv(name) {
  const v = process.env[name]
  if (v === undefined || v === '') fail(`missing required env ${name}`)
  return v
}

function optionalEnv(name) {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    fail(`could not read JSON from ${path}: ${e.message}`)
  }
}

// Turn a `--skill` ref into a short display name for the summary line.
function skillDisplayName(ref) {
  const selected = String(ref).split('#').pop()
  const withoutVersion = selected.replace(/@[^/@#]+$/, '')
  const parts = withoutVersion.split('/').filter(Boolean)
  const leaf = parts.at(-1) ?? withoutVersion
  return leaf === 'SKILL.md' && parts.length > 1 ? parts.at(-2) : leaf
}

const REPO = requireEnv('REPO') // owner/repo
const PR_NUMBER = requireEnv('PR_NUMBER')
const GH_TOKEN = requireEnv('GH_TOKEN')
const reviewPath = optionalEnv('REVIEW_OUTPUT') ?? 'change-review.json'
const OUT = optionalEnv('OUT') ?? 'review-publish.json'

const reviewAction = optionalEnv('REVIEW_ACTION') ?? 'comment'
if (
  reviewAction !== 'comment' &&
  reviewAction !== 'request-changes-on-findings'
)
  fail(
    `REVIEW_ACTION must be "comment" or "request-changes-on-findings" (got ${JSON.stringify(reviewAction)})`,
  )

const review = readJson(reviewPath)
const REVIEW_MARKER = '<!-- tessl-change-review -->'

// Validate the CLI shape we depend on; crash on a regression rather than
// silently posting an empty review.
if (!review.summary || typeof review.summary !== 'object')
  fail('review JSON missing object "summary"')
if (!Array.isArray(review.comments))
  fail('review JSON missing array "comments"')
if (!review.metadata || typeof review.metadata !== 'object')
  fail('review JSON missing object "metadata"')

const headSha = review.metadata.headSha
if (typeof headSha !== 'string' || headSha === '')
  fail('review metadata missing string "headSha"')
if (!Array.isArray(review.metadata.skills))
  fail('review metadata missing array "skills"')
if (typeof review.summary.overview !== 'string')
  fail('review summary missing string "overview"')
if (!Array.isArray(review.summary.warnings))
  fail('review summary missing array "warnings"')
if (!Array.isArray(review.summary.unplacedFindings))
  fail('review summary missing array "unplacedFindings"')

// Strip a leading `## Findings` heading the CLI may emit so the parent body
// title stays `tessl change review:` rather than duplicating a findings heading.
const overview = review.summary.overview
  .trim()
  .replace(/^#{1,6}\s+findings\s*\n+/i, '')
  .trim()
const { warnings, unplacedFindings } = review.summary
const skillNames = review.metadata.skills.map(skillDisplayName)
const skillLine =
  skillNames.length > 0
    ? `Reviewed against skills: ${skillNames.map((n) => `\`${n}\``).join(', ')}`
    : 'Reviewed against skills: _none reported_'

// --- parent review body: marker + title + skills line + overview ---
const bodyParts = [REVIEW_MARKER, '## tessl change review:', skillLine]
bodyParts.push(
  overview === '' ? '_No summary was produced for this diff._' : overview,
)

// Degrade unplaced findings into the body instead of dropping them.
if (unplacedFindings.length > 0) {
  const items = unplacedFindings.map((f) => {
    // Render whatever location fields exist (path, line, side), not only when
    // both path and line are present, so partial locations still show.
    const locationParts = []
    if (f.path) locationParts.push(f.path)
    if (f.line) locationParts.push(`line ${f.line}`)
    if (f.side) locationParts.push(f.side)
    const where =
      locationParts.length > 0 ? ` \`${locationParts.join(':')}\`` : ''
    const reason = f.reason ? ` (${f.reason})` : ''
    const lines = [`- **Unplaced finding**${where}${reason}`]
    for (const bodyLine of String(f.body ?? '').split('\n'))
      lines.push(`  ${bodyLine}`)
    return lines.join('\n')
  })
  bodyParts.push(
    [
      '<details>',
      `<summary>Unplaced findings (${unplacedFindings.length}) — could not anchor to a changed hunk</summary>`,
      '',
      items.join('\n'),
      '</details>',
    ].join('\n'),
  )
}

if (warnings.length > 0) {
  bodyParts.push(
    [
      '<details>',
      `<summary>Warnings (${warnings.length})</summary>`,
      '',
      warnings.map((w) => `- ${w}`).join('\n'),
      '</details>',
    ].join('\n'),
  )
}

bodyParts.push(
  '---\nTo trigger a re-review write a comment that says `@tessl-change-review`.',
)
const body = bodyParts.join('\n\n')

// --- map comments[] to GitHub inline review comments ---
// Validate each locally so a CLI bug fails with a pointer at the offending
// finding rather than letting GitHub 422 the whole batch.
const comments = review.comments.map((c, i) => {
  if (!c || typeof c !== 'object') fail(`comments[${i}] is not an object`)
  if (typeof c.path !== 'string' || c.path === '')
    fail(`comments[${i}] missing string "path"`)
  if (!Number.isInteger(c.line) || c.line < 1)
    fail(`comments[${i}] "line" must be a positive integer`)
  if (c.side !== 'LEFT' && c.side !== 'RIGHT')
    fail(`comments[${i}] "side" must be LEFT or RIGHT`)
  if (typeof c.body !== 'string' || c.body === '')
    fail(`comments[${i}] missing string "body"`)
  const comment = { path: c.path, line: c.line, side: c.side, body: c.body }
  // Multi-line comments carry a start anchor. Only attach it when it names a
  // valid line strictly above `line`; collapsed or inverted ranges
  // (startLine >= line) are downgraded to a single-line comment by omitting
  // start_line/start_side, so one bad range can't fail the whole review.
  if (c.startLine !== undefined) {
    if (!Number.isInteger(c.startLine) || c.startLine < 1)
      fail(`comments[${i}] "startLine" must be a positive integer`)
    if (c.startLine < c.line) {
      comment.start_line = c.startLine
      if (c.startSide !== undefined) {
        if (c.startSide !== 'LEFT' && c.startSide !== 'RIGHT')
          fail(`comments[${i}] "startSide" must be LEFT or RIGHT`)
        comment.start_side = c.startSide
      }
    }
  }
  return comment
})

const hasFindings = comments.length > 0 || unplacedFindings.length > 0
const event =
  reviewAction === 'request-changes-on-findings' && hasFindings
    ? 'REQUEST_CHANGES'
    : 'COMMENT'

const [owner, repo, ...rest] = REPO.split('/')
if (rest.length > 0 || !owner || !repo)
  fail(`REPO must be "owner/repo" (got ${JSON.stringify(REPO)})`)

const res = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/pulls/${PR_NUMBER}/reviews`,
  {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${GH_TOKEN}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ commit_id: headSha, event, body, comments }),
  },
)

const text = await res.text()
if (!res.ok) fail(`GitHub createReview failed (HTTP ${res.status}): ${text}`)

// Parse the response defensively and still write the small publish artifact
// even if the body isn't the JSON we expect.
let created
try {
  created = JSON.parse(text)
} catch (e) {
  fail(`could not parse GitHub createReview response: ${e.message}`)
}

writeFileSync(
  OUT,
  `${JSON.stringify({ reviewId: created.id ?? null, reviewUrl: created.html_url ?? null, commitId: headSha, event, commentCount: comments.length }, null, 2)}\n`,
)
console.error(
  `publish-review.mjs: created review ${created.id ?? '(unknown id)'}`,
)

#!/usr/bin/env node
// Samler alt hvad Release Manager skal bruge for at skrive nyheden til én release, og
// skriver det som $STATE_DIR/context.json.
//
//   node release-context.mjs --repo <owner/repo> --version <x.y.z> [--tag v<x.y.z>]
//        [--releases tickets/releases.json] [--tickets tickets]
//        [--web-path src/www] [--app-path src/app]
//
// Historikken hentes fra GitHub API'et, ikke fra den lokale klon: stationens klon kan være
// shallow og uden tags. releases-filen og ticketene læses lokalt fra arbejdstræet (main).
//
// Alt hvad mennesker har skrevet — commit-beskeder, PR-titler og -beskrivelser — kommer ud
// pakket som ⟦untrusted⟧ … ⟦/untrusted⟧. Det er kildemateriale, ikke instruktioner.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { arg, die, github, parseRepo, untrusted, writeJson, STATE_DIR } from './lib/common.mjs';

const REPO = arg('repo');
const VERSION = arg('version');
if (!REPO || !VERSION) die('Brug: release-context.mjs --repo <owner/repo> --version <x.y.z>');
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) die(`--version skal være x.y.z, fik "${VERSION}"`);
const TAG = arg('tag', `v${VERSION}`);
const RELEASES_FILE = arg('releases', 'tickets/releases.json');
const TICKETS_DIR = arg('tickets', 'tickets');
const PLATFORM_PATHS = { web: arg('web-path', 'src/www'), app: arg('app-path', 'src/app') };
const MAX_COMMITS = 80;

const { owner, repo } = parseRepo(REPO);
const R = `/repos/${owner}/${repo}`;

const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
};
const ticketRe = /\bCC-\d{3}\b/g;

async function contents(fullRepo, path, ref) {
    const r = await github(`/repos/${fullRepo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return r.status === 200 ? r.json : null;
}
const decode = (c) => (c?.content ? Buffer.from(c.content, 'base64').toString('utf8') : '');

/** Commits i et interval med deres PR. Fremmed tekst pakkes ind. */
async function commitsBetween(fullRepo, from, to) {
    const r = await github(`/repos/${fullRepo}/compare/${from}...${to}`);
    if (r.status !== 200) return { access: false, status: r.status, commits: [], files: [] };
    const raw = (r.json.commits ?? []).slice(-MAX_COMMITS);
    const commits = [];
    for (const c of raw) {
        const msg = c.commit?.message ?? '';
        const pulls = await github(`/repos/${fullRepo}/commits/${c.sha}/pulls`);
        const pr = pulls.status === 200 && pulls.json?.[0] ? pulls.json[0] : null;
        commits.push({
            sha: c.sha.slice(0, 7),
            message: untrusted(msg, 1500),
            pr: pr ? { number: pr.number, url: pr.html_url, title: untrusted(pr.title, 200), body: untrusted(pr.body ?? '', 3000) } : null,
            tickets: [...new Set([...(msg + ' ' + (pr?.title ?? '') + ' ' + (pr?.body ?? '')).matchAll(ticketRe)].map((m) => m[0]))],
        });
    }
    return {
        access: true,
        total: r.json.total_commits,
        truncated: (r.json.total_commits ?? 0) > raw.length,
        commits,
        files: (r.json.files ?? []).map((f) => ({ path: f.filename, status: f.status })),
    };
}

function parseGitmodules(text) {
    const out = [];
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*\[submodule /.test(line)) { cur = {}; out.push(cur); continue; }
        const m = line.match(/^\s*(path|url)\s*=\s*(.+?)\s*$/);
        if (m && cur) cur[m[1]] = m[2];
    }
    return out.filter((s) => s.path && s.url);
}
const repoFromUrl = (u) => u.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)?.slice(1, 3).join('/') ?? null;

/** Minimal frontmatter: `nøgle: værdi` i kolonne 0. Nok til id, titel, status og release. */
function frontmatter(text) {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== '---') return {};
    const fm = {};
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
        const m = lines[i].match(/^([\wæøåÆØÅ-]+):\s*(.*)$/);
        if (m && m[2].trim()) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return fm;
}

// --- Tags -----------------------------------------------------------------------------------
const tags = [];
for (let page = 1; page < 10; page++) {
    const r = await github(`${R}/tags?per_page=100&page=${page}`);
    if (r.status !== 200) die(`Kunne ikke liste tags (HTTP ${r.status}): ${r.text.slice(0, 200)}`);
    tags.push(...r.json.map((t) => t.name));
    if (r.json.length < 100) break;
}
if (!tags.includes(TAG)) die(`NO_TAG: tagget ${TAG} findes ikke på ${REPO}. Er releasen lavet?`, 3);
const previous = tags
    .map((t) => t.match(/^v(\d+\.\d+\.\d+)$/)?.[1])
    .filter((v) => v && cmp(v, VERSION) < 0)
    .sort(cmp)
    .pop();
const PREV_TAG = previous ? `v${previous}` : null;
if (!PREV_TAG) die(`Ingen tidligere version før ${TAG}; den første release skrives i hånden.`, 3);

// --- Paraply-repoet -------------------------------------------------------------------------
const umbrella = await commitsBetween(`${owner}/${repo}`, PREV_TAG, TAG);
if (!umbrella.access) die(`Kunne ikke sammenligne ${PREV_TAG}...${TAG} (HTTP ${umbrella.status}).`);

const changelogText = decode(await contents(`${owner}/${repo}`, 'CHANGELOG.md', TAG));
const changelog = (() => {
    const lines = changelogText.split('\n');
    const start = lines.findIndex((l) => /^#{1,3} /.test(l) && l.includes(VERSION));
    if (start === -1) return null;
    let end = lines.findIndex((l, i) => i > start && /^#{1,2} \[?\d/.test(l));
    if (end === -1) end = lines.length;
    return untrusted(lines.slice(start, end).join('\n'), 6000);
})();

// --- Submoduler: hvad flyttede sig, og hvad står der i dem ----------------------------------
const gitmodules = parseGitmodules(decode(await contents(`${owner}/${repo}`, '.gitmodules', TAG)));
const submodules = [];
for (const sm of gitmodules) {
    const [now, before] = await Promise.all([
        contents(`${owner}/${repo}`, sm.path, TAG),
        contents(`${owner}/${repo}`, sm.path, PREV_TAG),
    ]);
    const to = now?.type === 'submodule' ? now.sha : null;
    const from = before?.type === 'submodule' ? before.sha : null;
    const subRepo = repoFromUrl(sm.url);
    const entry = { path: sm.path, repo: subRepo, from: from?.slice(0, 7) ?? null, to: to?.slice(0, 7) ?? null, moved: !!(to && from && to !== from) };
    if (entry.moved && subRepo) {
        const range = await commitsBetween(subRepo, from, to);
        Object.assign(entry, range.access
            ? { access: true, total: range.total, truncated: range.truncated, commits: range.commits }
            : { access: false, note: `Ingen adgang til ${subRepo} (HTTP ${range.status}). Brug paraply-PR'ernes beskrivelser.` });
        entry._toFull = to;
    }
    submodules.push(entry);
}

// --- Platforme -----------------------------------------------------------------------------
const byPath = Object.fromEntries(submodules.map((s) => [s.path, s]));
const appSm = byPath[PLATFORM_PATHS.app];
let appVersion = null;
if (appSm?.moved && appSm.repo && appSm._toFull) {
    const appJson = decode(await contents(appSm.repo, 'app.json', appSm._toFull));
    try { appVersion = JSON.parse(appJson).expo?.version ?? null; } catch { /* ingen app.json */ }
    if (!appVersion) {
        try { appVersion = JSON.parse(decode(await contents(appSm.repo, 'package.json', appSm._toFull))).version ?? null; } catch { /* intet */ }
    }
}
for (const s of submodules) delete s._toFull;
const platforms = {
    web: { version: VERSION, moved: !!byPath[PLATFORM_PATHS.web]?.moved, path: PLATFORM_PATHS.web },
    app: { version: appVersion, moved: !!appSm?.moved, path: PLATFORM_PATHS.app },
};

// --- Lokalt: releases-filen og ticketene ----------------------------------------------------
const releases = existsSync(RELEASES_FILE) ? JSON.parse(readFileSync(RELEASES_FILE, 'utf8')).releases ?? [] : null;
const existing = {
    web: releases?.find((r) => r.platform === 'web' && r.version === VERSION) ?? null,
    app: appVersion ? releases?.find((r) => r.platform === 'app' && r.version === appVersion) ?? null : null,
};
const tickets = existsSync(TICKETS_DIR)
    ? readdirSync(TICKETS_DIR).filter((f) => /^CC-\d{3}.*\.md$/.test(f)).sort().map((f) => {
        const fm = frontmatter(readFileSync(join(TICKETS_DIR, f), 'utf8'));
        return { id: f.slice(0, 6), file: join(TICKETS_DIR, f), titel: fm.titel ?? null, status: fm.status ?? null, release: fm.release ?? null };
    })
    : [];

const mentions = {};
const note = (id, where) => (mentions[id] ??= []).push(where);
for (const c of umbrella.commits) for (const t of c.tickets) note(t, `${REPO}@${c.sha}${c.pr ? ` (#${c.pr.number})` : ''}`);
for (const s of submodules) for (const c of s.commits ?? []) for (const t of c.tickets) note(t, `${s.repo}@${c.sha}${c.pr ? ` (#${c.pr.number})` : ''}`);

// --- Findes der allerede et åbent PR med nyheden? -------------------------------------------
const openPrs = {};
for (const p of ['web', 'app']) {
    const v = platforms[p].version;
    if (!v) continue;
    const branch = `release-news/${p}-${v}`;
    const r = await github(`${R}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`);
    openPrs[p] = r.status === 200 && r.json?.[0] ? { branch, url: r.json[0].html_url, number: r.json[0].number } : null;
}

const context = {
    repo: REPO,
    version: VERSION,
    tag: TAG,
    previousTag: PREV_TAG,
    compareUrl: `https://github.com/${owner}/${repo}/compare/${PREV_TAG}...${TAG}`,
    platforms,
    existing,
    openPrs,
    changelog,
    umbrella: { total: umbrella.total, truncated: umbrella.truncated, commits: umbrella.commits, files: umbrella.files.filter((f) => !byPath[f.path]) },
    submodules,
    ticketMentions: mentions,
    tickets,
    releasesFile: releases ? RELEASES_FILE : null,
};
await writeJson(`${STATE_DIR}/context.json`, context);
console.log(JSON.stringify(context, null, 2));
const summary = [
    `${REPO} ${PREV_TAG}...${TAG}: ${umbrella.commits.length} commits i paraplyen`,
    ...submodules.filter((s) => s.moved).map((s) => `${s.path} flyttet (${s.access ? `${s.commits.length} commits` : 'ingen adgang'})`),
    `web ${VERSION}${existing.web ? ' — FINDES ALLEREDE i releases-filen' : ''}`,
    platforms.app.moved ? `app ${appVersion ?? '(version ukendt)'}${existing.app ? ' — FINDES ALLEREDE' : ''}` : 'app uændret',
    `tickets nævnt: ${Object.keys(mentions).join(', ') || 'ingen'}`,
];
console.error(summary.join('\n'));

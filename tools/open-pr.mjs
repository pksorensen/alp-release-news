#!/usr/bin/env node
// Lægger de filer, Release Manager har ændret, på en branch og åbner (eller opdaterer) et
// pull request.
//
//   node open-pr.mjs --repo <owner/repo> --branch release-news/web-1.9.0 \
//        --title "docs(release-news): web 1.9.0" --body-file /tmp/alp-release-news/pr.md \
//        [--base main] tickets/releases.json tickets/CC-025-….md …
//
//   … --merge --releases tickets/releases.json --tickets tickets \
//        --check "node tickets/tools/check-releases.mjs"
//
// Med --merge merger værktøjet selv PR'et (squash), når projektets tjek er grønt, og
// når hver fil enten er releases-filen eller en ticket direkte i ticket-mappen. Det er
// sikkert, fordi intet bliver offentligt ved et merge: nyheden lander som kladde i
// projektets admin, og det er dér, et menneske godkender den. Afviser GitHub merget,
// står PR'et åbent, og værktøjet slutter med kode 5.
//
// Committen laves med GitHub's Git Data API ud fra filernes indhold i arbejdstræet: ingen
// `git push` fra containeren, og ingen afhængighed af hvordan klonen er lavet. Branchen
// ejes af linjen — køres stationen igen for samme version, erstattes branchens commit, og
// det åbne PR opdateres i stedet for at få en tvilling.
//
// Titlen SKAL være en ikke-releasende commit-type (docs/chore). En feat- eller fix-commit
// ville lave en ny release, som ville lave en ny nyhed, som ville lave en ny release.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { argv, arg, flag, die, github, parseRepo } from './lib/common.mjs';

const REPO = arg('repo');
const BRANCH = arg('branch');
const TITLE = arg('title');
const BODY_FILE = arg('body-file');
const BASE = arg('base', 'main');
if (!REPO || !BRANCH || !TITLE || !BODY_FILE) die('Brug: open-pr.mjs --repo o/r --branch b --title t --body-file f [--base main] <filer…>');
if (!/^(docs|chore)(\([^)]*\))?: /.test(TITLE)) die(`Titlen skal begynde med docs: eller chore: — fik «${TITLE}». En feat/fix-commit laver en ny release.`);
if (!/^release-news\//.test(BRANCH)) die('Branchen skal ligge under release-news/ — linjen overskriver kun sine egne.');

const valued = new Set(['repo', 'branch', 'title', 'body-file', 'base', 'releases', 'tickets', 'check']);
const files = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') && valued.has(argv[i - 1].slice(2))));
if (!files.length) die('Ingen filer at committe.');
for (const f of files) if (!existsSync(f)) die(`Filen findes ikke: ${f}`);
const body = readFileSync(BODY_FILE, 'utf8');

const MERGE = flag('merge');
if (MERGE) {
    const releases = arg('releases');
    const tickets = arg('tickets')?.replace(/\/+$/, '');
    const check = arg('check');
    if (!releases || !tickets || !check) die('--merge kræver --releases, --tickets og --check.');
    const allowed = (f) => f === releases || (f.startsWith(`${tickets}/`) && !f.slice(tickets.length + 1).includes('/') && f.endsWith('.md'));
    const other = files.filter((f) => !allowed(f));
    if (other.length) die(`--merge: kun releases-filen og tickets må ændres, ikke ${other.join(', ')}.`);
    try {
        execSync(check, { stdio: 'inherit' });
    } catch {
        die('--merge: projektets tjek fejler. Ret teksten og kør igen.');
    }
}

const { owner, repo } = parseRepo(REPO);
const R = `/repos/${owner}/${repo}`;
const ok = (r, what) => {
    if (r.status < 200 || r.status >= 300) die(`${what} fejlede (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
    return r.json;
};

const baseRef = ok(await github(`${R}/git/ref/heads/${BASE}`), `Opslag af ${BASE}`);
const baseCommit = ok(await github(`${R}/git/commits/${baseRef.object.sha}`), 'Opslag af base-commit');

const tree = [];
for (const path of files) {
    const blob = ok(await github(`${R}/git/blobs`, {
        method: 'POST',
        body: { content: readFileSync(path).toString('base64'), encoding: 'base64' },
    }), `Blob for ${path}`);
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
}
const newTree = ok(await github(`${R}/git/trees`, { method: 'POST', body: { base_tree: baseCommit.tree.sha, tree } }), 'Nyt træ');
if (newTree.sha === baseCommit.tree.sha) die('NO_CHANGE: filerne er identiske med main — intet at foreslå.', 4);

const commit = ok(await github(`${R}/git/commits`, {
    method: 'POST',
    body: {
        message: `${TITLE}\n\nSkrevet af Release Manager (agentics.dk, linjen Release News).`,
        tree: newTree.sha,
        parents: [baseRef.object.sha],
    },
}), 'Commit');

const existingRef = await github(`${R}/git/ref/heads/${BRANCH}`);
if (existingRef.status === 200) {
    ok(await github(`${R}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: true } }), 'Opdatering af branch');
} else {
    ok(await github(`${R}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${BRANCH}`, sha: commit.sha } }), 'Ny branch');
}

const open = await github(`${R}/pulls?state=open&head=${owner}:${encodeURIComponent(BRANCH)}`);
let pr = open.status === 200 ? open.json?.[0] : null;
if (pr) {
    pr = ok(await github(`${R}/pulls/${pr.number}`, { method: 'PATCH', body: { title: TITLE, body } }), 'Opdatering af PR');
    console.error(`Opdaterede det åbne PR #${pr.number}.`);
} else {
    pr = ok(await github(`${R}/pulls`, { method: 'POST', body: { title: TITLE, head: BRANCH, base: BASE, body } }), 'Nyt PR');
    console.error(`Åbnede PR #${pr.number}.`);
}
let merged = false;
if (MERGE) {
    const m = await github(`${R}/pulls/${pr.number}/merge`, {
        method: 'PUT',
        body: { merge_method: 'squash', commit_title: `${TITLE} (#${pr.number})`, sha: commit.sha },
    });
    if (m.status !== 200) {
        console.log(JSON.stringify({ number: pr.number, url: pr.html_url, branch: BRANCH, commit: commit.sha.slice(0, 7), files, merged }));
        die(`MERGE_REFUSED: GitHub merger ikke PR #${pr.number} (HTTP ${m.status}): ${m.text.slice(0, 200)}`, 5);
    }
    merged = true;
    console.error(`Mergede PR #${pr.number}.`);
}
console.log(JSON.stringify({ number: pr.number, url: pr.html_url, branch: BRANCH, commit: commit.sha.slice(0, 7), files, merged }));

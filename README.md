# alp-release-news

En ALP-linje med én agent, **Release Manager**. Hver gang en release er lagt ud, skriver den
nyheden til brugerne: kort, på dansk og engelsk, uden teknik. Den kobler nyheden til de
tickets, releasen beviseligt løste, og åbner et pull request. Et menneske merger det.

```
release lagt ud ──▶ Release Manager ──success──▶ Klar til godkendelse   (PR åbent)
 (GitHub OIDC)           │
                         └──failure──▶ Stoppet   (intet nyt, findes allerede, tjek fejler)
```

**Importér:** `https://agentics.dk/import?repo=https://github.com/pksorensen/alp-release-news`

## Hvorfor et pull request og ikke en udgivelse

Agenten har ingen hemmeligheder. Den skriver kun til en branch under `release-news/` i
projektets repo med det GitHub-token, runneren i forvejen udleverer. Hvad der sker, når
nyheden er merget, bestemmer projektet selv. Hos Commute Connects sender et workflow
`tickets/` til support-tavlen, og admin vælger, hvornår releasen står på nyhedssiden.

Commit- og PR-titlen er altid `docs(release-news): …`. En `feat:`/`fix:`-titel ville lave
en ny release, som ville lave en ny nyhed.

## Det projektet skal have

| Hvad | Standard | Kortets felt |
|---|---|---|
| En releases-fil: `{"releases": [{platform, version, items: [{da, en}], fixes: [...]}]}` | `tickets/releases.json` | `releases_file` |
| Tickets som `CC-NNN-*.md` med frontmatter (`titel`, `status`, `release`) | `tickets/` | `tickets_dir` |
| Et tjek, der afviser ord, som ikke må stå offentligt | `node tickets/tools/check-releases.mjs` | `check` |
| Tags `vX.Y.Z` (release-please) og en CHANGELOG.md | | |

Submoduler følges: flyttede `src/www` sig, ses dens commits og PR'er. Flyttede `src/app` sig,
læses app'ens version fra dens `app.json`.

## Sæt det op

1. Importér linjen i projektet (linket ovenfor).
2. Linjens Settings → **Trusted GitHub repositories**: tilføj projektets repo.
3. Kopiér `workflow/alp-release-news.yml` til projektets `.github/workflows/`, og udfyld
   `ALP_OWNER`, `ALP_PROJECT` og `ALP_LINE_ID`. `workflows: ["Release"]` skal være
   release-workflowets navn.
4. En runner skal være startet for projektet: `pks agentics runner start --project <owner>/<project>`.

Prøv det: Actions → **ALP release news** → Run workflow → en version, der er lagt ud.

## Værktøjerne

| Fil | Gør |
|---|---|
| `tools/release-context.mjs` | Henter intervallet fra forrige tag via GitHub API'et: commits, PR'er, CHANGELOG, flyttede submoduler, nævnte tickets og et åbent PR fra en tidligere kørsel. Fremmed tekst pakkes som `⟦untrusted⟧`. |
| `tools/open-pr.mjs` | Laver committen med Git Data API'et (ingen `git push` fra containeren) og åbner eller opdaterer PR'et. Nægter titler, der ville lave en release, og branches uden for `release-news/`. |

Uden for et job: `GITHUB_TOKEN=$(gh auth token) node tools/release-context.mjs --repo o/r --version x.y.z`.

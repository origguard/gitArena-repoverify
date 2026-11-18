# CLÔTURE — RepoVerify / GitArena

**Version :** final-1.0.0  
**Ferme :** I10 · réconciliation du dénominateur  
**Date :** 2026-11-18 03:42:16  
**Instrument :** FERMÉ — 30/30 contrôles, 8/8 fixtures

---

## 1 · Ce qui a été corrigé en dernier

Le dénominateur `deps_resolved` était dérivé de ce que le parseur de version acceptait. `isExactSemver` appliqué à PyPI rejetait PEP 440 (`3.18`, `26.3`, `2.9.0.post0`, `312`, `2026.2`, `7.1.0b4`). Ces paquets sortaient du numérateur **et** du dénominateur : `168/168 = 100 %` affiché, `168/181 = 92,8 %` réel. Le ratio était tautologique.

Le dénominateur vient désormais du fichier : comptage structurel des blocs, moins les sources locales. Tout écart devient `DENOMINATOR_UNRECONCILED`. Un format illisible devient `FORMAT_UNPARSEABLE`, jamais zéro.

### Formats couverts

- `uv.lock` → PyPI
- `poetry.lock` → PyPI
- `pdm.lock` → PyPI
- `Cargo.lock` → crates.io
- `package-lock.json` → npm
- `npm-shrinkwrap.json` → npm
- `pnpm-lock.yaml` → npm
- `yarn.lock` → npm
- `go.sum` → Go
- `Gemfile.lock` → RubyGems
- `composer.lock` → Packagist
- `gradle.lockfile` → Maven
- `requirements.txt` → PyPI
- `constraints.txt` → PyPI

Binary : `bun.lockb` → `FORMAT_UNPARSEABLE` explicite.

---

## 2 · Recensement

```
inputs=485  attempted=33  unattempted=452  ghosts=2  resolved=31  static=31  osv=25  pass=21  verifiedAsResolved=1  verifiedAsNamed=1
breakdown: findingsOnly=0 advisoriesOnly=13 both=7 verified=1  → somme 21 = pass  ✓ I7
```

---

## 3 · Ce qui peut être publié, mot pour mot

> Sur 485 entrées revendiquées, 33 ont été examinées. 2 fantômes confirmés (404), 31 résolus par id canonique, 31 scannés sur leurs manifestes et lockfiles, 25 interrogés contre OSV, 21 satisfont la couverture transitive complète avec dénominateur réconcilié. 1 dépôt satisfait la chaîne entière : 181 dépendances externes résolues depuis uv.lock, 181 interrogées, 181 répondues, aucun finding statique, aucun avis OSV, ancre registre concordante. Le mécanisme de requête est validé par témoin positif (requests 2.19.0 → 10 avis). 452 entrées ne sont pas encore examinées. Le code source n'a pas été lu. Les dépôts polyglotes ne sont pas garantis sur l'union distincte de leurs écosystèmes sans lockfile.

---

## 4 · Ce qui n'est pas attesté

- Exécution isolée du code : docker absent, aucun eBPF, aucun strace, aucun cold-start.
- Lecture du code source : seuls manifestes et lockfiles ont été lus.
- Analyse comportementale distincte : blockedFindingsOnly = 0 sur ce corpus.
- Dépôts polyglotes : la porte de couverture agrège sans distinction par écosystème (et `osv_queries.lockfile_used` ne retient qu'un seul lockfile primaire) ; un écosystème secondaire sans lockfile n'est pas bloqué séparément.
- Chaîne de titre : la titularité des droits concédés n'est pas attestée.
- Licéité de l'acquisition initiale des données : non attestée.
- Brevets, contrôle export, marques : hors périmètre.
- Base légale d'un usage (TDM, RGPD) : aucune licence ne la déduit.
- Identité amont : l'ancre registre est déclarative, CANONICAL_MATCH ≠ projet attendu.
- Horodatage RFC 3161 et journal append-only public : absents. Le mot « attestation » reste proscrit.
- Taux d'erreur sur jeu annoté de 500 dépôts : absent. Aucun chiffre de fiabilité publiable.

---

## 5 · Registre des défauts

| phase | défaut | direction | sévérité |
|---|---|---|---|
| I | fail-open composé L70/L146 | sur-affirmation | catastrophique |
| II | hash figé, clé dans le dépôt, vocabulaire | sur-affirmation | élevée |
| III | faux ALLOW sur manifestes partiels | sur-affirmation | catastrophique |
| V | plafond de sonde 2 Mo vs 2 240 125 octets | sous-affirmation | modérée |
| I9 | deps_queried compté comme répondu | sur-affirmation | élevée |
| I10 | dénominateur dérivé du parseur (PEP 440) | sur-affirmation | catastrophique |

**Six défauts, cinq vers la sur-affirmation.** Le biais était structurel. Il est corrigé en rendant pessimiste chaque entrée de porte, pas en chassant une instance de plus.

---

## 6 · Actifs transférables (ARO v3.3)

- GATE_INPUTS + auditGateInputs : défaut pessimiste exigé sur chaque entrée de porte.
- Contrôles négatifs avec mutant, baseline rouge en commit séparé (C-01..C-30).
- I6 complétude : ratio sur fermeture transitive, lockfile exigé pour ALLOW.
- I7 décomposition exacte : aucune chute anonyme, somme = passCoverage.
- I8 bande de sanity : sortie hors bande → HOLD_suspect_gate, pas publication.
- I9 interrogé ≠ répondu : deps_answered distinct de deps_queried.
- I10 dénominateur indépendant : comptage structurel du fichier, pas du parseur.
- Origine des causes : probe vs repo, une limite d'examen n'est pas une propriété.

Ces huit éléments sont le rendement principal de la phase d'endurcissement. Ils sont indépendants de RepoVerify et directement applicables à des schema gates d'agent.

---

## 7 · Suite unique

L'endurcissement est **arrêté**. Il n'y a pas de phase VI. Le seul blocage est opérationnel :

```bash
# HAS_GITHUB_TOKEN=false — anonyme : 60 req/h, ~6 800 appels, 113 h
export GITHUB_TOKEN=ghp_...   # read-only, aucun scope pour du public
node scripts/scan-corpus.mjs --limit=500 --cohort=2026-11-18-full --expect-band=5:40
```

Bande attendue `5:40`, ~14 verified. Au-delà de 40 : `HOLD_suspect_gate`: suspecter une porte écrite PASS par défaut, un plafond non appliqué, ou une jointure qui double. Pas se réjouir.

---

## 8 · Contrôle de clôture

```
C-26  I10 · dénominateur        PROBANT
C-27  I10 · PEP 440             PROBANT
C-28  I10 · sources locales     PROBANT
C-29  I10 · format illisible    PROBANT
C-30  I10 · plafond appliqué    PROBANT
```

```
F-01  PASS  uv.lock observé · 182 blocs, 1 editable, 181 externes
F-02  PASS  uv.lock sans PEP 440 · le parseur semver en droppe 14
F-03  PASS  Cargo.lock · membre workspace sans source = local
F-04  PASS  package-lock v3 · racine + link + file: exclus
F-05  PASS  pnpm v9 · resolution directory = local
F-06  PASS  go.sum · déduplication /go.mod, pseudo-version acceptée
F-07  PASS  bun.lockb · binaire → FORMAT_UNPARSEABLE, jamais zéro
F-08  PASS  JSON corrompu → structure non reconnue, pas zéro
```

**Empreinte de clôture :** `fe2eccc05d34fb4693bd723739e72bdec08d60658a39598e2a24934aa3fd6207`

*Généré localement. Aucune requête sortante. Le code source des dépôts indexés n'a pas été lu.*
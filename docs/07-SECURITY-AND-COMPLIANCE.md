# 07-SECURITY-AND-COMPLIANCE : Sécurité Shift-Left & Conformité Européenne — GitArena

## 1. Cadre Réglementaire Européen & Souveraineté

| Réglementation | Exigence Concrète | Implémentation dans GitArena |
| :--- | :--- | :--- |
| **RGPD Art. 32** | Sécurité et minimisation des données | Aucune collecte de données personnelles nominatives. Les empreintes de vote sont hachées en SHA-256 avec sel éphémère (`SHA256(IP + UserAgent + Salt)`), interdisant toute ré-identification. |
| **DORA (Règlement UE 2022/2554)** | Résilience opérationnelle numérique | Architecture déconnectable hors-cloud (Zero-Cloud). Fonctionnement 100% autonome sur base de données SQLite WAL locale sans dépendance à des APIs SaaS tierces. |
| **NIS 2 (Directive UE 2022/2555)** | Sécurité des réseaux et systèmes | Zéro port d'écoute externe non sollicité, liaison par défaut sur `127.0.0.1` ou reverse-proxy TLS strict, élimination des attaques par déni de service via rate-limiting in-memory. |
| **AI Act Art. 50 (UE 2024/1689)** | Transparence des corpus et licences d'IA | Traçabilité des licences logicielles vérifiées (`SPDX`) conforme BigCode The Stack v2 : exclusion formelle des dépôts copyleft (`GPL`/`AGPL`) pour l'entraînement d'IA. |

---

## 2. Modèle de Menaces STRIDE & Contre-Mesures

1. **Spoofing (Usurpation d'identité)** :
   - *Menace* : Injection de faux votes de duels par des bots pour gonfler artificiellement le rang ELO d'un dépôt.
   - *Contre-mesure* : Empreinte de navigateur non réversible + limitation stricte de cadence (Rate-Limiter : max 1 vote par IP par duel toutes les 60 secondes).
2. **Tampering (Altération de données)** :
   - *Menace* : Falsification des scores IA ou des résultats de tests unitaires.
   - *Contre-mesure* : Scellement de chaque exécution de test par empreinte cryptographique BLAKE3/SHA-256 immuable dans la table `harness_runs`.
3. **Repudiation (Répudiation)** :
   - *Menace* : Contestation de l'intégrité d'un résultat d'arène.
   - *Contre-mesure* : Journalisation immuable des variations ELO (`arena_duels`) avec horodatage déterministe.
4. **Information Disclosure (Fuite d'informations)** :
   - *Menace* : Exfiltration de variables d'environnement ou chemins sensibles du serveur.
   - *Contre-mesure* : Aucune clé secrète stockée dans le code ; isolation des répertoires statiques via vérification stricte de chemin (`path.normalize` interdisant les traversées de répertoire `../`).
5. **Denial of Service (Déni de service)** :
   - *Menace* : Saturation de la recherche FTS5 par requêtes malicieuses ou expressions régulières explosives (ReDoS).
   - *Contre-mesure* : Sanitization des requêtes de recherche FTS5 (échappement des caractères spéciaux) et plafond de limite de résultats (`LIMIT 100`).
6. **Elevation of Privilege (Élévation de privilèges)** :
   - *Menace* : Exécution arbitraire de commandes système via les noms de dépôts ou de branches.
   - *Contre-mesure* : Validation par expression régulière stricte `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$` sur tous les identifiants de dépôts.

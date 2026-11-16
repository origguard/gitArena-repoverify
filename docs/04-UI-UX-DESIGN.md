# 04-UI-UX-DESIGN : Cahier des Charges Visuel & Design Tokens — GitArena

## 1. Direction Artistique : "Cyber-Industrial Terminal"
L'interface de GitArena s'inspire des consoles de monitoring aérospatiales, des terminaux haute fréquence et des outils d'ingénierie d'élite (style Vercel, Linear, Bloomberg Terminal). Elle projette la précision, la vitesse et l'autorité factuelle : zéro fioriture superflue, typographie nette, contrastes certifiés WCAG AAA.

---

## 2. Jetons de Couleurs (Design Tokens)

```css
:root {
  /* Palette de Base (Dark Surface) */
  --bg-primary: #0a0b0e;        /* Fond d'écran principal ultra-sombre */
  --bg-surface: #12151c;        /* Surface des cartes et panneaux */
  --bg-elevated: #1a1e28;       /* Panneaux surélevés, modals, barres d'outils */
  --border-subtle: #242938;     /* Bordures structurelles légères */
  --border-strong: #3b4256;     /* Bordures actives ou focalisées */

  /* Typographie & Contraste */
  --text-main: #f0f2f5;         /* Texte principal haute lisibilité (Ratio > 12:1) */
  --text-muted: #8b949e;        /* Métadonnées, labels secondaires (Ratio > 4.5:1) */
  --text-dim: #545d68;          /* Séparateurs, texte inactif */

  /* Accents Fonctionnels */
  --accent-success: #00ff88;    /* Vert Terminal / Code de Sortie 0 / Vainqueur */
  --accent-success-glow: rgba(0, 255, 136, 0.15);
  --accent-danger: #ff3366;     /* Rouge Confrontation Arène / Alerte */
  --accent-danger-glow: rgba(255, 51, 102, 0.15);
  --accent-primary: #38bdf8;    /* Bleu Cyan / Actions principales / Liens */
  --accent-primary-glow: rgba(56, 189, 248, 0.15);
  --accent-warning: #f59e0b;    /* Orange avertissement / Licences copyleft */

  /* Rayons & Élévation */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;
  --shadow-card: 0 4px 20px rgba(0, 0, 0, 0.4);
  --shadow-glow: 0 0 25px var(--accent-success-glow);
}
```

---

## 3. Typographie

- **Titres et Interface** : Famille système ultra-nette `Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- **Condensats, Métriques & Code** : Famille monospace technique `JetBrains Mono, 'Fira Code', 'Cascadia Code', Consolas, monospace`.
- **Hiérarchie d'Échelle** :
  - `Hero Title` : `2.5rem` (`40px`), graisse `800`, interligne `1.2`.
  - `Section Title` : `1.5rem` (`24px`), graisse `700`, interligne `1.3`.
  - `Card Header` : `1.125rem` (`18px`), graisse `600`, interligne `1.4`.
  - `Body Standard` : `0.9375rem` (`15px`), graisse `400`, interligne `1.6`.
  - `Badge / Label` : `0.75rem` (`12px`), graisse `600`, espacement `0.05em`, majuscules.

---

## 4. Points de Rupture Responsives (Breakpoints)

- **Mobile First** :
  - `sm` : `375px` (Mobiles étroits, colonnes uniques, navigation collapsible).
  - `md` : `768px` (Tablettes et mobiles larges, grille 2 colonnes pour les duels).
  - `lg` : `1024px` (Ordinateurs portables, dashboard complet, panneau de filtre latéral).
  - `xl` : `1440px` (Écrans larges, affichage étendu sur 3 colonnes avec télémesure live).

---

## 5. Spécifications des Composants Clés

### Le Duel Fighter Card
- Encadrement à bordure dynamique (`--border-subtle` passant à `--accent-primary` au survol).
- Badge ELO en haut à droite avec indication de tendance (+/- 16 pts).
- Bouton de vote avec effet d'onde et réaction haptique visuelle en CSS.

### La Console de Télémétrie en Direct
- Aspect écran terminal rétro-éclairé noir mat (`#060709`).
- Lignes de logs avec horodatage en millisecondes et coloration syntaxique (Vert pour `PASS`, Cyan pour `RUN`, Rouge pour `FAIL`).

### Le Badge "Harness Verified"
- Composant SVG pur rendu à la volée.
- Côté gauche : Logo GitArena en gris foncé `#1f242d`.
- Côté droit : Statut vert néon `#00ff88` avec texte `Verified pass@k: 99.8%`.

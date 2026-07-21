# Plan d'amélioration — latoile MCP

Observations concrètes tirées d'une utilisation réelle de `mcp__latoile__get_context` pendant
l'investigation et l'implémentation de PV2-18006 (Prescription). Objectif : rendre latoile
directement utile pour *implémenter des features / corriger des bugs*, pas seulement pour
afficher joliment un ticket Jira.

## 1. L'enrichissement GitLab (merge_requests / repositories) est resté vide alors qu'il existait clairement du code lié

En appelant `get_context("PV2-18006")`, le ticket lié `PV2-17843` (Done, QA passé) avait
`merge_requests: []` et `repositories: []` malgré le fait que le code source du dépôt
`Prescription` contenait un commentaire explicite référençant PV2-17843 et PV2-17313
(`useQuickBatchRenew.tsx:143-144`). Le lien Jira → code existe (les devs le citent dans leurs
commits/commentaires) mais latoile ne l'a pas retrouvé.

**Pourquoi c'est le point le plus important** : quand on implémente une feature liée à un ticket
« Done » précédent, la première question est toujours « qu'est-ce qui a été codé pour ça ? ».
Si latoile ne répond pas à cette question, l'agent doit refaire une recherche manuelle complète
dans le repo (grep, lecture de fichiers) — ce qui est exactement le travail que `get_context`
devrait éviter.

**Piste** : vérifier la stratégie de matching Jira↔GitLab (regex sur le numéro de ticket dans les
messages de commit / titres de MR / branches). Si le matching dépend uniquement des MR encore
ouvertes ou d'un champ spécifique, ça expliquerait le vide pour un ticket déjà mergé et fermé.

## 2. Aucun signal indiquant si la traversée du graphe est complète ou tronquée

`get_context` a des paramètres `maxDepth` (défaut 1) et `maxNodes` (défaut 50), mais la réponse
ne dit jamais si la limite a été atteinte. Résultat : impossible de savoir si l'absence de
liens (voir point 1) est un vrai vide ou un troncage silencieux dû à `maxDepth=1`.

**Piste** : ajouter un champ `traversal: { depthReached, nodesFetched, truncated: boolean }` dans
la réponse. Ça permettrait à l'agent de décider automatiquement de relancer avec `maxDepth`/
`maxNodes` plus élevés au lieu de conclure à tort qu'il n'y a « rien à trouver ».

## 3. Rédaction incohérente dans les commentaires retournés

Le commentaire de Bruno Parent Pichette sur PV2-18006 est retourné comme :
> « Une discussion a eu lieu entre , , et . La réalisation... »

Les noms des participants ont disparu (probablement une anonymisation/redaction appliquée côté
source Jira ou côté latoile), mais la ponctuation reste (virgules, « et »), ce qui rend la phrase
illisible et fait perdre une info potentiellement utile (qui a été consulté sur la décision).

**Piste** : soit ne pas tronquer les noms (s'ils sont légitimement visibles dans Jira), soit
nettoyer proprement la phrase quand une redaction est appliquée, plutôt que de laisser des trous.

## 4. Priorité proposée

1. **Corriger l'enrichissement GitLab manquant** (point 1) — c'est le cœur de la valeur ajoutée
   de latoile pour une tâche d'implémentation ; sans ça, l'outil ne fait gagner du temps que sur
   la lecture de métadonnées Jira, pas sur la compréhension du code existant.
2. **Signal de troncage** (point 2) — nécessaire pour interpréter correctement le point 1 et
   éviter les faux négatifs silencieux.
3. **Nettoyage des commentaires redactés** (point 3) — cosmétique mais impacte la confiance dans
   les données retournées.

Ne pas ajouter de nouvelle surface d'API (nouveaux tools, nouveaux filtres) tant que le lien
Jira↔code — la fonctionnalité la plus basique et la plus utile — n'est pas fiable.

## 4bis. Résolution (Claude, 2026-07-21) — cause réelle du point 1

Diagnostic (lecture seule) sur PV2-17843 : **ni le court-circuit `hasGitlabData`, ni
le regex `in=title` n'étaient en cause.**

- `customfield_10000` de PV2-17843 a `repository.count=2` → `parseDevInfoHint` renvoie
  `true` → `hasGitlabData=true`. Le court-circuit **n'a jamais joué** ; la recherche
  GitLab a bien tourné.
- Les 4 MR réelles portent la clé **dans le titre ET la branche** (ex.
  `Prescription!6615`, branche `PV2-17843-2`). La requête projet-scoped exacte de latoile
  (`in=title`) les retrouve. **`in=title` n'est pas le problème.**
- Vraie cause : **résolution des projets** dans `gitlab-http.ts`. `fetchGroupProjects`
  faisait `break` sur toute erreur d'API (gitlab.com time-out par intermittence sur ces
  endpoints groupe), et `resolveProjects` **mettait en cache la liste partielle/vide pour
  toute la vie du process**. Dans un process MCP/serveur long, un seul time-out transitoire
  à la première résolution désactivait silencieusement l'enrichissement GitLab pour toutes
  les clés suivantes — exactement le symptôme observé.

**Correctif livré** : retry par page, distinction « scan complet » vs « scan dégradé », et
on ne met en cache qu'un scan complet (drapeau `lastResolutionDegraded` sinon). Vérifié en
live : PV2-17843 renvoie désormais ses 4 MR / 4 dépôts. Le point 2 (signal de troncage) est
aussi livré sous forme d'un bloc `traversal` sur le payload. Point 3 non traité (reporté).

## 5. Revue (Claude, 2026-07-15)

Priorisation et discipline « pas de nouvelle surface d'API » jugées correctes. Points ajoutés
suite à discussion :

- **Point 1 — creuser avant de toucher au regex de matching.** `acli.ts` dérive `hasGitlabData`
  du dev-status Jira (`customfield_10000`) ; quand Jira répond `false`, la traversée **saute
  complètement** la recherche GitLab (elle n'essaie même pas le matching branche/titre/commit).
  Avant de suspecter le regex, vérifier le `customfield_10000` brut de PV2-17843 : si Jira n'avait
  jamais lié de repo à ce ticket, le vrai correctif est « ne pas faire confiance aveuglément au
  hint de dev-status » plutôt qu'un fix de regex — portée différente, plus large.
  Autre limite à documenter dans le plan : le matching ne scanne que messages de commit /
  titres de MR / noms de branche, jamais le contenu des fichiers sources. Une citation dans un
  commentaire de code ne sera jamais trouvée même avec un matching parfait, sauf si le commit
  associé référence aussi le ticket dans son message — à traiter comme hors-scope du fix actuel,
  pas comme un bug à corriger dans la même passe.
- **Gap à combler avant de coder** : constituer un petit set de repro (2-3 tickets « Done, code
  clairement lié, GitLab vide ») pour confirmer si la cause est le court-circuit `hasGitlabData`
  ou un vrai miss de regex — ce sont deux correctifs différents.
- **Point 2 — bon rapport valeur/coût.** `traversal.ts` a déjà le bookkeeping (visited set,
  compteurs) nécessaire ; exposer `depthReached`/`nodesFetched`/`truncated` est surtout de la
  plomberie, pas de nouveaux appels réseau.
- **Point 3 — d'accord pour la dépriorisation.** Réel mais cosmétique, et dépend d'une politique
  de redaction en amont hors du contrôle de latoile.

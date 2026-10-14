# Roadmap de Nub-IA

Plan de mejoras acordado sobre el estado actual del fork (review 4R en proceso, router por tier, rtk, guardrails,
gate de push). Cada tarea apunta a una PR propia (≤ ~400 líneas; las marcadas *grande* se parten). El orden de fases
es por valor y dependencias; dentro de una fase las tareas sin dependencia declarada son independientes.

Orden sugerido: **F0 → F6 → F1 → F7 → F2 → F8 → F3 → F4 → F5.**

Estado: `[ ]` pendiente · `[~]` en curso · `[x]` hecho.

---

## Fase 0 — Base de medición

Prerrequisito de F1, F2.2, F3.2 y F3.3.

- [x] **T0.1 Fixtures de review con diffs reales**
  `tests/fixtures/review/<caso>/{diff.patch, expectations.json, answers/<lente>.txt}`, `lib/nub-review-fixtures.ts`,
  `tests/nub-review-fixtures.test.ts`. Cinco casos (SQL por concatenación, secreto hardcodeado, fetch sin fallback,
  `test.only` + código muerto, refactor limpio) con `mustFlag`/`mustNotFlag` por lente y veredicto esperado; las
  respuestas grabadas pasan por el mismo parser que la extensión. `prompt-pins.json` fija el hash del prompt de cada
  lente: editar un `assets/agents/review-*.md` rompe el test hasta re-validar los fixtures contra los modelos reales
  (T1.7) y actualizar el pin. *Hecho:* 4 lentes × ≥ 3 casos, con al menos un positivo y un negativo cada uno.
- [x] **T0.2 Esquema de métricas de review**
  `lib/nub-review-metrics.ts` + `lib/nub-review-metrics-schema.json` (`nub-ia.review-metrics/v1`): una fila `verdict`
  por corrida (veredicto, tamaño, duración, por lente: modelo normalizado, ok/failed, hallazgos, descartados, duración) y
  una fila `finding` por hallazgo (lente, severidad, modelo, located, hasSuggestion). Sin rutas, claims ni diff. Archivo
  propio `metrics/review-<AAAA-MM>.jsonl` vía `appendMetricRows("review", …)` en el sink generalizado; mismo
  interruptor `NUB_IA_METRICS=off`. Emitido best-effort desde `extensions/nub-ia-review.ts`. Documentado en
  `docs/telemetry.md`.

## Fase 1 — Review 4R: profundidad

- [x] **T1.1 Chunking de diffs grandes**
  `lib/nub-review.ts`: `splitDiffByFile`, `splitDiff` (empaqueta archivos enteros bajo `DIFF_MAX_BYTES`; un archivo
  mayor se parte por hunk repitiendo el header; un hunk solo mayor queda entero), `mergeLensResults` (concatena
  hallazgos, suma descartados, un fallo en cualquier chunk marca el lente como fallido). `DIFF_TOTAL_MAX_BYTES` = 8×
  como tope duro. `extensions/nub-ia-review.ts`: lentes × chunks con `LENS_CONCURRENCY = 4`; un reporte, un hash.
- [x] **T1.2 Contexto de repo para los lentes**
  Sin bucle de herramientas (determinista, sin nueva superficie de inyección): `touchedFiles`, `collectContext` (con
  `CONTEXT_BUDGET` 8 archivos / 24 KiB / 96 KiB y `isSafeRepoPath`) y `renderContext` en `lib/nub-review.ts`; la
  extensión lee índice / `HEAD` / working tree según el alcance y anexa el bloque dentro del fence del diff, un bloque
  por chunk. La instrucción va en el mensaje de usuario, así los prompt pins no cambian. Fixture
  `signature-change-callers` (hallazgo solo visible con contexto).
- [x] **T1.3 Reglas de proyecto**
  `loadProjectRules` (`.pi/nub-ia/review-rules.md` > `AGENTS.md`, 16 KiB, truncado con marcador) y
  `renderProjectRules` en `lib/nub-review.ts`; anexado al mensaje de usuario de cada lente como datos (los prompt pins
  no cambian). Fixture `project-rule-violation` (WARNINGs que solo salen de las reglas del repo). README actualizado.
- [x] **T1.4 `/nubia:review fix` — cerrar el ciclo**
  No lanza un hijo directamente (`jd-fix-agent` exige la forma de dispatch de Judgment Day): compone un brief con los
  severos del `last-review.json` (`fixBrief`), confirma con el humano, marca la línea (`fixRounds`, `fixPending`) y lo
  entrega al orquestador con `pi.sendUserMessage`, que implementa por su ruta ordinaria y vuelve a correr `nub_review`.
  Tope `FIX_ROUNDS_MAX = 2`; el re-chequeo enlaza al reporte anterior (`- Previous:`).
- [x] **T1.5 Modo headless/CI y salida JSON**
  `nub-ia review [--base <ref>|--staged|--working] [--json] [--fail-on block|warn|never]` (comando del launcher, como
  `setup`): arranca `pi -p --no-session` con los argumentos en `NUB_IA_REVIEW_HEADLESS`; la extensión los toma en
  `session_start` (solo sin UI), imprime y sale 0/1/2 (`headlessExitCode`; INCOMPLETE siempre falla). `reportToJson`
  (`nub-ia.review-report/v1`). Probado end-to-end con el home aislado; `docs/review-ci.md` con job de GitHub Actions.
- [x] **T1.6 Publicar reporte en el PR**
  `prCommentBody` (marker `<!-- nub-ia-review -->`, tope 60 KiB) y `publishPrComment(gh, …)` (busca el comentario con
  marker vía `gh pr view --json comments`, lo edita por id con `gh api PATCH`, si no crea con `gh pr comment
  --body-file -`). `/nubia:review --pr` con confirmación; `nub-ia review --pr` en CI. `gh` se invoca con `execFile`
  y stdin, nunca por shell. Documentado en `docs/review-ci.md`.
- [x] **T1.7 Calibración (herramientas)**
  `lib/nub-review-calibration.ts`: `parseMetricRows`, `calibrate` (por lente: corridas, fallos, hallazgos por severidad,
  descartados, duración media, modelos) y `renderCalibration` con avisos (sobre-severo > 1.5 B/C por corrida; falla
  > 20 %). `/nubia:review stats` lo muestra; `/nubia:review eval` corre los fixtures contra los lentes reales y
  propone los prompt pins. *Pendiente con datos reales:* el informe con tasas por lente y los ajustes de prompts; no
  hay señal de "hallazgo aceptado/descartado" todavía (requeriría feedback explícito del usuario, fuera de alcance).

## Fase 2 — Router de modelos

- [x] **T2.1 Estado del router en `/nubia:status`**
  `lib/router-status-model.ts`: `RouterJournal` (modelo resuelto por tier, providers excluidos con causa clasificada
  — rate limit / overloaded / server error / timeout / auth / network — y hora, tiers sin modelo), canal
  `nubia:router-status/v1`, `routerStatusLines`. Bloque "Router" en Status (toggle `modelDetails`). El texto del error
  nunca sale del router.
- [x] **T2.2 Presupuesto por sesión/día**
  `lib/model-tier-budget.ts`: `parseBudget`, `tightestBudget` (repo solo endurece), `budgetState`, `effectiveTier`
  (`strong`/`strong-alt` → `balanced` → `fast`), ledger diario `metrics/spend-<fecha>.json`, `describeBudget`.
  `model-tiers.json` acepta `budget`; el router suma `usage.cost.total` de cada mensaje del asistente, degrada en
  `route()` cuando corresponde, avisa una vez por límite cruzado y publica la línea en el bloque Router. Se usó el gasto
  que calcula Pi en lugar de reconstruirlo desde los tokens del JSONL (sin dependencia de T0.2).
- [x] **T2.3 Doctor de modelos**
  `tierDoctorLines(available, catalog)` en `lib/model-tier-router.ts` (providers con credenciales; por tier pass /
  warn "solo fallback, actualizá los patrones" / fail; línea de budget), expuesto como `routerDoctorLines(ctx)` y
  sumado a `/nubia:doctor` (una línea en el handler del harness). No se agregó un flag al CLI: el doctor de la shell
  es donde ya vive el diagnóstico.

## Fase 3 — Equipo y onboarding

- [ ] **T3.1 Perfil por repo (`.pi/nub-ia/profile.json`)**
  Persona, tier por defecto, skills activas, review-gate; precedencia "solo endurece" como `review-gate.json`.
  *Cierre:* un clon con profile arranca configurado; test de precedencia.
- [ ] **T3.2 `/nubia:usage --month` y agregador CLI**
  `lib/runtime-metrics-report.ts` (nuevo): costo/tokens por agente, tier, persona, día; `nub-ia usage [--month] [--json]`.
  *Cierre:* lee los JSONL existentes; cero dependencias nuevas.
- [ ] **T3.3 Sink de métricas de equipo (opt-in)**
  `NUB_IA_METRICS_ENDPOINT` + token; envío por lote, sin PII, apagado por defecto. *Cierre:* `docs/telemetry.md` lista
  los campos que salen; test de redacción. Depende de T7.5.
- [ ] **T3.4 Catálogo de skills Nubiral**
  `skills/nubia-aws/`, `skills/nubia-terraform/`, `skills/nubia-bedrock/` (ajustar a los stacks reales). *Cierre:* pasan
  `skill-registry`; frontmatter válido; ≤ 150 líneas cada una.

## Fase 4 — Mantenibilidad del fork

- [ ] **T4.1 Separar código propio de código upstream** *(grande)*
  Mover lógica Nub-IA de `extensions/nubia-harness.ts` / `nubia-shell.ts` a módulos `lib/nubia-*.ts`; los archivos
  upstream quedan con hooks mínimos. *Cierre:* `git diff upstream/main -- extensions/…` baja significativamente; tests
  verdes. Hacer primero dentro de la fase.
- [ ] **T4.2 Workflow de sincronización con upstream**
  `.github/workflows/upstream-sync.yml`: semanal, `fetch upstream` + merge en `sync/upstream-<fecha>`; abre PR o issue
  con conflictos. *Cierre:* dry-run exitoso.
- [ ] **T4.3 Verificación de integridad en `nub-ia update`**
  `git verify-commit` contra llaves en `assets/maintainers.gpg`; `NUB_IA_SKIP_VERIFY=1` como escape. *Cierre:* update
  rechaza HEAD no firmado; se documenta el límite que se cierra.
- [ ] **T4.4 Bump automático de rtk y ponytail**
  `.github/workflows/pin-bumps.yml`: detecta release, recalcula SHA-256 por plataforma y abre PR; ídem versión de
  ponytail en `lib/nubia-launcher.ts`. *Cierre:* PR generado con digests verificados.

## Fase 5 — Pulido

- [ ] **T5.1 `/nubia:doctor` ampliado**
  rtk presente, tiers resolubles (T2.3), gate activo, política efectiva (T8.1), checkout vs `origin/main`.
- [ ] **T5.2 Política de idioma**
  `docs/CONTRIBUTING.md`: README/docs de usuario en español, código/comentarios/docs técnicos en inglés; revisar
  inconsistencias existentes.

## Fase 6 — UI: bloque "Subagentes" en Status

Independiente del resto. Hacer antes de T7.10 (comparten el bloque de Status).

- [x] **T6.1 Fuente de datos compartida**
  `lib/agents-status-model.ts`: `agentsStatusPayload(tasks, now)` (conteos + ítems saneados, reusa `widgetTasks` del
  widget Agents existente) publicado por `extensions/nubia-agents.ts` en el canal `pi.events` `nubia:agents-status/v1`
  en cada cambio del store y cada tick del reloj; `parseAgentsStatus` valida del lado de la shell.
- [x] **T6.2 Título resumido de la tarea**
  `taskHeadline(task)`: `label` o primera línea no vacía del prompt, saneada y recortada a 40 caracteres.
  *Pendiente menor:* reforzar en `assets/orchestrator-delegation.md` que `label` sea obligatorio al delegar.
- [x] **T6.3 Render en Status**
  `ShellBarModel.agents` + bloque "Subagents" entre Review e Integrations (`◐ nubia-worker · "título" · 2m04s`, máx. 3
  filas + `+N more · /nubia:agents`). Comparte el toggle `agents` de `/nubia:customize` con el widget Agents (sin clave
  nueva ni migración). Tests de render y de ancho angosto en `tests/shell-bar.test.ts`.
- [x] **T6.4 Refresco en vivo**
  Sin reloj nuevo: la shell calcula el tiempo transcurrido al pintar y el `tickClock` del widget Agents ya pide un frame
  por segundo mientras hay tareas y uno más cuando expira la última terminada.

## Fase 7 — Permisos

### Modos de permiso

| Modo | read / bash read-only | write / edit | bash mutante | commit / push / PR | guardrails y data-loss |
| --- | --- | --- | --- | --- | --- |
| **Plan** | ✔ | ✖ (directiva: solo analizar y proponer) | ✖ | ✖ | — |
| **Manual** | ✔ | pregunta | pregunta | pregunta | siempre |
| **Accept edits** | ✔ | auto (dentro del repo, fuera de `paths.confirm/deny`) | pregunta | pregunta | siempre |
| **Auto** | ✔ | auto | auto salvo guardados | pregunta | siempre |
| **YOLO** | ✔ | auto | auto | auto (comportamiento actual) | siempre |

Invariantes: guardrails `confirm`/`block`, frontera de pérdida de datos y `ask_user*` no se eximen en ningún modo. La
política org/repo puede fijar `maxMode`. Los hijos heredan como mucho el modo del padre y nunca YOLO. YOLO nunca se
persiste ni se activa por config/env/tool.

- [ ] **T7.6 Máquina de modos (`lib/permission-mode-policy.ts`)**
  `PERMISSION_MODE`, orden, `next(mode, maxMode)`, `decide({ mode, tool, args, cwd, pathPolicy, guardDecision }) →
  allow|ask|deny`. Envuelve `YoloSessionPolicy` (entrar a `yolo` = `set(true, identity)` con sus requisitos; salir lo
  revoca; `/nubia:yolo` sigue como alias). Modo por defecto al arrancar (`plan|manual|accept-edits|auto`) en
  `~/.nub-ia/config.json`; reload/sesión nueva vuelve al default. *Cierre:* tests de tabla de decisión (5 modos × tipos
  de tool), `maxMode`, YOLO falla cerrado, herencia a hijos.
- [ ] **T7.7 Interceptor de herramientas**
  `extensions/nubia-harness.ts`: en `tool_call` consultar `decide()` para `write`/`edit`/`bash`/`subagent_run`; `ask`
  reutiliza el widget de confirmación del guard de bash (con recordatorio "Shift+Tab cambia de modo"); `deny` devuelve
  al modelo el modo actual y que pida el cambio al humano (nunca una tool). Clasificación bash read-only: lista blanca
  conservadora; `>`/`>>`/`tee`/`rm`/`mv`/`git push` degradan a mutante; lo no reconocido = mutante. *Cierre:* tests con
  comandos compuestos, subshells y redirecciones; nunca clasificar como read-only algo que escribe. Depende de T7.6.
- [ ] **T7.8 Directiva de sistema por modo**
  `appendSystemPromptOnce` con bloque `<nubia-permission-mode>` por modo (análogo a `YOLO_DIRECTIVE`), reemplazado al
  cambiar de modo con epoch. *Cierre:* test de una sola directiva activa a la vez. Depende de T7.7.
- [ ] **T7.9 Shift+Tab y comando**
  Atajo `nubia.cycleMode` (default `shift+tab`) en `KeybindingsManager` con prioridad de shortcut; verificar colisión con
  Pi y entrega de `ESC [ Z` en Windows Terminal, iTerm, kitty, tmux; rebindeable. Ciclo Plan → Manual → Accept edits →
  Auto → (YOLO si permitido) → Plan; entrar a YOLO por ciclo pide Enter (Escape lo salta). `/nubia:mode
  [plan|manual|accept-edits|auto|yolo|status]` y entrada en `/nubia:customize` → Editor. *Cierre:* test de ciclo con
  `maxMode`; el atajo no roba Tab ni autocompletado. Depende de T7.8.
- [ ] **T7.10 Indicador en UI**
  Footer: chip `⏸ Plan` / `✋ Manual` / `✎ Accept edits` / `▶ Auto` / `🚀 YOLO` con tono por modo (reemplaza el widget
  YOLO cuando aplica). Status: fila "Modo" junto a "Review" y "Subagentes", con `(máx: … · org)` si hay tope.
  `assets/orchestrator*.md`: el modo lo controla el humano. `docs/permission-modes.md` nuevo; `docs/yolo-mode.md` lo
  presenta como 5.º modo. *Cierre:* snapshot del footer/status en los 5 modos; ancho angosto. Depende de T6.3, T7.9.

### Políticas que alimentan los modos

- [ ] **T7.1 Permisos por ruta**
  `runtime-guardrails.json` → `paths: { readOnly, confirm, deny }` (globs: `.github/**`, `infra/**`, `*.lock`, `.env*`).
  `lib/path-permission-policy.ts` (nuevo), aplicado en `write`/`edit`/`bash` (redirecciones, `rm`/`mv`). Repo solo
  endurece; YOLO no exime `confirm`/`deny`. *Cierre:* tests de precedencia; bloqueo de `write` sobre `deny`. Depende de
  T7.6.
- [ ] **T7.2 Permisos por agente/herramienta**
  `runtime-guardrails.json` → `agents: { "nubia-explore": { tools: { write: "deny", bash: "confirm" } }, … }`;
  `extensions/nubia-agents.ts` aplica la política al lanzar el hijo (gana sobre el frontmatter si es más estricta).
  *Cierre:* `nubia-explore` que intenta `write` recibe rechazo y el padre el evento. Depende de T7.6.
- [ ] **T7.3 Allowlist de providers/modelos por repo**
  `.pi/nub-ia/model-tiers.json` → `allowedProviders` / `deniedModels`, respetados también para `/model` manual.
  *Cierre:* `/model` con provider denegado muestra motivo; test en `model-tier-router`.
- [ ] **T7.4 Límites de delegación y gasto**
  `limits: { maxConcurrentSubagents, maxSubagentsPerTurn, maxUsdPerSession }`. *Cierre:* al exceder, error claro al
  orquestador y reflejo en Status (T6.3). Depende de T2.2.
- [ ] **T7.5 Redacción de secretos**
  `lib/secret-redaction.ts` (nuevo): AWS keys, tokens GitHub, JWT, valores de `.env`; aplicado a salida de bash,
  reportes de review, métricas e historial de prompts. *Cierre:* fixtures redactados; hashes git intactos.

## Fase 8 — Gobernanza

- [ ] **T8.1 Política de organización centralizada**
  `~/.pi/nub-ia/org-policy.json` apuntando a `NUB_IA_ORG_POLICY=git:…`; `nub-ia update` la refresca. Precedencia
  **org > repo > usuario**, siempre "solo endurecer". Unifica guardrails, review-gate, allowlist de providers, skills
  aprobadas, `maxMode` y modo por defecto. *Cierre:* tests de merge de tres niveles; `/nubia:status` muestra la fuente
  de cada ajuste bloqueado. Depende de T7.1–T7.3, T7.6.
- [ ] **T8.2 Roles**
  `roles: { developer, lead }` + `NUB_IA_ROLE` o `git config user.email`. Un `lead` puede relajar el gate a `confirm`;
  un `developer` no. *Cierre:* test de rol; el cambio de rol se audita (T8.4). Depende de T8.1.
- [ ] **T8.3 Skills y paquetes aprobados**
  `approvedPackages` / `approvedSkillSources`; `nub-ia install` y la carga de skills avisan (`warn`, default) o rechazan
  (`enforce`). Hash del SKILL.md al instalar, aviso si cambia. *Cierre:* instalación fuera de lista rechazada con
  mensaje; tests. Depende de T8.1.
- [ ] **T8.4 Auditoría local**
  `~/.pi/nub-ia/audit/<YYYY-MM>.jsonl`: confirmaciones aceptadas/rechazadas, bloqueos, overrides del gate, cambios de
  modo, pushes con/sin review, delegaciones que exceden límites. Sin prompts; comando redactado. `nub-ia audit
  [--month] [--json]`; bloque opcional en Status. Opt-in de envío al endpoint de T3.3. *Cierre:* esquema en
  `docs/governance.md`; permisos 0600/0700.
- [ ] **T8.5 Firma e integridad de políticas**
  Políticas de org verificadas con la infraestructura de T4.3; una no firmada se ignora con aviso y nunca relaja nada.
  *Cierre:* test con política manipulada. Depende de T4.3, T8.1.
- [ ] **T8.6 Documentación de gobernanza**
  `docs/governance.md`: precedencia, roles, modos y `maxMode`, qué se audita, cómo pedir excepciones; `/nubia:doctor`
  reporta la política efectiva.

---

## Grafo de dependencias

```
T0.1, T0.2 ──► T1.1 ──► T1.2 ──► T1.3 ──► T1.4
                └──────► T1.5 ──► T1.6
T0.2 ──► T2.2 ──► T7.4
T0.2 ──► T3.2
T7.5 ──► T3.3
T6.1 ──► T6.2 ──► T6.3 ──► T6.4
T7.6 ──► T7.7 ──► T7.8 ──► T7.9 ──► T7.10 (también depende de T6.3)
T7.6 ──► T7.1, T7.2
T7.1, T7.2, T7.3, T7.6 ──► T8.1 ──► T8.2, T8.3, T8.5
T4.3 ──► T8.5
T2.1, T2.3, T8.1 ──► T5.1
T4.1 primero dentro de F4
```

## Riesgos conocidos

- **Shift+Tab** no llega igual en todos los terminales: `/nubia:mode` es siempre el camino alterno.
- La clasificación read-only de bash es el punto débil de Plan / Accept edits: preferir falsos "mutante" a falsos
  "read-only".
- No romper la garantía de que YOLO no es activable por config/env/tool; el ciclo de teclado es acción humana en TUI
  interactiva y los tests deben cubrirlo.
- T4.1 toca los archivos más grandes del upstream; hacerlo en PRs chicas y antes de cualquier merge grande del upstream.

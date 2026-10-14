# Roadmap de Nub-IA

Plan de mejoras acordado sobre el estado actual del fork (review 4R en proceso, router por tier, rtk, guardrails,
gate de push). Cada tarea apunta a una PR propia (≤ ~400 líneas; las marcadas *grande* se parten). El orden de fases
es por valor y dependencias; dentro de una fase las tareas sin dependencia declarada son independientes.

Orden sugerido: **F0 → F6 → F1 → F7 → F2 → F8 → F3 → F4 → F5.**

Estado: `[ ]` pendiente · `[~]` en curso · `[x]` hecho. **Todas las tareas del plan están cerradas** (ver cada ítem para lo que quedó anotado como seguimiento).

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

- [x] **T3.1 Perfil por repo**
  No se inventó un `profile.json`: persona (`persona.json`), tier/ruteo (`model-tiers.json`), gate (`review-gate.json`),
  modo/paths/agentes/límites (`runtime-guardrails.json`) y reglas de review (`review-rules.md`) ya viven en
  `.pi/nub-ia/` con precedencia "solo endurece". Lo que faltaba era el arranque: `nub-ia init [--no-review-gate]`
  (`scripts/init-repo.mjs`) escribe esos archivos como ejemplos comentados e inertes, sin pisar los existentes.
- [x] **T3.2 `/nubia:usage --month` y agregador CLI**
  `lib/usage-report.ts` (`buildUsageReport`, `renderUsageReport`: tokens por agentClass y provider/modelo, gasto por
  día desde los ledgers, veredictos de review, conteos de auditoría) + `scripts/usage-cli.mjs`; `nub-ia usage
  [--month] [--json]` (vía copia runtime generada) y `/nubia:usage --month`. Las filas runtime no tienen timestamp ni
  costo, por eso el detalle diario sale del ledger de gasto y los tokens quedan por mes.
- [x] **T3.3 Sink de métricas de equipo (opt-in)**
  `lib/team-metrics-sink.ts` (`teamSinkConfig` solo https/localhost, `sanitizeForTeam` quita `repository`,
  `reportPath`, `sessionId`, `cwd`, `path` y redacta strings, `teamBatches` ≤ 64 filas / 256 KiB, `sendTeamBatches`
  best effort sin reintento). Enganchado en `appendMetricRows` para runtime, review y audit. Documentado el campo a
  campo en `docs/telemetry.md`.
- [x] **T3.4 Catálogo de skills Nubiral**
  `skills/nubia-bedrock`, `skills/nubia-terraform`, `skills/nubia-aws` (≤ 50 líneas cada una, estructura de la guía de
  estilo, atadas a los modos de permiso / allowlist / redacción de Nub-IA). Test de frontmatter, orden de secciones y
  tamaño. *Ajustar a los stacks reales del equipo cuando se confirmen* (hoy: AWS/Bedrock/Terraform por el contexto de
  Nubiral).

## Fase 4 — Mantenibilidad del fork

- [x] **T4.1 Separar código propio de código upstream** *(primer corte)*
  Todo lo de Nub-IA en el Status pasó a `lib/nubia-status-blocks.ts` (una clase: suscripción + `model()`); la shell
  upstream quedó con 3 líneas de cableado. Agentes/runner/harness ya solo tienen imports y una llamada cada uno.
  `scripts/upstream-diff.mjs` mide la divergencia real tras normalizar el rename (gentle → nubia): hoy ~6 100 líneas
  en `nubia-harness.ts` porque **upstream avanzó mucho** (105 archivos nuevos allá) — ese es el trabajo de T4.2, no de
  mover código. Hallazgo: upstream agregó su propio `lib/permission-mode-policy.ts` (`normal|auto|yolo`, archivo
  `permission-mode.json`); el default nuestro se renombró a `permission-mode-default.json` para no colisionar, y la
  conciliación de ambos modelos de modos queda anotada para el merge.
- [x] **T4.2 Workflow de sincronización con upstream**
  `.github/workflows/upstream-sync.yml`: lunes 06:17 UTC o manual; `fetch upstream`, `scripts/upstream-diff.mjs`,
  `merge -X find-renames` en `sync/upstream-<fecha>` → PR con el reporte, o issue (creado/actualizado) con los archivos
  en conflicto. Nunca escribe en `main`. YAML validado; la lógica git se probó localmente con el propio repo como
  upstream (behind 0 → "nothing to merge").
- [x] **T4.3 Verificación de integridad en `nub-ia update`**
  `scripts/verify-signature.mjs` (`verifyCommit` con `git verify-commit` + `gpg.format=ssh` +
  `assets/maintainers.allowed_signers`; estados unconfigured/skipped/verified/unsigned/untrusted). Sin llaves listadas
  = apagado (activar es agregar llaves). Tras `git pull`, un HEAD no verificado vuelve al commit anterior con
  `reset --keep`. `NUB_IA_SKIP_VERIFY=1`. Probado con llaves efímeras (test salta si no hay `ssh-keygen`).
- [x] **T4.4 Bump automático de rtk y ponytail**
  `scripts/bump-pins.mjs` (`--check` o reescritura: `RTK_VERSION` + digests de `RTK_ASSETS` desde el `checksums.txt`
  de la release, `RTK_BINARY_SHA256` a `undefined` para re-grabar; pin de ponytail en `lib/nubia-launcher.ts` y README
  desde el registry) + `.github/workflows/pin-bumps.yml` (lunes; re-graba el digest del binario linux-x64, regenera
  runtime, corre la suite y abre PR). Probado en vivo con `--check`: hoy hay rtk 1.0.1 y ponytail 5.2.0 disponibles
  (no se aplicaron en este corte: rtk es un salto de major; decisión para el PR que abra el workflow).

## Fase 5 — Pulido

- [x] **T5.0 System prompt minimal** *(pedido del equipo)*
  `lib/prompt-profile.ts`: perfil `minimal` (default) | `full`, resuelto env > repo (`.pi/nub-ia/prompt-profile.json`)
  > usuario > default; `buildMinimalPrompt` (identidad, persona, idioma, ODD en 8 reglas, líneas de delegación/review
  solo si las tools existen, puntero a la skill `nubia`). Medido: **17 143 → 2 565 bytes (~4 300 → ~640 tokens)**.
  `/nubia:prompt` muestra tamaños por perfil y cambia el guardado. Los tests que afirman el texto completo fijan
  `NUB_IA_PROMPT_PROFILE=full`; `tests/prompt-profile.test.ts` protege el tope (< 3 000 bytes, < ¼ del full). Lo propio
  de Nub-IA (modos, paths, agentes, review, router) no agrega nada al prompt en el modo default.
- [x] **T5.1 `/nubia:doctor` ampliado**
  `lib/nubia-doctor.ts` (`nubiaDoctorLines`): rtk (binario del paquete / PATH / `RTK_DISABLED`), gate de review con su
  origen, modo de permisos inicial y tope con capa, política de org con rol, perfil de prompt, y checkout del paquete
  vs tracking branch (atrasado → "run nub-ia update"). Sumado al handler del doctor junto a los tiers (T2.3).
- [x] **T5.2 Política de idioma**
  `docs/CONTRIBUTING.md`: español para README/docs de uso, inglés para código, prompts, TUI, `--help`, tests, skills y
  commits; regla práctica ("quién lo lee"); checklist de cambios (tests, verify-package-files, runtime modules, prompt
  pins) y mergeabilidad. Las inconsistencias existentes se corrigen al tocar cada archivo, no en un barrido.

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

- [x] **T7.6 Máquina de modos (`lib/permission-mode-policy.ts`)**
  `PERMISSION_MODES` (plan/manual/accept-edits/auto/yolo), `decide()` (tabla por tipo de tool), `classifyBashCommand`
  (lista blanca conservadora), `nextMode` con tope, `childMode` (nunca yolo), directivas de una línea solo en
  plan/manual/accept-edits, default persistible (`permission-mode-default.json`; yolo nunca). Default `auto` =
  comportamiento previo. YOLO sigue siendo el grant de `lib/yolo-session-policy.ts`.
- [x] **T7.7 Interceptor de herramientas**
  `extensions/nubia-permission-mode.ts` (extensión propia, no toca el guard del harness, que sigue corriendo después):
  `tool_call` → `decide()`; `ask` usa `ctx.ui.confirm` con el preview del comando/ruta y emite
  `pi-permission-system:permission-request`; `deny` devuelve al modelo el motivo y "pedile al humano (Shift+Tab o
  /nubia:mode)"; sin UI, `ask` bloquea. `insideRepository` resuelve contra el toplevel de git.
- [x] **T7.8 Directiva de sistema por modo**
  `updateModePrompt` en `before_agent_start` (una sola directiva `<nubia-permission-mode>` a la vez).
- [x] **T7.9 Shift+Tab y comando**
  `registerShortcut("shift+tab")` + `/nubia:mode [modo|status|default <modo>]` (menú sin argumento) + fila en
  `/nubia:customize` → Editor (debajo de YOLO). Pi reserva Shift+Tab para `app.thinking.cycle` y descarta atajos de
  extensión sobre teclas reservadas: el home aislado escribe `keybindings.json` con `"app.thinking.cycle":
  "ctrl+alt+t"` (`scripts/install-keybindings.mjs`, en el bootstrap y en `setup`; respeta una elección previa del
  usuario). Entrar a yolo por atajo pide Enter. Verificado en vivo: sin diagnóstico de conflicto.
- [x] **T7.10 Indicador en UI**
  Chip en el footer vía `setStatus("nubia:mode")` (`✎ Accept edits · max Auto`), fila `Mode` en el bloque Project del
  Status con el tope y su origen. `docs/permission-modes.md`; `docs/yolo-mode.md` lo presenta como 5.º modo.
  *Pendiente menor:* `assets/orchestrator*.md` todavía no menciona que el modo lo controla el humano (la directiva de
  sistema ya lo dice en cada turno).

### Políticas que alimentan los modos

- [x] **T7.1 Permisos por ruta**
  `lib/path-permission-policy.ts`: `parsePathPolicy` (`paths.deny|confirm|readOnly`), `mergePathPolicies` (unión:
  el repo solo agrega), `matchesGlob` (`**`, `*`, `?`, `{a,b}`, basename sin `/`), `evaluatePaths` (deny > confirm),
  `bashWriteTargets` (redirecciones, `tee`, operandos de rm/mv/cp/touch/sed -i/git checkout…). Aplicado en la
  extensión de modos antes de `decide()`: deny bloquea en todo modo, confirm pregunta en todo modo (yolo incluido).
- [x] **T7.2 Permisos por agente/herramienta**
  `lib/agent-tool-policy.ts` (`agents.<nombre|patrón>.tools.<tool|patrón>: allow|confirm|deny`, la más estricta gana
  entre capas). El runner pasa `NUB_IA_AGENT_NAME` al hijo; la extensión de modos lo aplica dentro del hijo antes de
  todo lo demás; `confirm` en un hijo (sin UI) falla cerrado con instrucción de reportar al orquestador.
- [x] **T7.3 Allowlist de providers/modelos por repo**
  `allowedProviders` / `deniedModels` en `model-tiers.json` (`parseTierCatalog`, `modelDenied`, `permittedModels`,
  `tightestAllowlist`: intersección / unión, el repo solo acota). El router filtra los modelos disponibles; en
  `model_select` un modelo denegado se revierte (`pi.setModel`) al anterior permitido o a `nub-ia/balanced` con aviso.
  `/nubia:doctor` lista la política.
- [x] **T7.4 Límites de delegación y gasto**
  `limits.{maxConcurrentSubagents,maxSubagentsPerTurn,blockDelegationOverBudget}` en `runtime-guardrails.json`
  (`parseDelegationLimits`, `tightestLimits`, `delegationDenied` en `lib/permission-mode-config.ts`). La extensión de
  modos cuenta subagentes vivos (canal de agentes), lanzamientos por turno y el estado de presupuesto (canal del router)
  y rechaza `subagent_run` con motivo. El tope en USD lo cubre `budget` de T2.2 + el flag.
- [x] **T7.5 Redacción de secretos**
  `lib/secret-redaction.ts` (AWS, GitHub, OpenAI/Anthropic, Slack, Google, Stripe, npm, JWT, llaves privadas, URL
  con credenciales, Bearer, `*_SECRET=`), aplicado en `tool_result` de bash/read/grep (con nota de qué se redactó), al
  escribir el reporte de review y al publicarlo en el PR, y en la captura del historial de prompts. Las métricas ya no
  llevan texto. Hashes git, UUIDs y rutas quedan intactos (test).

## Fase 8 — Gobernanza

- [x] **T8.1 Política de organización centralizada**
  `lib/org-policy.ts` (`parseOrgPolicy` con schema `nub-ia.org-policy/v1`, `sectionText` que reusa los parsers
  existentes, `orgModelTiersText`, `orgReviewGate`, `parseOrgPolicySource`) + `scripts/org-policy-fetch.mjs`
  (`git clone --depth 1`, valida schema, escribe `org-policy.json` con procedencia; un fallo conserva la anterior).
  `nub-ia policy status|pull|set|clear`; `nub-ia update` refresca. Capa org cableada en modos, paths, agentes, límites,
  review gate (`source: org_policy`) y model tiers (allowlist + budget). `docs/governance.md`.
- [x] **T8.2 Roles**
  `roles.{default,members,definitions}` en `org-policy.json` (`parseRoles`, `resolveRole`: `NUB_IA_ROLE` → email exacto
  → `*@dominio` → default; `applyRole` sustituye secciones de nivel org). `loadEffectiveOrgPolicy(env, cwd)` es el
  único cargador (lee `git config user.email` solo si hay `members`) y lo usan modos, paths, agentes, límites, gate y
  tiers. `/nubia:mode status` muestra el rol. *Auditoría del cambio de rol:* en T8.4.
- [x] **T8.3 Skills y paquetes aprobados**
  `scripts/approved-packages.mjs` (+ `lib/approved-packages.ts`): `approvedPackages` lista → warn u objeto con
  `mode: enforce`; patrones sobre la fuente normalizada (sin versión/ref). `nub-ia install` avisa o rechaza (probado
  end-to-end); la shell avisa al inicio sobre paquetes del `settings.json` fuera de lista. *Pendiente:* hash de
  `SKILL.md` al instalar (integridad posterior), fuera de este corte.
- [x] **T8.4 Auditoría local**
  `lib/audit-log.ts` (`auditRow` redacta/recorta el sujeto, `parseAuditRows`, `summarizeAudit`, `auditToday`), sink
  `audit/audit-<mes>.jsonl` (0600) vía el sink generalizado. Emisores: extensión de modos (ask/deny/paths/agentes/
  límites/cambios de modo con rol), review (push gate, veredicto). `nub-ia audit [--month] [--json]`; línea `Audit` en
  Status. Opt-in de envío: T3.3.
- [x] **T8.5 Firma e integridad de políticas**
  El fetch de `org-policy.json` verifica el HEAD del clon con el mismo `allowed_signers`; una política no firmada o
  firmada por un desconocido se rechaza y se conserva la anterior (nunca relaja nada). Probado end-to-end.
- [x] **T8.6 Documentación de gobernanza**
  `docs/governance.md`: capas y fusión por política, política de org, paquetes aprobados, roles, auditoría, cómo pedir
  excepciones (tabla por capa), límites. La política efectiva en `/nubia:doctor` se agrega en T5.1.

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

# Nub-IA — qué es, qué trae, cómo se compara

> Versión del documento: 2026-10-14. Todo número de esta página se midió con `node scripts/bench-prompt.mjs --tokens`
> o con los comandos indicados en cada tabla; lo que no se pudo medir se dice explícitamente.

## En una frase

Nub-IA es el **harness de agente de código del equipo de Nubiral**: un paquete que corre sobre [Pi](https://pi.dev)
(agente open source, extensible) y le agrega lo que un equipo necesita para usar agentes **con control**: modos de
permiso, políticas de organización que solo endurecen, review automático de 4 lentes con gate de push, router de modelos
por tier, subagentes, auditoría y métricas locales. Es un fork de [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell)
con identidad propia.

## Qué problema resuelve

| Problema del equipo | Qué hace Nub-IA |
| --- | --- |
| Cada dev configura el agente distinto; nadie sabe con qué modelo corre ni qué puede hacer | Router por tier (`strong`/`balanced`/`fast`) resuelto por provider disponible; `/nubia:doctor` dice qué resolvió; política de org distribuida por `nub-ia update` |
| Un cliente exige que el código no salga de cierta cuenta/provider | `allowedProviders` por repo u org, aplicado también a `/model` manual |
| El agente ejecuta cosas que no debía (o pregunta por todo) | **Modos** plan/manual/accept-edits/auto/yolo (Shift+Tab); rutas protegidas; reglas por subagente; comandos guardados |
| Nadie revisa lo que el agente pushea | Review 4R (riesgo, confiabilidad, resiliencia, legibilidad) en paralelo y en proceso; **gate de push** (`confirm`/`strict`); `nub-ia review` en CI con exit code; comentario en el PR |
| Un `cat .env` o un token en un log termina en el transcript o en el historial | Redacción de credenciales en salida de tools, reportes e historial |
| Gasto y uso opacos | Métricas locales por agente/modelo, gasto por día, `nub-ia usage`, presupuesto opcional |
| Imposible saber después qué se aprobó y qué se bloqueó | Auditoría local por decisión (`nub-ia audit`) |
| Las políticas se relajan en un clon o por un prompt | Precedencia **org > repo > usuario**, cada capa **solo endurece**; política y updates firmados por maintainers |
| El system prompt del harness pesa más que el trabajo | Perfil **minimal** por defecto (~0,6k tokens de harness vs ~4,3k del completo) |
| La salida de bash llena el contexto | Reescritura con [rtk](https://github.com/rtk-ai/rtk) (binario pinneado) |

## Qué trae

### Núcleo (heredado de Pi + gentle-shell)
- Pi: TUI, herramientas `read/bash/edit/write`, sesiones, extensiones, skills, providers (Copilot, OpenAI, Bedrock, Anthropic, NVIDIA, OpenCode, llama.cpp…).
- Organic Driven Development: autorizar → explorar → clasificar → trackear lo grande → implementar con tests → cerrar.
- **Subagentes** (`nubia-explore`, `nubia-worker`, `nubia-verify`, lentes de review, Judgment Day) como procesos `pi --mode rpc` con IPC, límites de concurrencia y vista en la TUI.
- Skills LLM-first (`branch-pr`, `chained-pr`, `judgment-day`, `work-unit-commits`, …), prompt history, todo, codegraph, YOLO de sesión.

### Propio de Nub-IA
- **Router de modelos por tier** (`nub-ia/strong|strong-alt|balanced|fast`) con failover entre providers, allowlist, presupuesto opcional y bloque "Router" en Status.
- **Review 4R** `nub_review` / `/nubia:review`: chunking de diffs grandes, contexto de archivos tocados, reglas del repo, `fix`, `stats`, `eval`; `nub-ia review --base … --json --fail-on --pr` para CI.
- **Modos de permiso** + rutas protegidas + reglas por agente + límites de delegación.
- **Gobernanza**: política de organización (`nub-ia policy`), roles, paquetes aprobados, auditoría, firmas.
- **Observabilidad**: métricas JSONL locales (runtime/review/audit), `nub-ia usage`, espejo opt-in al equipo.
- **Shell**: banner y tema Nubiral, Status con Review / Subagentes / Router / Mode / Audit, `/nubia:*`, perfil de prompt minimal.
- **Operación**: launcher `nub-ia` con home aislado, `nub-ia init|update|setup|policy|audit|usage|review`, rtk pinneado con SHA-256, releases semver automáticas por Conventional Commits y bumps de pins (`pin-bumps.yml`).

Para cambiar nombre, prefijo de comandos, colores y logos (demo o venta con otra marca) ver [branding.md](branding.md).

## Arquitectura en diez líneas

```
nub-ia (launcher, bin/nub-ia.mjs)  →  pi  +  este paquete como extensión
   │
   ├─ extensions/nubia-harness.ts      prompt ODD + guardrails de comandos + doctor
   ├─ extensions/nubia-permission-mode  modos, paths, reglas por agente, límites, redacción, auditoría
   ├─ extensions/nub-ia-router          tiers → modelo físico; allowlist; presupuesto
   ├─ extensions/nub-ia-review          4 lentes en paralelo; gate de push; CI/PR
   ├─ extensions/nubia-agents           subagentes rpc; Status "Subagentes"
   ├─ extensions/rtk-rewrite            bash → rtk bash
   └─ extensions/nubia-shell            TUI: Status, customize, usage
Políticas: ~/.pi/nub-ia/*.json (usuario) ◁ .pi/nub-ia/*.json (repo) ◁ org-policy.json (org)   — solo endurecen
```

## Comparativa cualitativa

Hechos verificables en documentación o código público, consultados el 2026-10-14. "—" = no verificado en esta
revisión (no significa que no exista). Claude Code no es open source: solo lo que documenta Anthropic.

| Capacidad | Pi | gentle-shell | **Nub-IA** | OpenCode | Claude Code | Codex CLI |
| --- | --- | --- | --- | --- | --- | --- |
| Código abierto | ✔ | ✔ (MIT) | ✔ (MIT, fork) | ✔ | ✖ | ✔ (CLI) |
| Multi-provider (BYO credenciales) | ✔ | ✔ | ✔ | ✔ | Anthropic (+Bedrock/Vertex) | OpenAI |
| Router por tier con failover entre providers | ✖ | ✖ | **✔** | ✖ (modelo por agente) | ✖ | ✖ |
| Allowlist de providers por repo/org | ✖ | ✖ | **✔** | — | — | — |
| Modos de permiso cambiables en sesión | ✖ | YOLO on/off (+3 modos en upstream reciente) | **5 modos, Shift+Tab** | Permisos por tool (`allow/ask/deny`) y agente | `default`, `acceptEdits`, `plan`, `bypassPermissions` (Shift+Tab) | Modos de aprobación + sandbox |
| Rutas protegidas por glob | ✖ | ✖ | **✔** | — | Reglas de permisos por patrón | — |
| Reglas por subagente | ✖ | ✖ | **✔** | ✔ (permisos por agente) | ✔ (tools por subagent) | — |
| Política de organización que solo endurece | ✖ | ✖ | **✔** | — | Managed settings (enterprise) | — |
| Subagentes | ✖ (vía extensión) | ✔ | ✔ | ✔ | ✔ | — |
| Review automático multi-lente con gate de push | ✖ | review nativo (binario externo) | **✔ en proceso, 4 lentes, CI, PR** | ✖ | ✖ | ✖ |
| Redacción de secretos en salida de tools | ✖ | ✖ | **✔** | — | — | — |
| Auditoría local de decisiones | ✖ | ✖ | **✔** | — | — | — |
| Compresión de salida de bash (rtk) | ✖ | ✖ | **✔ pinneado** | ✖ | ✖ | ✖ |
| Perfil de system prompt conmutable | ✖ | ✖ | **✔ minimal/full** | ✖ | ✖ | ✖ |
| Instrucciones de proyecto | AGENTS.md | AGENTS.md | AGENTS.md + `.pi/nub-ia/*` + `review-rules.md` | AGENTS.md | CLAUDE.md | AGENTS.md |
| Skills / extensiones | ✔ | ✔ | ✔ | plugins | skills, hooks, MCP | MCP |

Fuentes: Pi (`docs/` del paquete), gentle-shell (`docs/UPSTREAM-README.md`), OpenCode (`anomalyco/opencode`, rama `dev`),
Codex (`openai/codex`, `main`), Claude Code (documentación pública de Anthropic sobre permission modes y subagents).

Lo que **no** es Nub-IA: no es un sandbox (los guardrails son redes basadas en patrones; para contención real, contenedor
y credenciales mínimas), no es un IDE, y no reemplaza el review humano: lo prepara.

## Benchmarks

### 1. System prompt: qué recibe el modelo en el primer turno

Medido con `node scripts/bench-prompt.mjs --tokens` (homes limpios: sin skills personales, sin AGENTS.md global, sin
sesiones; modelo `amazon-bedrock/us.anthropic.claude-sonnet-5-5`; cwd = repo git vacío; prompt del usuario "Reply with
the single word ok").

| Configuración | System prompt (bytes) | de los cuales harness Nub-IA | Skills catálogo | Herramientas (schemas) | **Tokens de prompt (turno frío)** |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pi` sin extensiones | 3 459 | 0 | 0 | 4 (3,1 KB) | **2 620** |
| **Nub-IA `minimal`** (default) | 11 495 | 2 588 | 3 972 | 26 (21,3 KB) | **12 177** |
| Nub-IA `full` | 26 071 | 17 164 | 3 972 | 26 (21,3 KB) | **16 923** |

Lectura honesta:

- El texto del harness en `minimal` son **~650 tokens**; el perfil `full` **~4 300**. Ese fue el objetivo de T5.0 y se cumplió (6,6× menos).
- **El costo dominante hoy son los schemas de las 26 herramientas (~5 300 tokens)**, no el prompt: `orchestrator_session_id` (3,3 KB), `subagent_run` (2,2 KB), `orchestrator_list` (1,8 KB), `todo` (1,5 KB), `ask_user_question` (1,4 KB). Pi pelado lleva 4 herramientas. Siguiente mejora obvia: exponer las herramientas de orquestación de forma diferida (Pi soporta `codemode`/tools deferred) o recortar sus descripciones. Está anotado en el roadmap.
- El catálogo de 11 skills del paquete suma ~1 000 tokens; un home con muchas skills personales pesa mucho más (en la máquina de prueba, 24 skills + AGENTS.md global llevaban el system prompt de Pi pelado a **70 KB**). El harness no es el problema; el catálogo sí puede serlo.
- Con prompt caching (Anthropic/Bedrock, OpenAI) el prompt se paga completo solo en el turno frío; los siguientes lo leen de caché a ~10 % del precio. El costo del turno frío medido fue USD 0,0006 / 0,0027 / 0,0038.

### 2. Tamaño del prompt estático de otros agentes (archivos públicos)

Solo el texto del archivo de system prompt en el repo público, **sin** schemas de herramientas, instrucciones de
proyecto ni contexto de entorno; por eso **no es comparable 1:1** con la tabla anterior, que mide el prompt ensamblado.

| Agente | Archivo (commit del 2026-10-14) | Bytes |
| --- | --- | ---: |
| OpenCode | `packages/core/src/plugin/system-prompt/anthropic.txt` | 300 |
| OpenCode | `…/system-prompt/gpt.txt` | 2 572 |
| OpenCode | `…/system-prompt/gpt-astra.txt` | 3 825 |
| OpenCode | `…/system-prompt/kimi.txt` | 8 701 |
| OpenCode | `packages/core/src/session/runner/prompt/system.txt` | 756 |
| Codex CLI | `codex-rs/core/gpt-5.2-codex_prompt.md` | 7 589 |
| Codex CLI | `codex-rs/core/gpt_5_2_prompt.md` | 21 652 |
| Codex CLI | `codex-rs/core/gpt_5_1_prompt.md` | 24 204 |
| Pi | ensamblado, medido arriba | 3 459 |
| Claude Code | no público | — |

Tendencia visible en ambos proyectos: prompts **por familia de modelo**, cortos para los modelos que ya traen las
convenciones aprendidas (OpenCode/Anthropic: 300 bytes) y largos para los que las necesitan explícitas. Nub-IA `minimal`
(2,6 KB de harness) está en el rango bajo de esa tabla; `full` (17 KB) en el alto.

### 3. rtk: compresión de salida de bash

Medido en este repo con el binario pinneado (rtk 1.0.1; con 0.51.0 los resultados fueron equivalentes), bytes de salida crudos vs. `rtk <comando>`:

| Comando | Crudo | Con rtk | Ahorro |
| --- | ---: | ---: | ---: |
| `git status` | 537 B | 146 B | 72 % |
| `ls -la lib` | 9 903 B | 1 697 B | 82 % |
| `git log --oneline -30` | 2 593 B | 2 593 B | 0 % |
| `git diff HEAD~3 --stat` | 770 B | 770 B | 0 % |
| `grep -rn … lib extensions` | 1 477 B | 1 477 B | 0 % |
| `node --test <1 archivo>` | 3 207 B | 3 208 B | 0 % |
| `pnpm run typecheck` | 385 B | 385 B | 0 % |
| `cat lib/nub-review.ts` | 33 207 B | 33 207 B | 0 % |

rtk promete "60–90 % en comandos comunes de desarrollo" (descripción del repo) y aclara que sus porcentajes son
confiables pero los tokens absolutos son estimados (`bytes / 4`). En nuestra medición el ahorro es grande en comandos de
estado/listado y **nulo en los demás**, tanto con 0.51.0 como con 1.0.1. Nub-IA no inventa reglas: solo delega en rtk y verifica que la reescritura sea el comando original
con `rtk` adelante.

### 4. Reproducir

```bash
node scripts/bench-prompt.mjs            # bytes por sección, sin llamar al modelo
node scripts/bench-prompt.mjs --tokens   # + un turno real por configuración (usa tu auth de ~/.nub-ia/agent)
```

Para otros agentes: clonar su repo y medir los archivos listados; para el prompt ensamblado hace falta instrumentar cada
uno (OpenCode y Codex permiten verlo con sus modos de debug/trace; Claude Code no expone el system prompt).

## Limitaciones conocidas

- Guardrails, modos y políticas son redes basadas en patrones sobre las herramientas del agente, no un sandbox.
- La clasificación "solo lectura" de bash es una lista blanca conservadora: un comando desconocido cuenta como mutante.
- El router depende de los nombres de modelo de cada provider (regex en `model-tiers.json`); `/nubia:doctor` avisa cuando dejan de matchear.
- Los schemas de herramientas (~5 k tokens) son hoy el mayor costo fijo por turno frío; está en el roadmap.

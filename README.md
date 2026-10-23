# Nub-IA

Shell de coding-agent para el equipo de Nubiral, construida sobre [Pi](https://pi.dev).

<img width="2547" height="1347" alt="Nub-IA en Windows Terminal: banner con el isologo de Nubiral, barra superior con modelo y contexto, y el panel Status con Review y ponytail" src="https://github.com/user-attachments/assets/bbb63757-5228-45a7-a171-60ad3449734a" />


https://github.com/user-attachments/assets/c52cadaa-3fe3-41cf-a4a9-eebc6ed17a92


También en [YouTube](https://youtu.be/qvtMXvDKnNI).

Nub-IA es un fork de [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) (paquete `gentle-pi`, MIT).
Mantiene su harness ODD (subagentes enfocados, evidencia TDD, review 4R en proceso, skills) con la identidad visual
y la configuración del equipo. No es una distribución oficial de gentle-shell ni está afiliada a sus autores.

## Instalación

Requisitos: git y Node >= 22.19. Lo demás lo resuelve el instalador: usa pnpm (directo, o vía corepack/npx; npm solo
como último recurso) tanto para instalar `pi` (`@earendil-works/pi-coding-agent`) si falta como para las dependencias,
y deja `PNPM_HOME` y los directorios de binarios en el PATH del usuario (en Linux/macOS, en tu `.bashrc`/`.zshrc`/`.profile`).

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/sebamar88/nub-ia/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/sebamar88/nub-ia/main/install.ps1 | iex
```

El instalador clona el repo en `~/.nub-ia/app` (Windows: `%LOCALAPPDATA%\nub-ia\app`), instala las dependencias (el
`postinstall` descarga el binario `rtk` pinneado y verificado), y deja el comando `nub-ia` en `~/.local/bin` (Windows:
`%LOCALAPPDATA%\nub-ia\bin`, agregado al PATH del usuario). Es idempotente y nunca pide sudo/elevación.

| Repo | Cómo clona | Qué hace falta |
| --- | --- | --- |
| Público | HTTPS (default) | Nada. |
| Privado | SSH: `NUB_IA_PROTOCOL=ssh` o `NUB_IA_REPO=git@github.com:sebamar88/nub-ia.git` (acepta alias de `~/.ssh/config`) | Clave SSH con acceso al repo. `raw.githubusercontent.com` también pide auth: cloná y corré `sh install.sh` / `.\install.ps1` desde el clon. |

Otras variables: `NUB_IA_DIR`, `NUB_IA_BIN`, `NUB_IA_BRANCH`.

`raw.githubusercontent.com` cachea 5 minutos: si acabás de publicar un cambio en el instalador y `irm`/`curl` te sirve el
viejo, agregá un parámetro al URL (`install.ps1?x=$(Get-Random)` / `install.sh?x=$RANDOM`).

Con el repo público también sirve Pi directamente: `pi install git:github.com/sebamar88/nub-ia` (Pi clona, corre el
`postinstall` y actualiza con `pi update`; no crea el comando `nub-ia`: lanzá `node ~/.pi/agent/git/github.com/sebamar88/nub-ia/bin/nub-ia.mjs`
o usá `pi` a secas con el paquete cargado).

Después:

```bash
nub-ia            # primera ejecución: provisiona ~/.nub-ia/agent (tema, modelo, ponytail) y recuerda hacer /login
nub-ia --link     # alternativa: reutilizar tu ~/.pi/agent con sus logins y sesiones
nub-ia update     # actualiza el checkout (git pull + deps) y luego los paquetes del home
```

Si preferís no tener el launcher: el paquete también funciona cargado en `pi` a secas (`pi -e ~/.nub-ia/app/extensions`
o declarándolo en `settings.json`); perdés el home aislado, el tema por defecto y el auto-setup.

Alternativa para desarrollo (clon propio): `git clone git@github.com:sebamar88/nub-ia.git && cd nub-ia && pnpm install &&
pnpm link --global`.

Si falta `.rtk/<versión>/rtk` (descarga fallida, sin red), cada arranque de `nub-ia` lo reinstala una vez (aviso por
stderr, nunca bloquea; `NUB_IA_SKIP_RTK_INSTALL=1` lo desactiva).

Tras el primer provisionado (y con `nub-ia setup`) se imprime un recordatorio de login: iniciá sesión en al menos un
proveedor dentro del shell (`/login github-copilot`, `/login openai`, `/login opencode`, `/login nvidia`,
`/login llama.cpp`; Amazon Bedrock usa tus credenciales `AWS_*`).

Para reutilizar tu home de pi existente (sesiones, logins) en lugar del home aislado:

```bash
nub-ia --link
```

### Actualizar / desinstalar

Actualizar: `nub-ia update`, o volver a correr el instalador (idempotente: `git pull`, dependencias y wrapper regenerado).

Desinstalar por completo (nada queda en otro lado):

```bash
# Linux / macOS: app + home aislado, wrapper, config (models, perfiles, gate, métricas)
rm -r ~/.nub-ia ~/.local/bin/nub-ia ~/.pi/nub-ia
# y quitar el bloque "# nub-ia installer" de ~/.bashrc / ~/.zshrc / ~/.profile
```

```powershell
# Windows
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\nub-ia", "$env:USERPROFILE\.nub-ia", "$env:USERPROFILE\.pi\nub-ia"
# y quitar %LOCALAPPDATA%\nub-ia\bin del PATH de usuario
```

`pi` queda instalado (es independiente); se quita con `pnpm remove -g @earendil-works/pi-coding-agent` (o `npm uninstall -g`).

## Uso

```
nub-ia [opciones] [-- pi-args...]
nub-ia home [link|isolated|<path>]
nub-ia [selectores de home] setup [--dry-run]
nub-ia install npm:<pkg> | remove <source> | list | update | config | auth <cmd>
```

`nub-ia update` actualiza primero el checkout del paquete (`git pull --ff-only` + dependencias, cuando lo instaló
`install.sh`/`install.ps1`; `NUB_IA_NO_SELF_UPDATE=1` lo omite) y después los paquetes del home. Al arrancar, si el checkout
quedó atrás de `origin`, nub-ia muestra un aviso "Update Available" como el de Pi (en la terminal y dentro de la TUI) para
que corras `nub-ia update`: "New version 1.3.0 is available" con el link al [Release](https://github.com/sebamar88/nub-ia/releases)
cuando hay una versión publicada, o el conteo de commits y el `compare` cuando todavía no se cortó release. Compara contra lo
último fetcheado y refresca en segundo plano como mucho cada 6 h, así el arranque nunca espera la red. `nub-ia --help` muestra la
referencia completa. Dentro de la sesión (`/nubia:commands` lista todo):

| Comando | Qué hace |
| --- | --- |
| `/nubia:review [staged\|working\|<ref>]` | Review 4R del diff (también la herramienta `nub_review`). |
| `/nubia:review-mode` | Gate de push: `status`, `enable` (confirmar), `strict` (rechazar sin review), `disable`. |
| `/nubia:models`, `/nubia:profiles` | Modelos por agente y perfiles (tecla `i` importa un preset de `assets/profiles/`). |
| `/nubia:grill [tema]` (alias `/nubia:quiz`) | Lanza la skill `nubia-grill-me`: entrevista por rondas sobre el plan o la decisión indicada (o la que se está discutiendo) hasta compartir el entendimiento; nada se implementa hasta confirmar. |
| `/nubia:mode [plan\|manual\|accept-edits\|auto\|yolo\|status\|default <m>]` | Modo de permisos (**Shift+Tab** cicla): plan (solo lectura), manual (pregunta todo), accept-edits, auto (default), yolo. Ver [docs/permission-modes.md](docs/permission-modes.md). |
| `/nubia:persona`, `/nubia:yolo`, `/nubia:background-subagents` | Persona del asistente, modo YOLO, subagentes en segundo plano. |
| `/nubia:banner`, `/nubia:banner-color`, `/nubia:toggle-rose`, `/nubia:toggle-text-logo` | Banner de inicio (isologo + wordmark, paleta `lime`). |
| `/nubia:customize`, `/nubia:animations`, `/nubia:vim`, `/nubia:double-esc-cancel` | Apariencia y comportamiento de la shell. |
| `/nubia:prompt [minimal\|full]` | Cuánto agrega Nub-IA al system prompt de Pi y el perfil activo. **`minimal` (default, ~0,6k tokens)** mantiene identidad, persona y ODD en 8 reglas; `full` (~4k tokens) agrega el texto completo del harness. Un repo puede fijarlo en `.pi/nub-ia/prompt-profile.json`; `NUB_IA_PROMPT_PROFILE` por sesión. |
| `/nubia:changes`, `/nubia:agents`, `/nubia:usage`, `/nubia:stats`, `/nubia:status`, `/nubia:doctor` | Paneles de estado y diagnóstico. El panel Status incluye Review y Subagentes (tareas delegadas en vivo con su título). |

El tema por defecto es `Nub-IA` (`themes/Nub-IA.json`); se cambia desde `/settings`.

### Configuración por repositorio

`nub-ia init` crea `.pi/nub-ia/` en el repo con archivos comentados e inertes hasta que los edites: `runtime-guardrails.json`
(comandos guardados, tope de modo, rutas protegidas, reglas por agente, límites), `review-gate.json` (`confirm|strict`),
`review-rules.md` (convenciones que revisa el 4R), `persona.json` y `model-tiers.json.example`. Todo lo que un repo
declara **solo endurece** lo del usuario (ver [docs/governance.md](docs/governance.md)); commiteá lo que quieras compartir.

### Variables de entorno

Todas se llaman `NUB_IA_*` (el launcher las pasa a los procesos hijos).

| Variable | Uso |
| --- | --- |
| `NUB_IA_HOME` | Directorio del home aislado (default `~/.nub-ia/agent`). |
| `NUB_IA_PI` | Ruta al ejecutable `pi` a usar. |
| `NUB_IA_NO_AUTO_SETUP=1` | No provisionar el home automáticamente en el primer arranque. |
| `NUB_IA_TEAM_PACKAGES` | Paquetes Pi que `setup` instala (default: la lista del paquete; vacío = ninguno). |
| `NUB_IA_CONFIG_HOME` | Config global (default `~/.pi/nub-ia`; lo que solo exista en `~/.pi/gentle-ai` se sigue leyendo). |
| `NUB_IA_REVIEW_GATE` | `confirm` \| `strict` \| `off` para la sesión (los archivos de política tienen prioridad). |
| `NUB_IA_METRICS=off` | Desactiva métricas, review y auditoría locales (`~/.pi/nub-ia/{metrics,audit}/`). |
| `NUB_IA_METRICS_ENDPOINT`, `NUB_IA_METRICS_TOKEN` | Opt-in: espejo de esas filas (sin rutas ni secretos) a un endpoint `https://` del equipo; ver [docs/telemetry.md](docs/telemetry.md). |
| `NUB_IA_NO_SELF_UPDATE=1` | `nub-ia update` no actualiza el checkout del paquete. |
| `NUB_IA_NO_UPDATE_CHECK=1` | No avisar al arrancar cuando el checkout está desactualizado (ni hacer el `git fetch` en segundo plano). |
| `NUB_IA_PROMPT_PROFILE` | `minimal` \| `full` para la sesión (gana sobre repo y usuario). |
| `NUB_IA_SKIP_VERIFY=1` | Saltear (una vez, con aviso) la verificación de firma de `nub-ia update` y de la política de org. |
| `NUB_IA_TRACE_STARTUP=1` | Imprime cuánto tarda cada etapa del arranque (para diagnosticar un inicio lento). |
| `NUB_IA_SKIP_RTK_INSTALL=1` | Saltar la descarga del binario `rtk` (postinstall y auto-reparación al arrancar). |
| `NUB_IA_RTK_BIN` | Ruta a un `rtk` concreto para la reescritura de comandos. |
| `RTK_DISABLED=1` | Apagar la reescritura de comandos con rtk en la sesión. |
| `NUB_IA_ROUTER_DEBUG=1` | Traza en stderr de las decisiones del router y del review. |

### Guardrails de comandos

`.pi/nub-ia/runtime-guardrails.json` (versionado) define qué comandos del agente piden confirmación o se bloquean (y, en `permissionMode`, el tope y default de los [modos de permiso](docs/permission-modes.md)):
`npm publish` está bloqueado (el paquete nunca se publica). `git push`, `git rebase`, `git branch -D` y `pi remove` piden
confirmación por defecto sin necesidad de declararlos (declararlos como `confirm` impide que el modo YOLO los exima).
Se puede sobreescribir por usuario en `~/.pi/nub-ia/runtime-guardrails.json`.

### Router de modelos por tier (`nub-ia/*`)

Nub-IA registra cuatro modelos virtuales de Pi: `nub-ia/strong`, `nub-ia/strong-alt`, `nub-ia/balanced` y `nub-ia/fast`.
Cada request hecho con uno de ellos se despacha a un modelo físico de **los providers con credenciales en esa máquina**,
según `assets/model-tiers.json`:

| Tier | Copilot / OpenCode Zen | Bedrock | OpenAI (suscripción) | OpenCode Go | NVIDIA | llama.cpp | Agentes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `strong` | claude-opus-5.5 | us.anthropic.claude-opus-5-5 | gpt-6-astra | kimi-k3 | kimi-k3 | el modelo cargado | review-risk, jd-judge-b |
| `strong-alt` | claude-fable / gpt-6-astra | us.anthropic.claude-fable-5-1 | gpt-6-astra | deepseek-v4-pro | nemotron-3-ultra | el modelo cargado | jd-judge-a |
| `balanced` | claude-sonnet-5.5 | us.anthropic.claude-sonnet-5-5 | gpt-6.1-sol | glm-5.3 | nemotron-3-super | el modelo cargado | worker, verify, explore, reliability, resilience, readability, jd-fix-agent |
| `fast` | claude-haiku-4.5 | us.anthropic.claude-haiku-4-5 | gpt-6-luna | glm-5.3-flash | nemotron-3.5-lightning | el modelo cargado | — |

Reglas: prioridad de providers Copilot → Bedrock → OpenAI (`openai`; `openai-codex` es el id legacy) → OpenCode Zen →
Anthropic → NVIDIA → OpenCode Go → llama.cpp (local, último porque prioriza calidad; quien solo tenga llama.cpp lo usa
igual, y una sesión que ya corre local se queda local); dentro de un provider
se prefiere Claude sobre GPT y de OpenAI solo la generación más nueva; entre varios matches gana la versión más alta y luego el
más barato. Un turno nuevo mantiene el provider ya en uso (prompt cache); las continuaciones no cambian de modelo; si un
provider devuelve 429/5xx/overloaded, el retry salta al siguiente provider y lo excluye por el resto de la rama de sesión.

- Los agentes del paquete declaran `model: nub-ia/<tier>` en su frontmatter; funcionan igual para cualquier integrante sin configurar nada.
- Un home nuevo arranca con `defaultProvider: nub-ia`, `defaultModel: balanced`; se cambia con `/model`.
- El footer muestra `balanced • medium → claude-sonnet-5.5 • medium`; `/session` desglosa costos por modelo físico; el bloque "Router" del panel Status lista el modelo resuelto por tier y los providers excluidos en la sesión con su causa (rate limit, overloaded, auth…).
- Allowlist opcional: `"allowedProviders": ["amazon-bedrock"]` y/o `"deniedModels": ["gpt-5-mini"]` (regex sobre `provider/id`) restringen la sesión completa, también un `/model` manual (se revierte al modelo anterior permitido o a `nub-ia/balanced` con aviso). El override por repo solo puede acotar más (intersección de providers, unión de patrones). `/nubia:doctor` lo muestra.
- Presupuesto opcional: `"budget": { "dailyUsd": 20, "sessionUsd": 5, "onExceed": "warn"|"degrade" }` en `model-tiers.json`. El gasto es el que Pi calcula por mensaje; el diario se comparte entre sesiones de la máquina. Al superarlo, `warn` avisa una vez y lo muestra en el bloque Router del Status; `degrade` además baja un tier (`strong`/`strong-alt` → `balanced` → `fast`). El override por repo solo puede endurecerlo. **Opcional y apagado por defecto**; tiene sentido con providers pay-per-use (Bedrock, NVIDIA, OpenCode Go): con suscripciones (Copilot, OpenAI) el costo que calcula Pi es nominal, no lo que paga el equipo, y el ledger es por máquina.
- Para cambiar la política: editar `assets/model-tiers.json`, o sobreescribirlo por repo en `.pi/nub-ia/model-tiers.json`.
- `/nubia:doctor` también verifica: binario rtk presente, gate de review en vigor, modo de permisos inicial y tope (con su capa), política de org y rol, perfil de prompt, y si el checkout del paquete está atrasado respecto de `origin/main`. Y lista, por tier, qué modelo resuelve con los providers logueados y avisa (`warn`) cuando ningún patrón del tier matchea y solo responde el fallback genérico (señal de que el provider renombró modelos), o (`fail`) cuando no hay ningún modelo.
- Para fijar un modelo concreto a un agente: `/nubia:models` o `/nubia:profiles` (gana sobre el tier).
- Cada integrante hace `/login` una vez por provider que tenga (Copilot, OpenAI, o variables `AWS_*` para Bedrock).

### Paquetes del equipo

`nub-ia setup` (y el primer arranque automático) instala en el home los paquetes Pi de
`TEAM_PACKAGE_SOURCES` en `lib/nubia-launcher.ts`. Hoy: [`ponytail`](https://github.com/DietrichGebert/ponytail)
(`npm:@dietrichgebert/ponytail@5.2.0`, pinneado a propósito; modo "lazy senior dev": YAGNI, stdlib primero; skills `/ponytail`, `/ponytail-review`,
`/ponytail-audit`, `/ponytail-debt`). Se actualizan con `nub-ia update`. Para agregar otro, sumá su source a la tabla;
`NUB_IA_TEAM_PACKAGES="npm:a,git:github.com/x/y"` la reemplaza (vacío = ninguno). Con `--link` no corre setup:
instalalo a mano con `nub-ia --link install npm:@dietrichgebert/ponytail@5.2.0`.

### Skills del equipo

Además de las heredadas de gentle-shell (`branch-pr`, `chained-pr`, `judgment-day`, `work-unit-commits`, …), el paquete trae **`nubia-grill-me`** (adaptada de [`grilling` de Matt Pocock](https://github.com/mattpocock/skills), MIT): "grill me" / "interrogame" dispara una entrevista por rondas que mapea el plan como árbol de decisiones, recomienda una respuesta por pregunta (un "sí" la acepta), busca los hechos por su cuenta y no implementa nada hasta que confirmás que el entendimiento es compartido. Usa `ask_user_question` cuando la ronda entra en 4 preguntas. Se lanza con `/nubia:grill [tema]` o `/nubia:quiz`.

### Review 4R propio (`nub_review`)

`extensions/nub-ia-review.ts` corre los cuatro revisores del paquete (risk, reliability, resilience, readability) **en
paralelo y en proceso** sobre el diff actual, sin binarios externos. Cada lente recibe el mismo diff y devuelve hallazgos
en JSON; se consolidan en un reporte markdown en `.pi/nub-ia/reviews/<fecha>-<hash>.md` con veredicto
`APPROVE | WARN | BLOCK | INCOMPLETE`.

- `/nubia:review fix`: toma los BLOCKER/CRITICAL del último reporte, pide confirmación y le entrega al agente un brief acotado (hallazgos, archivos afectados, "volvé a correr `nub_review`"); el agente lo implementa por su ruta normal (writer, guardrails, modo de permisos). Máximo 2 rondas por cambio; el reporte de re-chequeo enlaza al anterior.
- CI / scripts: `nub-ia review [--base <ref>|--staged|--working] [--json] [--fail-on block|warn|never]` corre el review sin TUI y sale 0/1/2 según el veredicto; ver [docs/review-ci.md](docs/review-ci.md).
- `/nubia:review --pr` (o `nub-ia review --pr` en CI) publica el reporte como comentario del PR vía `gh`, editando el anterior si ya existe (marcador oculto); en la shell pide confirmación.
- `/nubia:review stats` resume la calibración por lente a partir de las métricas locales (corridas, fallos, hallazgos por severidad, duración, modelos) y avisa si un lente parece sobre-severo o falla seguido; `/nubia:review eval` corre los fixtures del paquete contra los lentes reales (es lo que valida un cambio de prompt antes de actualizar su pin).
- Herramienta `nub_review` (`scope: auto|staged|working`, o `baseRef` para un rango commiteado) y comando `/nubia:review [staged|working|<ref>]`. `auto` revisa lo mismo que juzga el gate: con el árbol limpio y commits sin pushear, `upstream...HEAD`; si no, lo staged o el working tree.
- Diffs grandes: cada llamada a un lente recibe como mucho 400 KiB; por encima, el diff se parte por archivo (y por hunk si un archivo solo supera el límite) y cada lente revisa todos los trozos, con hasta 4 llamadas en vuelo; los hallazgos se consolidan en un único reporte y un único hash del diff completo. Tope duro: 3200 KiB (`baseRef` más corto o partir el cambio).
- Contexto de repo: junto con cada trozo del diff, los lentes reciben (dentro del mismo fence de datos) el contenido completo de los archivos tocados, con presupuesto fijo (8 archivos, 24 KiB por archivo, 96 KiB en total; los que no entran se listan). Se lee del índice, de `HEAD` o del working tree según el alcance; nunca se ejecutan herramientas. Sirve para seguir una función cambiada hasta sus callers en el mismo archivo.
- Reglas del proyecto: si el repo tiene `.pi/nub-ia/review-rules.md` (o, en su defecto, `AGENTS.md`), su contenido (hasta 16 KiB) se anexa como "Project rules" a cada lente, que reporta WARNING cuando el diff rompe una convención. Va en el mensaje de usuario y marcado como datos: no puede cambiar el rol ni el contrato de salida del lente.
- Los lentes usan los tiers del router (`review-risk` → `nub-ia/strong`, el resto `nub-ia/balanced`); si un provider falla (503/429), ese lente se reintenta en el siguiente provider.
- **Gate de push**: antes de un `git push`, si los cambios a entregar no tienen review, el review fue de otro diff, o el veredicto fue BLOCK/INCOMPLETE, actúa según `/nubia:review-mode`: `confirm` (default) pide confirmación, `strict` rechaza el push hasta que haya un review APPROVE/WARN del diff, `disable` lo apaga. Se guarda en `~/.pi/nub-ia/review-gate.json`; un `.pi/nub-ia/review-gate.json` en el repo lo fija para el equipo y `NUB_IA_REVIEW_GATE` lo fuerza por sesión.
- **Status**: el panel muestra el bloque "Review" con el último veredicto, su antigüedad y si el diff cambió desde entonces; se oculta desde `/nubia:customize` (sección review).

### Gobernanza

Política de organización por encima del repo y del usuario (`nub-ia policy set git:github.com/<org>/<repo>`, refrescada por `nub-ia update`), con la regla de siempre: cada capa solo endurece. Cubre modos de permiso, rutas protegidas, reglas por agente, límites de delegación, gate de review, allowlist/presupuesto de modelos. Ver [docs/governance.md](docs/governance.md).

### Seguridad

- Los archivos de política dentro de un repo (`.pi/nub-ia/review-gate.json`) solo pueden **endurecer** la configuración del usuario, nunca relajarla: un clon o el propio modelo no pueden apagar el gate de push.
- `nub_review` valida `baseRef` (solo ramas/tags/commits) y pasa `--end-of-options` a git, así una referencia no puede convertirse en una opción (`--output=…`).
- La reescritura con rtk se acepta solo si el comando resultante es el original con `rtk` adelante (sin separadores, redirecciones ni sustituciones nuevas); si no, se ejecuta el original ya evaluado por los guardrails.
- Redacción de secretos (`lib/secret-redaction.ts`): claves AWS, tokens de GitHub/OpenAI/Slack/Stripe/npm, JWT, llaves privadas, credenciales en URLs, `Authorization: Bearer` y variables `*_SECRET|TOKEN|PASSWORD|API_KEY=` se reemplazan por `[redacted]` en la salida de `bash`/`read`/`grep` antes de llegar al modelo, en los reportes de review (y su comentario de PR) y en el historial de prompts. Es por patrones: no reemplaza un sandbox ni un escáner de secretos.
- Los reportes de review (contienen el diff) se escriben con permisos 0600 en un directorio 0700 y se excluyen del repo del usuario vía `.git/info/exclude`.
- Dependencias: rtk con SHA-256 pinneado por plataforma; ponytail pinneado a una versión exacta (el workflow `pin-bumps.yml` propone los bumps por PR con digests tomados del `checksums.txt` de la release; `node scripts/bump-pins.mjs --check` lo muestra a mano); `pnpm audit` limpio (override de `brace-expansion` en `pnpm-workspace.yaml`); `minimumReleaseAge` de 3 días para todo lo nuevo.
- Integridad de `nub-ia update` y de la política de org: cuando `assets/maintainers.allowed_signers` lista llaves SSH de maintainers, el nuevo HEAD (y el commit de la política descargada) debe estar firmado por una de ellas (`git verify-commit` con `gpg.format=ssh`); si no, el checkout vuelve al commit anterior / se conserva la política previa. Con el archivo sin llaves la verificación está apagada (hay que activarla a propósito agregando llaves); `NUB_IA_SKIP_VERIFY=1` la saltea una vez, a los gritos.
- Límites conocidos: los guardrails de bash y el gate son redes de seguridad basadas en patrones, no un sandbox.

### RTK: menos tokens por comando

`extensions/rtk-rewrite.ts` reescribe cada comando de la herramienta `bash` con [`rtk rewrite`](https://github.com/rtk-ai/rtk)
antes de ejecutarlo (`git status` → `rtk git status`, `pnpm test` → `rtk pnpm test`, …), que filtra y resume la salida
antes de que llegue al modelo. Las reglas viven en rtk; la extensión solo delega.

El binario viene incluido: el `postinstall` (`scripts/install-rtk.mjs`) descarga la release pinneada de rtk para tu
plataforma (Linux x64/arm64, macOS x64/arm64, Windows x64; en Windows se descomprime con PowerShell y la ruta se pasa a Git Bash con barras normales), verifica su SHA-256 contra el digest fijado en
`scripts/rtk-installer.mjs` y lo deja en `<paquete>/.rtk/<versión>/`. La extensión usa esa copia antes que cualquier `rtk`
del PATH (`NUB_IA_RTK_BIN` lo fuerza a otra ruta). Si la descarga falla, la instalación no se rompe: los comandos
pasan sin filtrar y la barra de estado indica cómo reintentar (`pnpm run install:rtk`). `NUB_IA_SKIP_RTK_INSTALL=1` salta
la descarga; `RTK_DISABLED=1` apaga la reescritura en una sesión. No hace falta `rtk init`.

## Qué cambia respecto a gentle-shell

- Nombre del paquete y comando: `nub-ia` (`bin/nub-ia.mjs`). `private: true`, se instala desde Git, no desde npm.
- Banner de inicio: isologo de Nubiral y wordmark `nubiral` (trazados en braille / bloques desde `assets/brand/nubiral-isologo.png` con `scripts/trace-brand.mjs`) en lugar de la rosa, wordmark `nubiral` en lugar de `Gentle Shell`, paleta `lime` por defecto.
- Tema por defecto `Nub-IA` (los temas `Gentle*` siguen disponibles).
- Home aislado en `~/.nub-ia/` (config en `~/.nub-ia/config.json`).
- Comandos de la shell bajo `/nubia:*` (`/nubia:models`, `/nubia:profiles`, `/nubia:banner`, …) en lugar de `/gentle:*`.
- Sin binario gentle-ai: el review nativo (RDD) se reemplaza por el review 4R en proceso (`nub_review`).
- Review 4R en proceso con gate de push (`extensions/nub-ia-review.ts`, `lib/nub-review.ts`).
- Reescritura de comandos con RTK (`extensions/rtk-rewrite.ts`) con binario pinneado incluido (`scripts/rtk-installer.mjs`).
- Router de modelos por tier (`extensions/nub-ia-router.ts`, `lib/model-tier-router.ts`, `assets/model-tiers.json`).
- Workflow de publicación a npm eliminado.

Las variables de entorno se renombraron a `NUB_IA_*` (sin alias `GENTLE_*`). Nub-IA ya no se sincroniza con
gentle-shell: evoluciona por su cuenta. Los identificadores internos (archivos, funciones, esquemas y tipos de mensaje
persistidos) ya usan `nubia` / `nub-ia`; solo quedan nombres heredados en la lectura de compatibilidad de `~/.pi/gentle-ai`,
los temas `Gentle*` y la persona `gentleman`.

## Releases

Cada push a `main` corta un release semver (`.github/workflows/release.yml` → `scripts/release.mjs`): el bump sale de los
Conventional Commits desde el tag anterior (`feat!`/`BREAKING CHANGE` → major, `feat` → minor, el resto → patch), se
actualizan `package.json` y [`CHANGELOG.md`](CHANGELOG.md) en un commit `chore(release): vX.Y.Z`, se pushea el tag `vX.Y.Z`
y se publica un GitHub Release con las notas agrupadas por tipo. Por eso el mensaje de commit decide la versión: un `fix:`
y un `feat:` en el mismo push dan minor. `node scripts/release.mjs --dry-run` muestra el plan sin tocar nada.

## Desarrollo

```bash
pnpm test                       # suite completa (unit + runtime harness)
pnpm run typecheck
pnpm run build:runtime-modules  # regenerar runtime/ tras tocar lib/*.ts del launcher
pnpm run test:packed-package    # empaqueta e instala en un proyecto temporal
pnpm run install:rtk            # (re)descarga el binario rtk pinneado
node scripts/trace-brand.mjs isologo|wordmark   # regenera el arte del banner desde assets/brand/
```

Qué es, qué trae, comparativa y benchmarks medidos (system prompt, tokens, rtk): [docs/nub-ia-overview.md](docs/nub-ia-overview.md).
Cómo contribuir (idioma, tests, precedencia, mergeabilidad): [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

Documentación: [referencia técnica](docs/readme-reference.md) (incluye [Organic Driven Development](docs/readme-reference.md#organic-driven-development)),
[la shell](docs/nub-ia-shell.md), [actividad de agentes](docs/nubia-agents-activity.md), [YOLO](docs/yolo-mode.md),
[métricas](docs/telemetry.md). El README original de gentle-shell queda archivado en [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md).

## Licencia y marcas

El código se distribuye bajo la [licencia MIT](LICENSE) del proyecto original.
`gentle-shell`, `gentle-pi` y sus logos son marcas de Alan Buscaglia (ver [`docs/UPSTREAM-TRADEMARKS.md`](docs/UPSTREAM-TRADEMARKS.md));
este fork usa nombre y branding propios conforme a esa política. `Nubiral` y su logo pertenecen a Nubiral.

## Mover el repo a la organización

Hoy vive en `github.com/sebamar88/nub-ia`. Cuando pase a la organización, basta con
`sed -i 's#github.com/sebamar88/nub-ia#github.com/<org>/nub-ia#g' package.json README.md install.sh install.ps1` y actualizar el remote.

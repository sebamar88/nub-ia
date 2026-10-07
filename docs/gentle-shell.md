# La shell de Nub-IA

La shell de Nub-IA es el espacio de trabajo de coding-agent del equipo de Nubiral sobre Pi; no es solo un tema. El paquete integra la barra superior/inferior, el rail de estado, el panel de cambios, el consumo de suscripciones y las vistas de orquestación de subagentes en una sesión de Pi. Para el panorama general empezá por el [README](../README.md); para operar el paquete, por la [referencia técnica](readme-reference.md).

Para desarrollar usá [ODD y recuperación de features](readme-reference.md#organic-driven-development) (Organic Driven Development). El TDD sigue el modo configurado, y antes de entregar corre el review 4R `nub_review`.

Mapa de fuentes: [extensión de la shell](../extensions/nubia-shell.ts), [barra](../lib/shell-bar.ts), [modelo de cambios](../lib/shell-changes.ts), [vista de cambios](../lib/shell-changes-view.ts), [uso](../lib/shell-usage.ts), [extensión de agentes](../extensions/nubia-agents.ts) y [runner de agentes](../lib/agents-runner.ts).

## Requisitos

The current package requires Pi 0.99.1 or newer and Node >=22.19.0. Development tests resolve Pi through the open `>=1.0.0` development range. The private Vim editor adapter admits only the audited Pi `0.99.1`, `0.99.2`, and `1.0.0` releases; any other release keeps ordinary prompt editing until its editor is audited. Nub-IA no actualiza tu Pi instalado. Los procesos hijo deben emitir `agent_settled`.

`GENTLE_PI_SHELL=0` conserva el footer y el editor nativos de Pi.

## Layout en fullscreen

Con 140 columnas o más, fullscreen muestra un header en vivo sobre una división transcript + rail (`lib/shell-sidebar-layout.ts`):

```text
∞ Nub-IA ⟡ ~/work/nub-ia main ⟡ nub-ia/balanced · medium · team        ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub
```

- **Header:** identidad de la sesión a la izquierda (marca, cwd, rama, cantidad de modificados, modelo · esfuerzo · perfil) y dos contadores a la derecha (gauge de contexto y costo). No muestra el estado working/thinking. Si no entra, se degradan primero perfil, luego esfuerzo, luego el grupo cwd/rama/dirty; debajo de eso solo queda la marca.
- **Rail derecho:** desplaza **Status → Changes → TODO**. Las cards cachean su render hasta que cambia su digest.
- **Status:** Project (cwd, rama, nombre de sesión, perfil activo), Changes e Integrations (estados de otras extensiones).
- **Agents** no está en el rail: su card queda sobre el editor, con columnas fijas alineadas a la derecha (`modelo · esfuerzo`, tokens, costo, tiempo); una tarea encolada completa solo la columna de tiempo con `queued`.
- Debajo de 140 columnas no hay sidebar: un header superior configurado se encarga del estado; si no, la barra inferior. El modo regular conserva la barra compacta de una línea y el widget de Agents sobre el editor.

La barra compacta reemplaza el footer de tres líneas de Pi:

```text
∞ nub-ia ⟡ ~/work/nub-ia main ⟡ balanced · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub
```

- El contexto es un gauge: ámbar al 80 %, rojo al 95 %; tras una compactación muestra `?%` hasta la próxima respuesta.
- El costo lleva `sub` si el modelo corre con login de suscripción.
- Los estados que publican otras extensiones con `setStatus` se agregan como segmentos finales. En terminales angostas se descarta primero el nombre de sesión y luego los segmentos.

El prompt sigue el estilo de card elegido (`neon` enmarca el editor con borde redondeado; `float` lo pinta con fondo tonal y una barra `▎`). El indicador muestra `waiting for input`, `working` o `queued` según el estado. Si otra extensión ya instaló un editor propio, la shell no lo toca.

## Panel de cambios (`/nubia:changes`, `alt+g`)

Changes muestra **las operaciones write/edit capturadas de esta sesión y de sus subagentes**. No escanea el repo al iniciar, no lee archivos sin trackear y no hace polling de archivos vivos.

```text
✎ 3 files · +42 −7 · extensions/nubia-shell.ts, lib/shell-bar.ts, tests/x.test.ts · /nubia:changes
```

- Un worktree aparece recién tras una mutación exitosa capturada. Leer, abrir un directorio o lanzar un hijo no cuenta.
- Los diffs comparan el contenido visto antes de la primera operación del agente con su último resultado, no con HEAD. Ediciones externas rompen la continuidad y el archivo se marca **diff unavailable**.
- **La cobertura es deliberadamente limitada a las herramientas write/edit.** Shell, herramientas de mutación custom, salidas fallidas o hijos sin la extensión de captura no generan diff; una fila ausente no significa repo limpio.
- Límites: se lee solo el target, hasta 64 KiB y 2.000 líneas; binarios y archivos enormes muestran "unavailable". Se retienen hasta 256 operaciones y 4 MiB por sesión (al llegar al límite hay advertencia).
- Las capturas se guardan en la sesión (`gentle-pi.session-change/v1`) y se restauran solo para el mismo UUID de sesión; `--no-session` no persiste.
- Visor de dos paneles: worktrees en acordeón a la izquierda, diff a la derecha. `j`/`k` o flechas navegan; `ctrl+j/k` o PgUp/PgDn desplazan el diff; `o`/Enter abre el archivo real en `$VISUAL`/`$EDITOR`; `esc`/`q` cierra. En fullscreen el click selecciona y la rueda desplaza.
- `GENTLE_PI_SHELL_CHANGES_KEY` cambia el atajo (`off` lo deshabilita); `GENTLE_PI_SHELL_CHANGES_POLL_MS` ajusta solo el refresco del overlay abierto.

## Paleta de comandos (`/nubia:commands`, `alt+k`)

Menú curado y agrupado (Configuration, Session, Diagnostics, Skills), no un listado crudo: un comando aparece solo si está en el set curado y registrado. La búsqueda filtra por etiqueta, nombre y descripción; Enter ejecuta como si lo hubieras tipeado. `GENTLE_PI_COMMANDS_KEY` cambia el atajo. Para usar `ctrl+p` hay que liberar antes `app.model.cycleForward` en `~/.pi/agent/keybindings.json`.

## Uso de suscripciones (`/nubia:usage`)

El bar muestra el consumo de la suscripción activa después del costo, y `/nubia:usage` abre un panel con una fila por ventana de cada provider (límite, medidor, porcentaje, reset). `r` refresca (clickeable, igual que `esc`).

```text
∞ codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%
```

- Codex: endpoint de uso de la cuenta con el token OAuth que Pi ya tiene (al iniciar, cada 5 minutos como máximo tras un turno y con `r`). Claude Pro/Max: headers de rate-limit de cada respuesta. Otros providers pueden registrar una fuente con el evento `gentle-pi:usage-source/v1` en `pi.events`.
- Se refresca cada provider que la sesión usa (el del modelo activo y los del perfil de routing vigente). Solo se guardan el nombre del plan y las ventanas; los demás datos de la cuenta se descartan. Los gauges viran a ámbar al 80 % y rojo al 95 %.
- `GENTLE_PI_SHELL_USAGE_KEY` define un atajo; `GENTLE_PI_SHELL_USAGE_TIMEOUT_MS` el timeout.

## Estadísticas (`/nubia:stats`)

Panel a pantalla completa sobre tu historial local de uso, leído de los archivos de sesión que Pi ya escribe (home activo + `~/.pi/agent/sessions`; una sesión presente en ambos cuenta una vez).

- **Overview:** heatmap semanal (hasta 52 semanas), modelo favorito, tokens totales, sesiones, sesión más larga, días activos, rachas, desglose input/output/cache y costo. **Models:** tokens, costo, mensajes y porcentaje por modelo. **Session:** modelo, costo, tiempo, tokens y líneas agregadas/quitadas que capturó Changes.
- `Tab`/`shift+Tab`, `←`/`→` o `1`/`2`/`3` cambian de pestaña; `r` alterna todo el tiempo / 7 días / 30 días; `s` todos los proyectos / solo el actual; `q`/`esc` cierra.
- Solo se leen las sesiones de nivel superior (los subagentes no cuentan). No hay atajo por defecto: definí `GENTLE_PI_STATS_VIEW_KEY` (por ejemplo `alt+t`).

## Estilo de cards

`/nubia:customize` → **Cards** elige el estilo de las cards de conversación y del chrome de la shell; se aplica al instante y se guarda en `card-style.json` del config home (`float` por defecto; no forma parte de los perfiles visuales).

| Estilo | Aspecto |
| --- | --- |
| `neon` | Card con borde redondeado y título de acento. |
| `float` (default) | Panel sin borde sobre el fondo tonal de la herramienta (éxito/info, pendiente, error), con barra `▎` del color del tono, márgenes de una columna y filas en blanco arriba, abajo y entre título y cuerpo. |

Un tema sin fondo de herramienta, o una card de menos de 10 columnas, cae a `neon`. Las tool cards silenciosas (`read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`) muestran su nombre real; colapsadas muestran hasta tres filas de vista previa y se expanden con la tecla indicada en la regla superior. `GENTLE_PI_QUIET_TOOLS=0` deja la presentación de Pi intacta. **Bash:** `quiet-tools` deja la ejecución y la UI de bash a Pi, respetando `shellPath` y prefijos configurados. No habilites a la vez `pi-tool-cards` y `quiet-tools`: Pi rechaza registros duplicados de `read`, `edit` y `write`.

`codemode` usa la misma card **Code**: colapsada muestra hasta ocho llamadas hijas en orden, con estado y duración disponibles; los argumentos y el JavaScript quedan fuera. Los controles de terminal se quitan del texto mostrado (protección contra spoofing, **no** redacción de secretos).

## Herramientas interactivas nativas

- **`ask_user_question`** — de una a cuatro preguntas estructuradas en un cuestionario (2–4 opciones, multi-select, descripciones y previews), como diálogos reales de la TUI.
- **`ask_user_choice`** — una pregunta de selección única, con respuesta libre opcional.
- **`todo`** — seguimiento de plan con la card Todos (abajo).
- **`nub_review`** — review 4R en proceso (`/nubia:review`) con gate de push.
- Compañeros opcionales (se instalan aparte): `gentle-engram` (memoria persistente), `pi-web-access`, `pi-lens`, `pi-intercom`.

## Agents (`/nubia:agents`, `alt+a`)

Las herramientas `subagent_*` y la card de Agents reemplazan al paquete de terceros `pi-subagents-j0k3r` (mientras siga instalado, las herramientas quedan sin registrar y se avisa al iniciar). Los agentes son markdown en `~/.pi/agent/agents/`, `~/.pi/agent/subagents/`, `<cwd>/.pi/agents/` y `<cwd>/.pi/subagents/`; `GENTLE_PI_AGENT_HOME` y luego `PI_CODING_AGENT_DIR` eligen el perfil de agentes.

```text
╭─ ❀ Agents · 1 active · 1 done ─────────────────────────── 1m24s ╮
│ ✓  gentle-ai-explore  map footer sources   balanced ·  34k ·  $0.27 · 25s │
│ ◐  gentle-ai-worker   write shell footer   balanced · 120k · $12.50 · 41s │
╰────────────────────────────────────────────────────────────────────────────╯
```

- Cada subagente es un proceso hijo `pi --mode rpc`: la terminal nunca ejecuta su trabajo; el host aplica deltas a un hilo acotado por tarea. La pregunta de un hijo en modo task llega como un diálogo normal de Pi; la de un hijo en background se descarta. No hay timeout total automático.
- Los hijos (`GENTLE_PI_AGENTS_CHILD=1`) cargan los mismos archivos de contexto que el padre, menos los bloques administrados que los atan al orquestador (lista en `lib/child-context-files.ts`).
- `subagent_run.workspace_root` elige el worktree principal o uno enlazado del mismo clon; `repository_root` elige un repo Git independiente y requiere que un padre interactivo otorgue ese clon. El trabajo en background necesita un padre interactivo/RPC y se rechaza en `pi -p`.
- Un hijo puede usar `subagent_parent_message`: una notificación, o `kind: "query"` que espera una única `subagent_reply` correlacionada hasta 30 segundos (máximo cuatro pendientes por hijo).
- La card muestra solo las tareas de la sesión activa (filas terminadas: un minuto, tres como máximo; ocupa hasta un cuarto de la terminal y el resto se pliega en `… N more · alt+a to view`).
- **Overlay** (`/nubia:agents` o `alt+a`): con 60+ columnas, vista dividida grupos/tareas junto al hilo semántico (`F` lo expande); con 12–59, click en un subagente para ver su hilo. Controles: **Follow** (`f`), **Open session** (`o`, escribe un transcript markdown para `$EDITOR`), **Stop** (`s`, solo tareas propias activas), **Scope** (`a`: hijos directos de esta sesión o todos los orquestadores abiertos). `Escape` retrocede un nivel.
- El historial queda en `~/.pi/agent/gentle-agents/tasks/` (un JSON por tarea, últimas 200) y las sesiones hijas en `~/.pi/agent/gentle-agents/sessions/`. `alt+s` confirma detener las tareas activas o encoladas propias.
- Teclas: `GENTLE_PI_AGENTS_KEY` (colapsar la card, `ctrl+shift+a`), `GENTLE_PI_AGENTS_VIEW_KEY`, `GENTLE_PI_AGENTS_STOP_KEY`; `GENTLE_PI_AGENTS_PI` cambia el comando de Pi de los hijos; `GENTLE_PI_AGENTS=0` desactiva herramientas y card.
- El esquema de actividad para hosts RPC está en [gentle-agents-activity.md](gentle-agents-activity.md).

## Todo

La herramienta `todo` y su card reemplazan a `npm:@juicesharp/rpiv-todo` (las sesiones escritas por él se reproducen en la nueva card).

```text
╭─ ❀ Todos · 1 of 3 ──────────────────────────────────────╮
│ ✓ Add quiet tool rendering                              │
│ ◐ Fix quiet tools conflict · fixing conflict            │
│ ○ Show git bash tails                                   │
╰─────────────────────────────────────────────────────────╯
```

`write` reemplaza la lista entera en una llamada (`add`, `update`, `clear` y `list` quedan para movimientos sueltos); el system prompt de cada turno lleva las tareas abiertas y las reglas (in_progress antes de empezar, done al terminar); una lista que pasa dos turnos sin tocarse se pone ámbar con `stale · N turns`. Una lista terminada queda en pantalla durante el turno en que terminó. `ctrl+shift+t` colapsa la card a la tarea en curso (`GENTLE_PI_TODO_KEY` lo cambia, `off` lo deshabilita); `GENTLE_PI_TODO=0` desactiva herramienta y card.

## Personalización

- **`/nubia:customize`** — apariencia (cards, header/footer), edición Vim, permiso YOLO de sesión y captura del historial de prompts. Ver [yolo-mode.md](yolo-mode.md) y [prompt-history.md](prompt-history.md).
- **Banner de inicio.** `/nubia:banner` abre la configuración del banner (isologo de Nubiral + wordmark `nubiral`); `/nubia:toggle-rose` y `/nubia:toggle-text-logo` muestran/ocultan cada parte de la obra de arte (ambas habilitadas por defecto); `/nubia:banner-color` elige la paleta: `lime` (default), `pink`, `cyan`, `yellow` o `green`. Se guarda en `banner.json` del config home; los cambios aplican en la próxima sesión o con `/reload`.
- **Animaciones.** `/nubia:animations [status|quality|performance|potato]`, política global en `animations.json` (`quality` por defecto). Pi es dueño del repaint de la cola; el banner en curso conserva su política.
- **Vim.** `/nubia:vim enable|disable|status` activa la edición modal del prompt (apagada por defecto). Subconjunto acotado de Vim; `/` en NORMAL va a los slash commands de Pi. Tabla de teclas y límites de versión en la [referencia](readme-reference.md#vim-prompt-editing).
- **Doble Esc.** `/nubia:double-esc-cancel [status|enable|disable]` exige un segundo Esc para abortar un turno en marcha (`esc again to cancel`); con el prompt inactivo y un borrador, dos Esc seguidos (500 ms) lo limpian y queda recuperable con la flecha arriba. Es una preferencia del usuario, nunca la cambia la automatización.
- El config home es `NUB_IA_CONFIG_HOME` (alias heredado `GENTLE_PI_CONFIG_HOME`) o, por defecto, `~/.pi/nub-ia`; los archivos que solo existan en `~/.pi/gentle-ai` se siguen leyendo.

## Proveedores tipo bridge

La continuación de un Claude Bridge inactivo usa el ciclo normal de prompt de usuario. La card de Agents oculta solo el "wake" reservado y único en el transcript interactivo de Pi (supresión solo de TUI: el mensaje sigue en el historial y el contexto). El harness (flujo ODD, identidad, contrato de review) y el bloque de tareas abiertas se agregan a `systemPromptOptions.appendSystemPrompt` en lugar de reemplazar el `systemPrompt`, para que llegue a cualquier provider, bridged o no.

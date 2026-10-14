# Modos de permiso

Un dial, controlado por el humano, para cuánto puede hacer el agente sin preguntar. Se cambia con **Shift+Tab**
(cicla), con `/nubia:mode <modo>`, o desde `/nubia:customize` → Editor. El modelo no puede cambiarlo: cuando un modo le
rechaza una herramienta, le dice que pida el cambio.

| Modo | read / grep / comandos de solo lectura | write / edit | bash que puede mutar | commit / push / PR | Guardrails y data-loss |
| --- | --- | --- | --- | --- | --- |
| ⏸ **plan** | ✔ | ✖ rechazado | ✖ rechazado | ✖ | — |
| ✋ **manual** | ✔ | pregunta | pregunta | pregunta | siempre |
| ✎ **accept-edits** | ✔ | ✔ dentro del repo (fuera pregunta) | pregunta | pregunta | siempre |
| ▶ **auto** (default) | ✔ | ✔ | ✔ salvo guardados | pregunta | siempre |
| 🚀 **yolo** | ✔ | ✔ | ✔ | ✔ (ver [YOLO](yolo-mode.md)) | siempre |

Invariantes:

- Los guardrails de comandos (`confirm`/`block` en `runtime-guardrails.json`), la frontera de pérdida de datos y las
  herramientas `ask_user*` nunca se eximen, en ningún modo. El modo corre **antes** y solo puede sumar preguntas.
- `yolo` es un permiso vivo de la sesión, no un ajuste: entrar al modo yolo pasa por la política YOLO con todos sus
  requisitos (TUI interactiva, sesión viva, clon de Git identificable) y nunca se persiste. Al volver a otro modo, YOLO
  se apaga.
- Los subagentes heredan como mucho el modo del padre, nunca `yolo` (reciben `NUB_IA_PERMISSION_MODE`), y no pueden
  cambiarlo.
- `auto` es el default porque es el comportamiento que Nub-IA tenía antes de los modos.

## Qué cuenta como "solo lectura" en bash

Lista blanca conservadora (`lib/permission-mode-policy.ts`): `git status|log|diff|show|…`, `ls`, `cat`, `grep`/`rg`,
`find`, `pnpm test`/`run typecheck`/`lint`, `node --test`, `pytest`, `go test`, `cargo check`, `gh pr view`,
`docker ps`, `kubectl get`, `terraform plan`, etc. Cualquier redirección (`>`), sustitución (`$(…)`, backticks),
heredoc, `tee`, `sudo`, job en segundo plano (`&`), `sed -i`, o un programa/verbo desconocido convierte el comando en
"mutante". Un falso "mutante" cuesta una confirmación; un falso "solo lectura" podría costar un archivo.

## Configuración

- **Modo de arranque:** `/nubia:mode default <plan|manual|accept-edits|auto>` lo guarda en
  `~/.pi/nub-ia/permission-mode-default.json`. Reload y sesión nueva arrancan ahí.
- **Tope (`max`) y default por política:** sección `permissionMode` de `runtime-guardrails.json`:

  ```json
  { "permissionMode": { "max": "accept-edits", "default": "manual" } }
  ```

  El archivo global (`~/.pi/nub-ia/`) es del usuario; el del repo (`.pi/nub-ia/`) **solo endurece**: puede bajar el
  tope o el default, nunca subirlos. Shift+Tab salta los modos por encima del tope y `/nubia:mode status` muestra de
  dónde sale cada valor. El bloque Project del panel Status muestra `Mode ✎ Accept edits (max Auto · repo)`.

## Rutas protegidas

La sección `paths` de `runtime-guardrails.json` protege rutas del repo con globs (`**`, `*`, `?`, `{a,b}`; un patrón sin
`/` matchea por nombre en cualquier carpeta):

```json
{ "paths": { "deny": [".github/**", "infra/**", "*.lock"], "confirm": ["package.json", "migrations/**"], "readOnly": ["vendor/**"] } }
```

- `deny` (y `readOnly`, su alias): el agente nunca escribe ahí, en ningún modo; `write`/`edit` se rechazan y en bash se
  detectan redirecciones (`>`, `>>`, `tee`) y los operandos de `rm`, `mv`, `cp`, `touch`, `sed -i`, `git checkout --`…
- `confirm`: siempre pregunta, incluso en `auto` y `yolo`.
- El archivo del usuario y el del repo se **unen**: un repo solo puede agregar rutas protegidas, nunca quitarlas.

## Reglas por agente

La sección `agents` de `runtime-guardrails.json` limita qué herramientas puede usar cada subagente (el padre le pasa su
nombre en `NUB_IA_AGENT_NAME`; patrones con `*` para nombre y herramienta):

```json
{ "agents": { "nubia-explore": { "tools": { "write": "deny", "edit": "deny", "bash": "confirm" } }, "review-*": { "tools": { "bash": "deny" } } } }
```

`allow < confirm < deny`; entre el archivo del usuario y el del repo gana la más estricta. Un hijo no tiene UI, así que
`confirm` falla cerrado: el hijo recibe el motivo y debe reportar la acción al orquestador en vez de ejecutarla. El
`tools:` del frontmatter del agente sigue aplicando primero; esto solo quita.

## Límites de delegación

```json
{ "limits": { "maxConcurrentSubagents": 3, "maxSubagentsPerTurn": 6, "blockDelegationOverBudget": true } }
```

`subagent_run` se rechaza (con motivo y alternativa) cuando hay tantos subagentes vivos como `maxConcurrentSubagents`,
cuando el turno ya lanzó `maxSubagentsPerTurn`, o, con `blockDelegationOverBudget`, cuando el presupuesto de modelos
(`budget` en `model-tiers.json`) está excedido. Entre capas gana el número menor / el flag encendido. Distinto de
`max_concurrency` en `subagents.json`, que encola en vez de rechazar.

## System prompt

Los modos agregan al system prompt **una sola línea, y solo en `plan`, `manual` y `accept-edits`**; `auto` (el
default) y `yolo` no agregan nada (YOLO ya tiene su directiva propia). Las rutas protegidas y las reglas por agente no
tocan el prompt: actúan sobre la llamada a la herramienta.

## Shift+Tab

Pi reserva Shift+Tab para `app.thinking.cycle`, y un atajo de extensión sobre una tecla reservada se ignora. Por eso el
home aislado de Nub-IA (`~/.nub-ia/agent`) escribe en `keybindings.json`:

```json
{ "app.thinking.cycle": "ctrl+alt+t" }
```

(solo si vos no habías fijado esa acción; `nub-ia setup` lo aplica a homes existentes). Con `--link` no se toca tu
`~/.pi/agent`: para tener Shift+Tab agregá esa línea a tu `keybindings.json` y hacé `/reload`; si no, `/nubia:mode`
hace lo mismo. En terminales que no entregan Shift+Tab (`ESC [ Z`), ídem.

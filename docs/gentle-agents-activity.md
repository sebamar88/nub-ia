# Actividad de Agents (`gentle-agents.activity/v1`)

Un host RPC interactivo (un cliente que ejecuta `pi --mode rpc`, como la app de escritorio) recibe el estado vivo de los subagentes como un documento JSON acotado por ventana de coalescencia, para dibujar una vista de helpers por chat sin hacer polling de `subagent_status`. Esta página también resume las herramientas de descubrimiento entre orquestadores del mismo perfil.

Fuentes: [publisher](../lib/agents-rpc-publisher.ts), [cableado](../extensions/gentle-agents.ts), [store](../lib/agents-protocol.ts), [búsqueda de trabajo](../lib/orchestrator-work-search.ts).

## Descubrimiento entre orquestadores del mismo perfil

`orchestrator_list` devuelve IDs de ruteo estables más etiquetas de display, workspaces de sesión y hasta ocho tareas hijas vigentes (etiqueta, estado, workspace de lanzamiento). Es una vista de solo metadatos: no exporta prompts, transcripts, razonamiento ni salida de herramientas, y no hace llamadas a modelos ni envía mensajes.

- Los metadatos viven en un sidecar privado opcional de 16 KiB. Solo se publican tareas activas del runtime (running, queued, waiting), no las terminadas. "Reciente" significa dentro de la ventana de heartbeat de 15 segundos; no prueba que el peer sea alcanzable. Las rutas de más de 120 caracteres o que requieren normalización quedan como desconocidas, nunca se recortan.
- **Declarar un sujeto:** al empezar una tarea, llamá `orchestrator_session_id` con un `subject` corto y no sensible. Devuelve el ID de ruteo estable y el alias canónico; usa `setSessionName` solo si el nombre está vacío (máx. 120 caracteres). Los alias son pistas de display, nunca autenticación.
- **Estado curado:** `orchestrator_session_id` acepta `state` opcional con `objective`, `progress`, `decisions` y `blockers` (2.048 bytes UTF-8 en total; el registro completo cabe en 4 KiB). Un objeto reemplaza todo, `null` retira, omitirlo no cambia nada. Nunca incluyas credenciales ni prompts crudos; la lista blanca no es redacción automática de secretos. La lectura devuelve `owner-curated`, `ownerReply: false`, `authority: none`: ni siquiera `decisions` es una autorización.

## Trabajo clasificado

Cuando sirva, publicá una clasificación explícita y no sensible en `orchestrator_session_id.state.work`, por ejemplo
`{"area":"Auth","topic":"Login","tags":["Review"],"refs":[{"kind":"issue","repository":"github.com/Owner/Repo","id":"12"}]}`.
An object replaces the whole state; omission of work clears classification, while
`state: null` withdraws it. Never publish private history as metadata.

- `topic` requiere `area` (64 bytes cada uno); hasta ocho tags y ocho refs. Un ref exige un repositorio público explícito `host/owner/repo` (sin URL ni credenciales) y un ID de hasta 256 bytes; los IDs de issue/PR son decimales positivos canónicos.
- Pass optional `subagent_run.work` explicitly for a child's classification; it is
not inherited. Keep the returned actual task ID: it is **not** a child session ID. `subagent_run.work` solo admite `area`, `topic`, `tags` y `refs`, se valida antes de lanzar, no agrega nada al prompt del hijo y `subagent_continue` no anota. El resultado del lanzamiento informa `workPublication.status`: `recorded` es persistencia local, **no** garantía de anuncio a peers; no relances la tarea para reintentar metadatos.

### Buscar trabajo clasificado

Usá `orchestrator_list.filter: {}` para indexar el trabajo clasificado; sin `filter` la lista ordinaria no cambia. Los criterios `area`, `topic` (requiere area), `tag`, `text` literal, `ref` exacto (repositorio público + kind + ID) y `repository_root` registrado se combinan con AND. Los IDs de issue sueltos no son identidad entre repos. La comparación humana usa NFC, trim y minúsculas.

Para trabajo relacionado: `filter: {"related_to":{"session_id":"<stable owner ID>"}}`,
opcionalmente con `task_id` de una tarea real de la página de catálogo vigente. Add an
existing exact `recipient_session_id`/`cursor` only to inspect that recipient's page;
never automatically page. Source unavailable means no related rows, not refusal.

`possible-*-overlap` significa superposición literal posible, no una dependencia; un `shared-declared-reference` es solo un vínculo tipado declarado, no una aprobación. Los resultados incluyen cobertura (desconocidos, sin clasificar, omitidos, páginas pendientes) y nunca son exhaustivos. Historical classification, unknown reachability and `authority: none`
confer no ownership, consent or permission. Querying needs no helper/model call.

Límites: hasta 64 peers por consulta, una página de catálogo por peer, resultado completo de hasta 16 KiB (se omiten filas enteras con `omittedMatches` exacto). No hay paginado automático ni cursor de consulta.

### Catálogo paginado

Cada peer reciente puede traer `catalog`: ocho resúmenes de hijos (`id`, `label`, `status`, `cwd` registrado) y ocho rutas de raíces registradas. Para seguir, pasá el `recipient_session_id` exacto y el `catalog.cursor` opaco a la misma herramienta.

| Límite | Contrato |
| --- | --- |
| Snapshot | Un archivo `gentle-agents/catalog` privado por publisher, máx. 64 KiB |
| Entradas | Hasta 64 tareas y 64 rutas; ocho de cada una por página, máx. ocho páginas |
| Rutas | Hechos absolutos literales de hasta 256 bytes; con controles o separadores raros quedan `null` |
| Cursor | Hasta 1.024 caracteres; ata sesión, incarnation, activación y digest del catálogo público |

Si cambia el catálogo público, releé desde la primera página. Un cursor de otro recipient, cambiado o malformado devuelve contexto desconocido, nunca una página vieja. Las rutas registradas son hechos del lanzamiento, no identidades Git canónicas ni un inventario exhaustivo de writers.

## Consulta de un snapshot publicado

`orchestrator_consult` con `recipient_session_id` requerido, `kind: "metadata"` (default) y `cursor` opcional devuelve un recibo JSON congelado de hasta 16 KiB (label/workspace públicos, resúmenes de tareas, scope registrado, una página de catálogo, estado curado histórico, hora de observación). Lo faltante es "desconocido", nunca se trunca en silencio. `digest` ata el contenido público a la activación; `recordedAt` es histórico. No se exportan transcripts, prompts, hilos, resultados ni credenciales, y el modo metadata no hace llamadas a modelos, lanzamientos ni mensajes al receptor.

### Razonamiento opt-in de solo lectura

`kind: "reasoning"` con `question` requerida (control-free, hasta 1.024 bytes) hace **una** request a `ModelRegistry.streamSimple` con un prompt estático de solo lectura y el snapshot público. El permiso de costo sale de `ctx.ui.select` en TUI/RPC (Allow once, Allow this target + model for this session, Decline); en JSON/print o sin UI falla cerrado. Entrada hasta 16 KiB, salida 512 tokens / hasta 4.096 bytes, deadline de 20 segundos, sin reintentos y una ejecución a la vez por registry. El consejo es texto no autoritativo (`ownerReply: false`, `authority: none`); un texto que diga "granted" no otorga nada. `kind: "revoke-reasoning"` quita el permiso del recipient sin UI ni modelo. Reload, cambio de sesión/modelo y shutdown limpian los permisos.

## Activar el feed RPC

Poné `GENTLE_SHELL_INTERACTIVE_HOST=1` en el proceso `pi --mode rpc` que el host lanza directamente. Cualquier otro valor (o su ausencia) mantiene RPC headless y el comportamiento de los hijos sin cambios (`isInteractiveRpcHost` en `lib/rpc-host.ts`).

## Transporte

`setWidget` es el único push RPC fire-and-forget con estructura suficiente: en modo RPC acepta `string[]` y se publica como `extension_ui_request`.

```json
{
  "type": "extension_ui_request",
  "method": "setWidget",
  "widgetKey": "gentle-agents",
  "widgetLines": ["{\"schema\":\"gentle-agents.activity/v1\", ...}"]
}
```

`widgetLines` es siempre exactamente una línea: un documento JSON, sin pretty-print.

## Forma del payload

```jsonc
{
  "schema": "gentle-agents.activity/v1",
  "summary": { "running": 1, "queued": 0, "waiting": 0, "finished": 2 },
  "tasks": [
    {
      "summary": {
        "id": "t_abc123", "agent": "explore", "label": "Map the auth module",
        "prompt": "Explore how authentication works…", "status": "running",
        "createdAt": 1732000000000, "startedAt": 1732000000100, "endedAt": null,
        "lastStep": "reading lib/auth.ts", "lastActivityAt": 1732000005000,
        "turns": 2, "toolCalls": 3, "error": null
      },
      "thread": {
        "version": 7, "dropped": 0,
        "items": [
          { "kind": "text", "text": "Looking at the auth flow first." },
          { "kind": "tool", "name": "read", "args": "{\"path\":\"lib/auth.ts\"}", "running": false, "isError": false, "output": "…file contents…" }
        ]
      }
    }
  ]
}
```

`summary` es una lista blanca de campos de `TaskRecord` (`TaskSummary` en `lib/agents-protocol.ts`); los ítems de `thread.items` también son una lista blanca (`text`/`thinking`/`note` con `{ kind, text }`; `tool` con `{ kind, name, args, running, isError, output }`, donde `args` va serializado). Orden: `running`, `waiting`, `queued`, luego las terminadas por `endedAt` descendente.

## Límites

Todos fallan cerrado: lo que no entra se trunca o se descarta, y `encodeActivityLines` nunca lanza.

| Campo | Límite |
| --- | --- |
| `summary.prompt` | 200 caracteres, `…` final |
| `summary.error`, `label`, `lastStep` | 500 caracteres, `…` final |
| `args` / `output` de herramientas | 500 caracteres, `…` final |
| `text` de ítems de hilo | 2.000 caracteres, `…` final |
| `thread.items` por tarea | los últimos 40 |
| payload completo | 256 KiB |

Si aun así se excede el payload, se reduce en orden: 1) se reduce a la mitad el hilo de cada tarea (hasta un ítem); 2) se vacían los hilos de las terminadas; 3) se descartan tareas terminadas enteras, la más vieja primero; 4) por último se vacían los hilos restantes (payload solo de resúmenes). El `summary` de una tarea activa nunca se descarta.

## Progreso de generación y watchdog

Mientras un mensaje del asistente genera un bloque de tool-call, los deltas de argumentos nuevos y no vacíos renuevan el watchdog de inactividad del runner: `summary.lastStep` pasa a `generating tool arguments` y `lastActivityAt` avanza, sin guardar argumentos parciales. `toolCalls` suma recién al empezar la ejecución; tokens y costo se actualizan solo con el `message_end` final. Los presupuestos de silencio son renovables, no límites absolutos de duración.

## Coalescencia

`createRpcActivityPublisher` se suscribe a `TaskStore#subscribeSummary` y a `TaskStore#subscribe(id)` de cada tarea; los cambios dentro de una ventana de 150 ms se colapsan en exactamente un `setWidget("gentle-agents", [línea])`.

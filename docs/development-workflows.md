# Development Workflows

Un **Development Workflow** define cómo una intención se convierte en trabajo acotado. Es independiente del
[modo de permisos](permission-modes.md): el modo responde *qué puede hacer el agente*; el workflow responde *cómo se
da forma y se ejecuta el trabajo*. Cualquier combinación es válida (`svsd` + `auto`, `sdd` + `manual`, `none` + `yolo`).

```text
Nub-IA   = harness de ejecución del agente de código
Workflow = estrategia para convertir intención en trabajo acotado
NONE     = ejecución adaptativa orientada al pedido
SDD      = ejecución delegada orientada a Tasks
SVSD     = ejecución en pareja orientada a Stories
ODD      = disciplina y primitivas de ejecución compartidas
```

ODD **no** es otro workflow compitiendo con estos: es la disciplina que ejecuta cada paso (explorar, trackear,
verificar, delegar), y respeta la unidad de trabajo del workflow activo. Router, subagentes, review 4R, guardrails,
gates de push y auditoría son los mismos en los tres.

| Workflow | Flujo | Unidad | Optimiza | Encaja cuando |
| --- | --- | --- | --- | --- |
| `none` (default) | pedido → ejecución adaptativa | pedido | inmediatez | fixes, cambios chicos y aislados |
| `sdd` | Spec → Design → Tasks → ejecución | Task | delegación | requisitos claros, partes independientes |
| `svsd` | Spec → Backlog → Story → Pair | Story | feedback | la comprensión debe emerger al implementar |

Ninguno es mejor en general. Si entendemos el problema lo bastante como para planificar Tasks útiles, SDD puede ser
mejor; si la comprensión debe emerger implementando, SVSD; si el trabajo es mínimo, sin ceremonia.

## Elegir y persistir

`/nubia:workflow` abre un menú; también `none | sdd | svsd | status | default <workflow>`. La elección vale para la
sesión; `default` la guarda en `<configHome>/workflow.json`. Orden de resolución: `NUB_IA_WORKFLOW` > repo
(`.pi/nub-ia/workflow.json`, `{"schema":"nub-ia.workflow/v1","default":"svsd"}`) > usuario > `none`. Los repos sin
configuración conservan el comportamiento de siempre. Nunca se activa un workflow en silencio.

A diferencia de las políticas de [gobernanza](governance.md), el repo puede *elegir* el workflow: no concede ni quita
permisos, solo agrega una directiva corta al prompt de la sesión principal (los subagentes no la reciben).

## SVSD (Spec-Driven Vertical Slice Development)

Cada fase es una skill cargada bajo demanda y termina en un checkpoint humano; Nub-IA recomienda la siguiente, nunca la
cruza solo.

1. `nubia-svsd-spec`: una capacidad acotada (qué y por qué, sin arquitectura).
2. `nubia-svsd-backlog`: Stories verticales de valor, la primera como walking skeleton; sin criterios todavía.
3. `nubia-svsd-story`: una sola Story con criterios de comportamiento, mini plan de ≤ 5 puntos y Out of Scope.
4. `nubia-svsd-pair`: la IA conduce, el humano navega; pasos chicos con evidencia primero, tests acordados intocables,
   paradas ante decisiones de diseño. La Story **nunca** se convierte en fases horizontales.

El conocimiento también sube: la evidencia de Pair puede enmendar la Story, el Backlog o el Spec, siempre con la
enmienda mínima y la aprobación humana si cambia alcance, comportamiento o invariantes. Los artefactos viven en la
conversación o en `odd/tasks/` si se piden; `.atl/` es el registry de skills (en gitignore) y no se usa para esto.

Los conceptos Backlog → Story → Pair se inspiran en [nschurmann/hola-ai](https://github.com/nschurmann/hola-ai); el
Spec inicial es la diferencia de Nub-IA. No se reutiliza texto.

## SDD

La skill `nubia-spec-design-tasks` reutiliza los agentes existentes (`nubia-explore`, `nubia-worker`, `nubia-verify`); no restaura
los agentes `sdd-*` ni `extensions/sdd-init.ts`, retirados a propósito.

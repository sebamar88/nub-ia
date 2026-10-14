# Gobernanza

Cómo se decide, en Nub-IA, qué puede hacer el agente y con qué modelos, y quién puede cambiarlo.

## Capas y precedencia

```
organización  (~/.pi/nub-ia/org-policy.json, distribuido por `nub-ia update`)
    ▲ solo endurece
repositorio   (.pi/nub-ia/*.json versionados en el repo)
    ▲ solo endurece
usuario       (~/.pi/nub-ia/*.json, /nubia:* comandos)
```

Cada capa **solo puede endurecer** lo que decidió la de abajo: bajar un tope, agregar una ruta protegida, exigir un
review más estricto, acotar providers, reducir un presupuesto. Nunca relajar. Así un clon, un prompt o el propio
modelo no pueden aflojar lo que el equipo fijó, y el equipo no puede aflojar lo que un integrante decidió para sí.

| Política | Usuario | Repo | Org (`org-policy.json`) | Regla de fusión |
| --- | --- | --- | --- | --- |
| Modo de permisos ([doc](permission-modes.md)) | `permission-mode-default.json`, `runtime-guardrails.json → permissionMode` | `permissionMode` | `permissionMode` | tope: el menor; default: el más estricto gana al del usuario |
| Rutas protegidas | `runtime-guardrails.json → paths` | `paths` | `paths` | unión |
| Reglas por agente | `→ agents` | `agents` | `agents` | la más estricta por herramienta |
| Límites de delegación | `→ limits` | `limits` | `limits` | el menor / flag encendido |
| Comandos guardados | `→ guardedCommands` | `guardedCommands` | — | el más estricto (ya existente) |
| Gate de review | `review-gate.json`, `NUB_IA_REVIEW_GATE` | `review-gate.json` | `reviewGate: confirm\|strict` | el más estricto (`off` no es válido para la org) |
| Modelos | — | `model-tiers.json` (ruteo + allowlist + budget) | `modelTiers: { allowedProviders, deniedModels, budget }` | intersección / unión / menor |
| Paquetes aprobados | — | — | `approvedPackages` (lista → avisa; `{ "mode": "enforce", "sources": [...] }` → `nub-ia install` rechaza) | — |

## Política de organización

```bash
nub-ia policy set git:github.com/nubiral/nub-ia-policy        # guarda la fuente y descarga ahora
nub-ia policy set git:github.com/nubiral/policy#main:nub-ia/org-policy.json
nub-ia policy status                                           # fuente, fecha, commit y secciones presentes
nub-ia policy pull                                             # vuelve a descargar (nub-ia update también lo hace)
nub-ia policy clear                                            # quita política y fuente
```

La fuente también puede venir en `NUB_IA_ORG_POLICY` (gana sobre el archivo guardado), útil en CI. El fetch es un
`git clone --depth 1`; si falla, **se conserva la política anterior** y se avisa: una política de org nunca desaparece
porque falló la red. El archivo descargado debe declarar `"schema": "nub-ia.org-policy/v1"`; cualquier otra cosa se
ignora entera (nunca una política parcial).

Ejemplo completo:

```json
{
  "schema": "nub-ia.org-policy/v1",
  "name": "Nubiral",
  "permissionMode": { "max": "auto", "default": "accept-edits" },
  "paths": { "deny": [".github/**", "infra/**"], "confirm": ["package.json"] },
  "agents": { "nubia-explore": { "tools": { "write": "deny", "edit": "deny" } } },
  "limits": { "maxConcurrentSubagents": 4, "blockDelegationOverBudget": true },
  "reviewGate": "confirm",
  "modelTiers": { "allowedProviders": ["amazon-bedrock", "github-copilot"], "budget": { "dailyUsd": 30, "onExceed": "warn" } },
  "approvedPackages": ["npm:@dietrichgebert/ponytail"]
}
```

`/nubia:mode status`, `/nubia:review-mode status` y `/nubia:doctor` dicen de qué capa salió cada valor en vigor.

## Paquetes aprobados

```json
"approvedPackages": { "mode": "enforce", "sources": ["npm:@dietrichgebert/ponytail", "npm:gentle-*", "git:github.com/nubiral/*"] }
```

Los patrones se comparan con la fuente sin versión ni ref (`npm:x@1.2.3` → `npm:x`); `*` comodín. `nub-ia install
<source>` avisa (`warn`, default si es una lista) o rechaza (`enforce`) antes de llamar a `pi install`. Al iniciar una
sesión, la shell avisa una vez si el `settings.json` del home ya declara paquetes fuera de la lista (no puede
descargarlos; `nub-ia remove <source>` los quita). Sin política, todo está aprobado. *Pendiente:* hash de `SKILL.md` al
instalar para detectar cambios posteriores.

## Roles

La org puede decidir **por persona** con `roles` dentro de `org-policy.json`:

```json
"roles": {
  "default": "developer",
  "members": { "lead@nubiral.com": "lead", "*@contractor.example": "contractor" },
  "definitions": {
    "lead":       { "permissionMode": { "max": "yolo" }, "reviewGate": "confirm" },
    "developer":  { "permissionMode": { "max": "auto" } },
    "contractor": { "permissionMode": { "max": "accept-edits" }, "reviewGate": "strict", "limits": { "maxConcurrentSubagents": 1 } }
  }
}
```

El rol se resuelve por `NUB_IA_ROLE` (si la org lo define), si no por el `git config user.email` del repo (entrada exacta,
luego `*@dominio`), si no por `default`. Las secciones del rol **reemplazan las de nivel org del mismo nombre** (así un
lead puede tener más margen que el default de la org); el repo y el usuario conservan su palabra, siempre "solo
endurecer". La identidad es una pista para elegir defaults de la org, no autenticación: nunca otorga nada que la
persona no pudiera darse localmente. `/nubia:mode status` muestra el rol en vigor y de dónde salió.

## Auditoría local

Cada decisión de gobernanza deja una fila JSON en `~/.pi/nub-ia/audit/audit-<AAAA-MM>.jsonl` (schema `nub-ia.audit/v1`,
archivo 0600): confirmaciones aceptadas/rechazadas por el humano (`tool.ask`), rechazos del modo (`tool.deny`), rutas
protegidas (`path.deny`), reglas por agente, límites de delegación (`delegation.deny`), cambios de modo
(`mode.change`, con rol), decisiones del gate de push (`push.gate`) y veredictos de review (`review.verdict`, solo hash
y veredicto). Nunca contiene prompts; los comandos van redactados y recortados a 200 caracteres. Los hijos marcan sus
filas con `child: true`.

```bash
nub-ia audit                 # resumen del mes y las últimas 20 filas
nub-ia audit --month 2026-02 # otro mes
nub-ia audit --json          # todas las filas
```

El panel Status muestra `Audit 2 approved · 1 denied today` cuando hubo decisiones hoy. `NUB_IA_METRICS=off` también
apaga la auditoría (mismo sink local). El envío opcional al endpoint del equipo es T3.3.

## Lo que no es

Ninguna de estas capas es un sandbox: son redes basadas en patrones sobre las herramientas del agente. Para contención
real usá aislamiento del SO/contenedor y credenciales de alcance mínimo. Tampoco se verifica todavía la firma de la
política descargada (roadmap T8.5, junto con la verificación de `nub-ia update`).

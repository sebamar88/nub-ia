# Contribuir a Nub-IA

Guía corta para cambios en este fork. Lo que no está acá sigue las convenciones de [gentle-shell](docs/UPSTREAM-README.md).

## Idioma

| Qué | Idioma | Por qué |
| --- | --- | --- |
| `README.md`, `docs/*.md` de uso (shell, modos, gobernanza, telemetría, CI), mensajes de ayuda del launcher **que lee el equipo** | **Español** (rioplatense neutro, sin regionalismos innecesarios) | El equipo de Nubiral es el lector. |
| Código, identificadores, comentarios, mensajes de commit, mensajes que el **modelo** lee (prompts, directivas, razones de `block`), textos de la TUI, `--help` del launcher, tests, docs técnicos del paquete (`docs/skill-style-guide.md`, `docs/UPSTREAM-*.md`) | **Inglés** | Se mergea con upstream, lo leen los modelos y herramientas, y el código de Pi está en inglés. |
| Skills (`skills/*/SKILL.md`) | Inglés (frontmatter y cuerpo); nombres de sección fijos de la guía de estilo | Las lee el runtime y el modelo. |
| Nombres de archivos, claves JSON, variables de entorno | Inglés | Idem. |

Regla práctica: si lo lee una persona del equipo en el README o la doc, español; si lo lee el modelo, Pi, git o un
mantenedor del upstream, inglés. Los términos técnicos quedan en inglés dentro del español (`review`, `commit`, `push`,
`tier`, `budget`) en vez de traducirlos.

## Cambios

- Un PR por tarea, ≤ ~400 líneas; partir lo que se pase (ver `skills/chained-pr`).
- Cada cambio de comportamiento trae su test (`node --experimental-strip-types --test tests/<nombre>.test.ts`) y toca la
  doc que lo describe (README o `docs/`).
- `pnpm test` (unit + harness), `pnpm run typecheck`, `pnpm run check:runtime-modules` y
  `node scripts/verify-package-files.mjs` deben pasar; CI los corre.
- Archivo nuevo del paquete → agregarlo a `scripts/verify-package-files.mjs`.
- Módulo de `lib/` que use el launcher (`bin/nub-ia.mjs`) → agregarlo a `scripts/build-runtime-modules.mjs` y regenerar
  `runtime/` (`pnpm run build:runtime-modules`).
- Prompts de los lentes de review (`assets/agents/review-*.md`) → `/nubia:review eval` contra los fixtures y actualizar
  `tests/fixtures/review/prompt-pins.json`.
- Mensajes de commit: Conventional Commits (`feat(scope): …`, `fix: …`, `docs: …`), cuerpo en inglés explicando el porqué.

## Precedencia de políticas

Todo lo configurable por repo/org **solo endurece** lo del usuario (ver [docs/governance.md](docs/governance.md)). Un
cambio que permita a un repo o a la org relajar algo es un bug.

## Mantener el fork mergeable

- Lo propio de Nub-IA va en módulos propios (`lib/nubia-*.ts`, `extensions/nubia-permission-mode.ts`,
  `extensions/nub-ia-*.ts`); en los archivos heredados, solo imports y una llamada.
- `node scripts/upstream-diff.mjs` mide la divergencia real tras normalizar el rename `gentle → nubia`.
- El workflow `upstream-sync.yml` intenta el merge cada semana.

# Nub-IA

Shell de coding-agent para el equipo de Nubiral, construida sobre [Pi](https://pi.dev).

Nub-IA es un fork de [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) (paquete `gentle-pi`, MIT).
Mantiene su harness ODD (subagentes enfocados, evidencia TDD, review nativo con `gentle-ai`, skills) con la identidad visual
y la configuración del equipo. No es una distribución oficial de gentle-shell ni está afiliada a sus autores.

## Instalación

Requisitos: Node >= 22.19, pnpm 11, y `pi` (`@earendil-works/pi-coding-agent` >= 0.99.1) instalado o disponible en PATH.

```bash
git clone <URL-DEL-REPO> nub-ia
cd nub-ia
pnpm install          # el postinstall descarga el binario gentle-ai (review nativo)
pnpm link --global    # expone el comando `nub-ia`
nub-ia                # primera ejecución: provisiona ~/.nub-ia/agent automáticamente
```

Para reutilizar tu home de pi existente (sesiones, logins) en lugar del home aislado:

```bash
nub-ia --link
```

## Uso

```
nub-ia [opciones] [-- pi-args...]
nub-ia home [link|isolated|<path>]
nub-ia [selectores de home] setup [--dry-run]
nub-ia install npm:<pkg> | remove <source> | list | update | config | auth <cmd>
```

`nub-ia --help` muestra la referencia completa. Dentro de la sesión:

- `/gentle:banner`, `/gentle:toggle-rose`, `/gentle:toggle-text-logo`, `/gentle:banner-color` — configuran el banner de inicio
  (marca Nubiral + wordmark; paleta por defecto `lime`).
- El tema por defecto es `Nub-IA` (`themes/Nub-IA.json`); se cambia desde `/settings`.

### Variables de entorno

Se conservan los nombres del upstream para no romper la compatibilidad interna:

| Variable | Uso |
| --- | --- |
| `GENTLE_SHELL_HOME` | Directorio del home aislado (default `~/.nub-ia/agent`). |
| `GENTLE_SHELL_PI` | Ruta al ejecutable `pi` a usar. |
| `GENTLE_SHELL_NO_AUTO_SETUP=1` | No provisionar el home automáticamente en el primer arranque. |
| `GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1` | Saltar la descarga de `gentle-ai` en el postinstall (el review nativo deja de funcionar). |

### Guardrails de comandos

`.pi/gentle-ai/runtime-guardrails.json` (versionado) define qué comandos del agente piden confirmación o se bloquean:
`npm publish` está bloqueado (el paquete nunca se publica), y `git push`, `git rebase`, `git branch -D` y `pi remove` piden confirmación.
Se puede sobreescribir por usuario en `~/.pi/gentle-ai/runtime-guardrails.json`.

## Qué cambia respecto a gentle-shell

- Nombre del paquete y comando: `nub-ia` (`bin/nub-ia.mjs`). `private: true`, se instala desde Git, no desde npm.
- Banner de inicio: símbolo infinito de Nubiral en lugar de la rosa, wordmark `nubiral` en lugar de `Gentle Shell`, paleta `lime` por defecto.
- Tema por defecto `Nub-IA` (los temas `Gentle*` siguen disponibles).
- Home aislado en `~/.nub-ia/` (config en `~/.nub-ia/config.json`).
- Workflow de publicación a npm eliminado.

Los identificadores internos (`gentle_review`, `GENTLE_PI_*`, nombres de archivos en `lib/`, comandos `/gentle:*`) se mantienen
tal cual para poder hacer merge de cambios del upstream.

## Mantener sincronizado con el upstream

```bash
git remote add upstream https://github.com/Gentleman-Programming/gentle-shell.git
git fetch upstream
git merge upstream/main
```

## Desarrollo

```bash
pnpm test                       # suite completa
pnpm run typecheck
pnpm run build:runtime-modules  # regenerar runtime/ tras tocar lib/*.ts del launcher
```

Documentación detallada heredada del upstream: [referencia técnica](docs/readme-reference.md), incluida la sección de [Organic Driven Development](docs/readme-reference.md#organic-driven-development), y [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md).

## Licencia y marcas

El código se distribuye bajo la [licencia MIT](LICENSE) del proyecto original.
`gentle-shell`, `gentle-pi` y sus logos son marcas de Alan Buscaglia (ver [`docs/UPSTREAM-TRADEMARKS.md`](docs/UPSTREAM-TRADEMARKS.md));
este fork usa nombre y branding propios conforme a esa política. `Nubiral` y su logo pertenecen a Nubiral.

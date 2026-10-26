# Marca configurable (brand config) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Nubiral cambie nombre, logo, colores, prefijo de comandos y directorio home editando `brand.json` y corriendo un comando de rebrand.

**Architecture:** `brand.json` (raíz) se carga con `lib/brand.ts` (también generado a `runtime/brand.mjs` porque el launcher lo usa antes de que exista TS). Los colores del banner y del tema se derivan de dos colores, con `overrides` para reproducir los valores actuales byte a byte. El arte del banner pasa de constantes en `startup-banner.ts` a `assets/brand/banner-art.json`, generado por el rebrand.

**Tech Stack:** Node >= 22.19 con `--experimental-strip-types` (solo sintaxis borrable: sin `enum` ni parameter properties), `node:test`, Python 3 + Pillow (ya requerido por `trace-brand.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-25-brand-config-design.md`

## Global Constraints

- Con la marca por defecto todo queda idéntico a hoy: mismo banner, mismos comandos, mismo tema, mismo home (`~/.nub-ia/agent`).
- La marca es solo presentación: no toca permission modes, guardrails ni review gate (política solo puede restringir).
- Fuera de alcance: env vars `NUB_IA_*` existentes, nombre del paquete npm, URLs de `package.json`, `docs/`, README. Excepción acordada en este plan: la clave `bin` de `package.json` (ver Task 5).
- Código, comentarios, mensajes y tests en inglés; `docs/` en español.
- `runtime/*.mjs` es generado: agregar `brand` a `sources` en `scripts/build-runtime-modules.mjs` y correr `pnpm run build:runtime-modules`.
- Todo archivo nuevo que se envía va en `scripts/verify-package-files.mjs`.
- Conventional Commits, sin líneas de atribución. Un task por PR (~400 líneas); ver la cadena de PRs al final.
- Defaults: `name "Nub-IA"`, `prefix "nubia"`, `homeDir ".nub-ia"`, `bin "nub-ia"`.

## Review Focus

Entradas que el spec no fija y que más probablemente rompan algo (cada una tiene su test en la task que se indica):

1. `brand.json` inválido o con campo faltante, o `prefix` con mayúsculas, espacios o `:` → error claro con el nombre del campo, sin stack trace (Task 1).
2. Color primario oscuro (p. ej. `#0A0A40`) → texto ilegible sobre fondo oscuro; se espera contraste >= 4.5 (Task 2).
3. Wordmark con otra cantidad de letras o más ancho que la terminal → la animación no tira ni produce NaN, el banner degrada (Task 3).
4. Logo PNG con fondo opaco (sin canal alfa) → el rebrand falla con mensaje, no traza un rectángulo sólido (Task 5).
5. Rebrand corrido dos veces con la misma marca → idempotente, sin diff en `SKILL.md` ni en `package.json` (Task 5).

---

### Task 1: Núcleo de marca

**Files:**
- Create: `brand.json`, `lib/brand.ts`, `tests/brand.test.ts`
- Modify: `scripts/build-runtime-modules.mjs` (agregar `"brand"` a `sources`), `scripts/verify-package-files.mjs` (agregar `brand.json`, `assets/brand/banner-art.json`), `runtime/brand.mjs` (generado)

**Interfaces:**
- Produces:
  - `interface Brand { name: string; prefix: string; homeDir: string; bin: string; colors: { primary: string; accent: string; overrides?: { banner?: Partial<BannerPalette>; theme?: Record<string, string> } }; logos: { wordmark: string; isologo: string }; artwork: string }` (`BannerPalette` se define en Task 2; hasta entonces `unknown`).
  - `class BrandError extends Error`
  - `parseBrand(raw: unknown): Brand` (lanza `BrandError` con el path del campo, p. ej. `brand.json: colors.primary must be #RRGGBB`)
  - `loadBrand(file?: string): Brand` (default: `process.env.NUB_IA_BRAND_FILE`, si no `<raíz del paquete>/brand.json`; la raíz se resuelve igual desde `lib/` y desde `runtime/`)
  - `export const brand: Brand = loadBrand()`
  - `cmd(name: string): string` → `` `${brand.prefix}:${name}` `` y `cmdSlash(name: string): string` → `` `/${cmd(name)}` ``

- [ ] **Step 1: Tests (`tests/brand.test.ts`):** `parseBrand` acepta el `brand.json` del repo y devuelve los defaults de Global Constraints; rechaza con `BrandError` y mensaje que contiene el path del campo: falta `name`, `colors.primary: "red"`, `prefix: "Nubia"`, `prefix: "a b"`, `prefix: "a:b"`, `homeDir` sin punto inicial o con `/`; `cmd("review") === "nubia:review"` con la marca por defecto.
- [ ] **Step 2:** `node --experimental-strip-types --test tests/brand.test.ts` → FAIL (módulo inexistente).
- [ ] **Step 3:** Escribir `brand.json` con los defaults, `colors.primary "#D6FF00"`, `colors.accent "#E9FF5C"` (mi criterio: coincide con `activePink` del tema actual), `logos` apuntando a `assets/brand/nubiral-logo.png` y `nubiral-isologo.png`, `artwork "assets/brand/banner-art.json"`. Implementar `lib/brand.ts` sin dependencias (solo `node:fs`, `node:path`, `node:url`).
- [ ] **Step 4:** `pnpm run build:runtime-modules`, luego `node --experimental-strip-types --test tests/brand.test.ts` → PASS; `pnpm run check:runtime-modules` → OK.
- [ ] **Step 5:** Commit `feat(brand): add brand.json and loader`.

### Task 2: Derivación de colores

**Files:**
- Create: `lib/brand-colors.ts`, `tests/brand-colors.test.ts`
- Modify: `lib/brand.ts` (tipar `overrides.banner` con `BannerPalette`)

**Interfaces:**
- Produces:
  - `type RGB = [number, number, number]`; `interface BannerPalette { rose: RGB; label: RGB; value: RGB; logoFresh: RGB; logoDim: RGB }` (mismas claves que `BANNER_PALETTES` en `extensions/startup-banner.ts`)
  - `contrastRatio(a: RGB, b: RGB): number` (WCAG)
  - `deriveBannerPalette(colors: Brand["colors"]): BannerPalette` (aplica `overrides.banner` encima de lo derivado)
  - `deriveTheme(template: Record<string, unknown>, brand: Brand): Record<string, unknown>` (reemplaza `name` y las vars de `template.vars` que dependen de la marca: `accent`, `deepPink`, `activePink`, `border`, `borderSubtle`, `bgPanel`, `bgElement`, `bgSubtle`, `userMessageBg`; aplica `overrides.theme`)

- [ ] **Step 1: Tests:** (a) con el `brand.json` del repo, `deriveBannerPalette` devuelve exactamente la tupla `lime` actual (`rose [214,255,0]`, `label [170,200,40]`, `value [230,255,120]`, `logoFresh [240,240,240]`, `logoDim [90,100,40]`); (b) `deriveTheme(JSON de themes/Nub-IA.json, brand)` hace `deepEqual` con ese mismo JSON; (c) con `primary "#0A0A40"` y sin overrides, `contrastRatio(label, [10,11,8]) >= 4.5` y lo mismo para `value`; (d) `contrastRatio([0,0,0],[255,255,255]) === 21`.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar. Los valores de `brand.json` `overrides` (banner y theme) deben ser los literales actuales para que (a) y (b) pasen; completarlos en `brand.json`. Derivación para marcas nuevas: `label`/`value` son el primario aclarado/oscurecido en HSL, y si el contraste contra el fondo del tema (`vars.bg`) queda < 4.5 se aclara hasta cumplirlo; `logoFresh` es el blanco cálido fijo `[240,240,240]`; las vars de tinte del tema mezclan el primario al 6-25 % sobre `vars.bg`.
- [ ] **Step 4:** Correr → PASS.
- [ ] **Step 5:** Commit `feat(brand): derive banner palette and theme from brand colors`.

### Task 3: Arte del banner como asset

**Files:**
- Create: `assets/brand/banner-art.json`
- Modify: `extensions/startup-banner.ts` (constantes `TEXT_LOGO`, `ROSE_LARGE_RAW`, `LETTER_WEIGHTS` y `BANNER_PALETTES.lime`), `extensions/nubia-shell.ts:1940` (tabla `bannerColors` duplicada), `tests/startup-banner.test.ts`

**Interfaces:**
- Consumes: `brand`, `deriveBannerPalette` (Tasks 1-2).
- Produces: `assets/brand/banner-art.json` con `{ wordmark: string[], isologo: string[], letterWeights: number[] }`; `startup-banner.ts` exporta `BANNER_PALETTES` (para que `nubia-shell.ts` no repita los RGB).

- [ ] **Step 1: Test de no-regresión primero.** Antes de tocar nada, correr `tests/startup-banner.test.ts` y guardar la salida renderizada del banner (ancho 120) con la marca por defecto como snapshot en `tests/fixtures/banner-default.txt`; agregar test que compara contra él.
- [ ] **Step 2: Tests nuevos:** (a) `banner-art.json` tiene `wordmark.length === 7`, `isologo.length === 7`, `letterWeights` de 7 enteros positivos (valores actuales `[9,11,11,4,6,10,3]`); (b) con un arte de 3 letras (`letterWeights [5,5,5]`) los spans de `buildLetterSpans` cubren `[start, end]` sin huecos ni NaN; (c) `letterWeights: []` produce un único span; (d) un wordmark de 90 columnas con terminal de 60 no lanza.
- [ ] **Step 3:** Mover los tres arrays literales a `banner-art.json` **sin modificarlos**; `startup-banner.ts` los lee en el import (ruta `brand.artwork` relativa a la raíz del paquete). Si un wordmark es más ancho que la terminal, usar el fallback de solo isologo que el banner ya tenga; si no existe, ocultar el wordmark. `BANNER_PALETTES.lime = deriveBannerPalette(brand.colors)`; las otras cuatro paletas no cambian. Reescribir el test actual que extrae las constantes con regex sobre el `.ts` para que lea el JSON.
- [ ] **Step 4:** `node --experimental-strip-types --test tests/startup-banner.test.ts tests/shell-sidebar-banner.test.ts` → PASS, snapshot idéntico.
- [ ] **Step 5:** Commit `refactor(banner): load artwork and lime palette from brand`.

### Task 4: Tema generado + chequeo de CI

**Files:**
- Create: `scripts/build-brand-assets.mjs`, `tests/brand-assets.test.ts`
- Modify: `package.json` (script `check:brand` y `build:brand`), `.github/workflows/ci.yml` (agregar `check:brand`), `themes/Nub-IA.json` (queda igual por el test de Task 2)

**Interfaces:**
- Consumes: `deriveTheme`, `brand`.
- Produces: `node --experimental-strip-types scripts/build-brand-assets.mjs --write|--check`; escribe `themes/<brand.name>.json` y borra el tema generado anterior si el nombre cambió (el nombre anterior sale de `themeFile` en `assets/brand/.applied.json`, que crea la Task 5; hasta entonces el script no borra nada).

- [ ] **Step 1: Tests:** `--check` con el repo actual sale 0; con un `NUB_IA_BRAND_FILE` apuntando a una marca de prueba (`tests/fixtures/brand-acme.json`: `name "Acme"`, `prefix "acme"`, `homeDir ".acme"`, `bin "acme"`, `primary "#2255FF"`) sale distinto de 0 mientras `themes/Acme.json` no exista y 0 después de `--write` en un directorio temporal.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar el script (usa `deriveTheme` sobre la plantilla actual `themes/Nub-IA.json`, que queda como plantilla versionada). Averiguar dónde se fija el nombre de tema por defecto (perfiles en `assets/profiles/`, ajustes que escribe el launcher) y hacer que lea `brand.name`; si la preferencia guardada por el usuario apunta a un tema que ya no existe, cae al tema de la marca.
- [ ] **Step 4:** Correr → PASS; `pnpm run check:brand` → OK.
- [ ] **Step 5:** Commit `feat(brand): generate theme from brand and verify in CI`.

### Task 5: Comando de rebrand

**Files:**
- Create: `scripts/rebrand.mjs`, `tests/rebrand.test.ts`, `assets/brand/.applied.json`
- Modify: `scripts/trace-brand.mjs` (extraer la lógica de trazado a una función reutilizable), `package.json` (script `rebrand`), `skills/nubia-spec-design-tasks/SKILL.md`, `skills/nubia-svsd-spec/SKILL.md` (solo vía el script)

**Interfaces:**
- Consumes: `loadBrand`, `deriveTheme`, el trazado de `trace-brand.mjs`.
- Produces: `pnpm run rebrand -- [--wordmark <png>] [--isologo <png>]`. Pasos del script: (1) trazar los PNG dados y escribir `banner-art.json` con `letterWeights` calculados por huecos de columnas del wordmark (si no hay huecos, un solo peso); (2) copiar los PNG a la ruta de `brand.logos`; (3) correr `build-brand-assets --write`; (4) reescribir `/<prefijoAnterior>:` por `/<prefix>:` en los dos `SKILL.md` usando `.applied.json` (`{ "prefix": "...", "themeFile": "..." }`) como estado del prefijo aplicado, y reescribir la clave `bin` de `package.json`; (5) actualizar `.applied.json`.

Decisiones mías que el spec no fija (revisar): el contrato de los logos nuevos es PNG con fondo transparente, trazados por canal alfa (`a > 128`), uno para el wordmark y otro para el isologo; el predicado por color de `trace-brand.mjs` es específico de los PNG de Nubiral y se conserva solo para esos. Reescribir `bin` en `package.json` amplía el no-objetivo del spec: sin eso, `--help` mostraría un ejecutable que no existe.

- [ ] **Step 1: Tests (en directorio temporal copiado del repo, con `brand-acme.json`):** (a) rebrand con PNG de prueba transparentes → `banner-art.json` cambia y `letterWeights.length` iguala la cantidad de letras separadas por huecos; (b) un PNG opaco (sin alfa) → sale con código 2 y mensaje que contiene "alpha"; (c) segunda corrida con la misma marca → `git diff` vacío sobre `SKILL.md`, `package.json` y `.applied.json`; (d) los `SKILL.md` pasan de `/nubia:` a `/acme:`; (e) `package.json` `bin` pasa a `{"acme": "bin/nub-ia.mjs"}`.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar. Guardar los PNG de prueba mínimos en `tests/fixtures/brand/`.
- [ ] **Step 4:** Correr → PASS.
- [ ] **Step 5:** Commit `feat(brand): add rebrand command`.

### Task 6: Prefijo de comandos desde la marca

**Files:**
- Modify: los 27 sitios `registerCommand(` y los ~60 literales `"nubia:` en `extensions/*.ts` y `lib/*.ts` (los más densos: `extensions/nubia-harness.ts`, `lib/command-palette-catalog.ts`, `extensions/nubia-shell.ts`, `extensions/nub-ia-review.ts`, `extensions/nubia-permission-mode.ts`); `tests/nubia-brand-guard.test.ts` (nuevo)

**Interfaces:**
- Consumes: `cmd`, `cmdSlash` de `lib/brand.ts`.

- [ ] **Step 1: Test guarda (`tests/nubia-brand-guard.test.ts`):** recorre `lib/` y `extensions/` y falla si encuentra el literal `nubia:` fuera de una allowlist explícita (`lib/brand.ts`, `lib/agent-name-migration.ts`, y lo que el paso 3 justifique con un comentario). Mensaje de fallo: lista archivo:línea.
- [ ] **Step 2:** Correr → FAIL listando todos los sitios pendientes (esa lista es el backlog del task).
- [ ] **Step 3:** Reemplazar literales por `cmd("x")` / `cmdSlash("x")`, incluidos los textos que mencionan `/nubia:review` en mensajes y prompts de `nubia-harness.ts`. En `command-palette-catalog.ts` el campo `command` se arma con `cmd(...)`.
- [ ] **Step 4:** `pnpm test` completo → PASS (incluye `prompt-pins.json` con la marca por defecto, que no debe cambiar).
- [ ] **Step 5:** Commit `refactor(commands): derive command prefix from brand`.

### Task 7: Nombre visible desde la marca

**Files:**
- Modify: las ~170 apariciones del literal `Nub-IA` en `lib/` y `extensions/` (≈70 archivos; las más densas: `extensions/nubia-harness.ts` 66, `extensions/nubia-shell.ts`, `lib/nub-review.ts`, `extensions/nubia-agents.ts`, `extensions/nub-ia-review.ts`); `tests/nubia-brand-guard.test.ts` (extender)

**Interfaces:**
- Consumes: `brand.name`.

- [ ] **Step 1:** Extender el test guarda: falla con el literal `Nub-IA` en `lib/` y `extensions/` fuera de la allowlist (`lib/brand.ts`, módulos de lectura de rutas legacy como `lib/config-home.ts` y `lib/agent-name-migration.ts` si justifican el literal).
- [ ] **Step 2:** Correr → FAIL (backlog).
- [ ] **Step 3:** Reemplazar por `brand.name`. Los textos que pinea `prompt-pins.json` se comparan con la marca por defecto, así que no cambian.
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `refactor: render product name from brand`.

### Task 8: Home y binario desde la marca (launcher)

**Files:**
- Modify: `lib/nubia-launcher.ts:243,277` y los textos de ayuda (`:1179`, `:1222`), `bin/nub-ia.mjs` (textos de ayuda y mensajes; el marcador `.nub-ia-home` y el lock `.nub-ia-setup.lock` son archivos internos y no cambian), `lib/builtin-codemode-optout.ts`, `scripts/bench-prompt.mjs`, `runtime/nubia-launcher.mjs` (regenerar), `tests/nubia-launcher.test.ts`

**Interfaces:**
- Consumes: `brand.homeDir`, `brand.bin`, `BrandError`. El launcher importa `runtime/brand.mjs`.

- [ ] **Step 1: Tests:** (a) con la marca por defecto `resolveHome` y `launcherConfigPath` devuelven las mismas rutas de hoy; (b) con `NUB_IA_BRAND_FILE=tests/fixtures/brand-acme.json` devuelven `~/.acme/agent` y `~/.acme/config.json`; (c) `bin/nub-ia.mjs --help` con la marca de prueba imprime `acme` y no `nub-ia` en la línea de uso; (d) con un `brand.json` roto el proceso sale con código 2 y el mensaje contiene el path del campo, sin stack trace.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar; en `bin/nub-ia.mjs`, capturar `BrandError` al arrancar y salir con 2. Regenerar `runtime/`.
- [ ] **Step 4:** `pnpm test`, `pnpm run check:runtime-modules` → PASS.
- [ ] **Step 5:** Commit `feat(launcher): resolve home and binary name from brand`.

### Task 9: Prueba de punta a punta y docs

**Files:**
- Create: `docs/branding.md`, `tests/brand-e2e.test.ts`
- Modify: `CLAUDE.md` (una línea en Architecture), `docs/nub-ia-overview.md` (enlace)

- [ ] **Step 1: Test e2e:** en un directorio temporal copiado del repo con `brand-acme.json` aplicado vía `pnpm run rebrand`, cargar las extensiones con el harness (`tests/runtime-harness.mjs`) y verificar: los comandos registrados empiezan con `acme:` y ninguno con `nubia:`; el banner renderizado contiene el arte nuevo; el tema `Acme` existe; `--help` dice `acme`.
- [ ] **Step 2:** Correr → debe pasar tras las Tasks 1-8; si falla, el fallo es un literal que quedó sin migrar.
- [ ] **Step 3:** Escribir `docs/branding.md` en español: qué contiene `brand.json`, el contrato de logos (PNG transparente, dos archivos), los comandos `pnpm run rebrand` y `pnpm run check:brand`, y qué NO cambia (env vars, nombre del paquete, docs).
- [ ] **Step 4:** `pnpm test`, `pnpm run typecheck`, `pnpm run check:brand`, `node scripts/verify-package-files.mjs`, `pnpm run test:packed-package` → todo OK.
- [ ] **Step 5:** Commit `docs(brand): document branding workflow`.

## Cadena de PRs (≤400 líneas cada una)

1. Tasks 1-2 (núcleo y colores) · 2. Tasks 3-4 (banner y tema) · 3. Task 5 (rebrand) · 4. Task 6 (comandos; si supera 400 líneas, dividir por archivo) · 5. Tasks 7-8 (nombre y launcher) · 6. Task 9 (e2e y docs).

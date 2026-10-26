# Branding — cambiar la marca del shell

Nub-IA es presentación configurable: nombre, prefijo de comandos, home, binario, colores y logos salen de un único archivo, `brand.json`, en la raíz del repo. Sirve para armar una demo o una venta con la marca del cliente sin tocar código. La marca es solo presentación: no cambia permisos, `review`, `push` gate, `tier`s ni ninguna política.

## Qué contiene `brand.json`

| Campo | Qué es | Ejemplo (default) |
| --- | --- | --- |
| `name` | Nombre visible del producto (banner, mensajes, tema). También nombra el archivo del tema generado: `themes/<name>.json` | `Nub-IA` |
| `prefix` | Prefijo de los slash commands: `/<prefix>:status`, `/<prefix>:workflow`, etc. Minúsculas, dígitos y `-`, empezando con letra (igual que `bin`) | `nubia` |
| `homeDir` | Directorio de home bajo `$HOME`; el home aislado queda en `~/<homeDir>/agent` | `.nub-ia` |
| `bin` | Nombre del comando que el usuario ejecuta; se muestra en `--help` y en las sugerencias | `nub-ia` |
| `colors.primary` | Color principal, `#RRGGBB`. De acá se deriva la paleta del banner y el tema | `#D6FF00` |
| `colors.accent` | Color de acento, `#RRGGBB` | `#E9FF5C` |
| `colors.overrides.banner` | Opcional. Valores RGB explícitos (`rose`, `label`, `value`, `logoFresh`, `logoDim`) que reemplazan los derivados | ver `brand.json` |
| `colors.overrides.theme` | Opcional. Colores del tema Pi (`accent`, `border`, `bgPanel`, ...) que reemplazan los derivados | ver `brand.json` |
| `logos.wordmark` | Ruta del PNG del wordmark (el nombre escrito) | `assets/brand/nubiral-logo.png` |
| `logos.isologo` | Ruta del PNG del isologo (el símbolo) | `assets/brand/nubiral-isologo.png` |
| `artwork` | Ruta del JSON con el arte del banner ya trazado | `assets/brand/banner-art.json` |

Los `overrides` siempre ganan sobre lo derivado. Para una marca nueva alcanza con `primary` y `accent`: si dejás `overrides` del Nub-IA original, el banner y el tema conservan el lima aunque cambies `primary`. Borrá `overrides` o reemplazalos.

`brand.json` se valida al arrancar: un campo inválido corta con un error claro (exit 2) en vez de arrancar a medias.

## Contrato de logos

- Dos archivos PNG: uno de wordmark y otro de isologo.
- **Fondo transparente.** El arte se traza por canal alpha (`a > 128`): lo opaco es tinta, lo transparente es vacío. Un PNG sin transparencia no se puede trazar; `rebrand` termina con exit 2 y un mensaje que menciona `alpha`.
- El wordmark se traza a 7 filas de alto, igual que el isologo, para que queden uno al lado del otro. La columna del banner es angosta (unos 60 caracteres entre isologo y wordmark): usá logos de proporción parecida a los de Nubiral; un wordmark muy ancho se recorta en el banner desde la izquierda. Si el wordmark trazado supera ese ancho (`MAX_WORDMARK_WIDTH`, 60 columnas, en `lib/brand.ts`), `rebrand` imprime un warning en stderr con el ancho obtenido y el límite (no es fatal, el exit code no cambia): usá una proporción más angosta o menos filas.
- Una letra por peso de animación: `letterWeights` se calcula a partir del ancho de cada letra del wordmark.

## Cómo cambiar de marca para una demo o una venta

1. Editá `brand.json`: `name`, `prefix`, `homeDir`, `bin`, `colors.primary` y `colors.accent`. Quitá o reemplazá `colors.overrides`.
2. Aplicá la marca, con los logos si los cambiás (hace falta Python 3 con Pillow solo cuando pasás PNGs):

   ```bash
   pnpm run rebrand -- --wordmark ruta/wordmark.png --isologo ruta/isologo.png
   ```

   Sin flags solo re-aplica `brand.json` (prefijo, `bin`, tema) y deja el arte como está. Es idempotente: correrlo dos veces no cambia nada más.
3. Verificá que lo generado esté al día:

   ```bash
   pnpm run check:brand
   ```

4. Probalo: `node bin/nub-ia.mjs --help` debe decir tu `bin` y `~/<homeDir>/agent`; abrí el shell y revisá banner y `/<prefix>:status`. Corré `pnpm test` antes de commitear. El test `tests/brand-e2e.test.ts` hace esta misma pasada completa sobre una copia temporal con una marca de prueba.

Para volver a Nub-IA, restaurá `brand.json` y los logos originales (`git checkout`) y corré `pnpm run rebrand` sin flags.

## Qué se regenera y qué se edita a mano

| Qué | Cómo se actualiza |
| --- | --- |
| `assets/brand/banner-art.json` (arte y `letterWeights`) | Lo escribe `rebrand` al recibir PNGs |
| `assets/brand/nubiral-logo.png`, `nubiral-isologo.png` (o las rutas de `logos`) | `rebrand` copia ahí los PNGs recibidos |
| `themes/<name>.json` | Generado desde `colors` y `assets/brand/theme-template.json` (`pnpm run build:brand`). `rebrand` borra el tema generado de la marca anterior |
| `/<prefix>:` en `skills/nubia-spec-design-tasks/SKILL.md` y `skills/nubia-svsd-spec/SKILL.md` | `rebrand` reescribe el prefijo anterior por el nuevo |
| `bin` de `package.json` | `rebrand` lo reescribe a `{ "<bin>": "bin/nub-ia.mjs" }` |
| `assets/brand/.applied.json` | Estado de la última aplicación (prefijo y tema previos); no se edita a mano |
| `brand.json`, `assets/brand/theme-template.json` | A mano |

Los comandos, el nombre y el home en el código no se reescriben: se leen de `brand.json` en tiempo de ejecución (`lib/brand.ts`; el launcher usa `runtime/brand.mjs`, generado). La CI corre `check:brand` para asegurar que lo generado coincide con `brand.json`: el tema (`build-brand-assets --check`) y, con `rebrand --check` (no escribe nada), el prefijo de los dos `SKILL.md`, el `bin` de `package.json`, `.applied.json` y la forma de `brand.artwork` (`wordmark: string[]`, `isologo: string[]`, `letterWeights: number[]`).

## Límites conocidos

- **Textos estáticos para el modelo**: el system prompt se arma a partir de `assets/orchestrator.md`, `assets/orchestrator-tracking.md`, `assets/agents/review-*.md`, `assets/agents/jd-*.md`, `assets/agents/nubia-worker.md` y los skills `nubia`, `nubia-grill-me`, `nubia-spec-design-tasks`, `branch-pr`, `chained-pr`, `work-unit-commits` y `skill-creator`, que dicen "Nub-IA" en texto fijo. Esos textos **no se sustituyen** tras un rebrand: solo se reescribe el prefijo `/nubia:` en los dos `SKILL.md` de workflow. Si querés que el modelo vea el nombre nuevo, editá esos archivos a mano.
- **Variables de entorno**: siguen siendo `NUB_IA_*`; no cambian con la marca.
- **Paquete y documentación**: el nombre del paquete npm (`nub-ia`), las URLs, `README.md` y el resto de `docs/` no se tocan.
- **Tema guardado**: si un usuario ya tenía guardado el tema con el nombre de la marca anterior en sus settings, no se migra solo; debe elegir el nuevo tema.
- **Home existente**: si cambia `homeDir`, el home `~/.nub-ia` anterior no se migra ni se copia; el shell arranca con un home nuevo.
- **Menciones en minúscula**: algunos textos en prosa siguen diciendo `nub-ia` (por ejemplo los mensajes de instalación de `rtk`, `rtk-rewrite` y el skill-registry), igual que el prompt de `review` headless que ve el modelo (`nub-ia headless review`).
- **Mensajes de wake**: las burbujas de wake de subagentes guardadas en sesiones creadas con una marca no-default anterior no se reconocen tras un rebrand, así que se ven en el historial. Solo se reconoce el texto del Nub-IA original y el de la marca actual.
- **`NUB_IA_BRAND_FILE`**: apunta a otro archivo de marca en lugar de `brand.json`. Existe como seam de test (lo usan `rebrand.test.ts` y `brand-e2e.test.ts`); no es una opción de uso normal.

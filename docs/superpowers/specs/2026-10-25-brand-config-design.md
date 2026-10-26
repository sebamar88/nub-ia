# Marca configurable (brand config) — diseño

## Intención

Hoy la identidad visual de Nub-IA (nombre, logo, colores, prefijo de comandos, directorio home) está repartida en decenas de archivos. Nubiral quiere poder ofrecer el producto con otra marca, o personalizarlo para una demo o una venta, cambiando **un solo lugar** y los logos, sin tocar código.

El cambio lo hace Nubiral, en el momento de preparar una demo o cerrar una venta. Tiene que ser un paso de minutos.

## Objetivos

- Un único archivo de marca (`brand.json`, raíz del repo) que define todo lo visible por el usuario.
- Cambiar de marca = editar ese archivo + entregar los PNG de logo + correr un comando de rebrand. Nada más.
- Alcance: lo que ve el usuario.
  - Nombre visible del producto.
  - Logos del banner de arranque (wordmark e isologo).
  - Colores institucionales (banner y tema de la TUI).
  - Prefijo de los comandos slash (hoy `/nubia:*`).
  - Nombre del directorio home (hoy `~/.nub-ia`) y nombre del binario en `--help`.

## No-objetivos

- Env vars `NUB_IA_*` (105 distintas). Casi no las ve el usuario final y renombrarlas rompe scripts y CI. Fuera del primer alcance.
- Nombre del paquete npm y URLs de `package.json`: no se pueden leer dinámicamente. Un script de rebrand podría reescribirlos, pero no es parte de este diseño.
- Docs bajo `docs/` y README.
- Migración automática de usuarios con un `~/.nub-ia` existente (ver riesgos).

## Anti-objetivos (fracaso aunque "funcione")

- Que un repo u org pueda aflojar políticas vía la marca. La marca es solo presentación: no toca permission modes, guardrails ni review gate (invariante de precedencia de políticas del repo).
- Que cambiar la marca exija editar código fuente o regenerar a mano arrays pegados en `.ts`.
- Dos fuentes de verdad para los colores (archivo de marca + tema editado a mano).

## Estado actual (hallazgos verificados)

- `scripts/trace-brand.mjs` ya convierte los PNG de `assets/brand/` (`nubiral-logo.png`, `nubiral-isologo.png`) a arte de terminal: wordmark en bloques de cuadrante, isologo en braille. El resultado está pegado a mano en `extensions/startup-banner.ts` (`TEXT_LOGO` y el isologo). No está verificado si el script acepta un PNG arbitrario o solo estos dos.
- Colores: paleta `lime` con RGB fijos y cuatro alternativas (`pink`, `cyan`, `yellow`, `green`) en `startup-banner.ts`; el tema `themes/Nub-IA.json`; el lima `214,255,0` repetido en `extensions/nubia-shell.ts`.
- Home: la ruta se arma en `lib/nubia-launcher.ts:243` y `:277`; el resto son textos de ayuda y el marcador `.nub-ia-home` (`bin/nub-ia.mjs`).
- Comandos: unas 130 apariciones literales de `nubia:` en ~15 archivos de `lib/` y `extensions/` (`nubia-harness.ts`, `command-palette-catalog.ts`, `nubia-shell.ts`, `nub-ia-review.ts`, `nubia-permission-mode.ts`, etc.), registradas con `pi.registerCommand("nubia:...")`. Además hay referencias en `skills/*/SKILL.md` y prompts, que son texto estático.

## Decisiones tomadas (por el usuario)

- Alcance = todo lo visual: nombre, banner/logo, colores, prefijo de comandos, directorio home.
- Env vars internas quedan fuera.
- Quien cambia la marca es Nubiral, en demo o venta.
- El prefijo de comandos se sustituye también en los textos fijos: `SKILL.md`, prompts y `assets/agents`. El modelo no debe recomendar comandos que ya no existen. Esto obliga a resolver cómo se sustituye (al cargar o al generar) y a actualizar los tests que fijan prompts (`prompt-pins.json`) para que validen con la marca por defecto.

## Decisiones de diseño tomadas por mí (revisar)

- **Campos separados, no un solo slug.** `prefix` (hoy `nubia`), `homeDir` (hoy `.nub-ia`) y `bin` (hoy `nub-ia`), con esos valores como defaults. Un solo slug no reproduce los valores actuales y el criterio de éxito exige marca por defecto idéntica a hoy.
- **Una marca por checkout.** Se edita `brand.json` en un checkout o fork por entrega (demo o cliente) y se reinstala. El archivo se lee en runtime desde la raíz del paquete. No hay varias marcas en una misma instalación.
- **Sin migración del home anterior.** Con la marca por defecto nada cambia; las demos son instalaciones limpias. Un cliente que cambie de marca empieza con home nuevo.
- **Tema generado y versionado.** `themes/Nub-IA.json` se commitea generado, con chequeo en CI como `runtime/`. El nombre del tema sigue a la marca. Si la preferencia guardada del usuario apunta al nombre viejo, se cae al tema por defecto de la marca.

## Decisiones de diseño propuestas (mi criterio, no confirmadas)

- Formato: `brand.json` en la raíz, validado al cargar. Campos mínimos: nombre visible, `prefix`, `homeDir`, `bin`, colores primario y acento, rutas a los dos logos.
- Una sola función de carga en `lib/` (pura, testeable); las extensiones la usan y no tienen strings fijos. Un helper arma los nombres de comando desde el slug.
- La paleta del banner (`label`, `value`, `logoDim`) se deriva del primario y el acento. Se puede sobreescribir cada valor a mano en el archivo de marca.
- `themes/Nub-IA.json` se genera desde el archivo de marca, no se edita a mano.
- Las paletas alternativas del banner (pink, cyan, yellow, green) siguen como opciones del usuario.
- El comando de rebrand toma los PNG nuevos, regenera el arte del banner (reutilizando `trace-brand.mjs`) y lo guarda como asset que el banner carga, en lugar de estar pegado en el `.ts`.
- Si cambia la marca, el launcher importa módulos desde `runtime/*.mjs` (generados): cualquier lógica nueva que el launcher use entra en la lista `sources` de `scripts/build-runtime-modules.mjs`.

## Riesgos y puntos abiertos

- Un usuario con `~/.nub-ia` existente pierde configuración y sesiones si `homeDir` cambia. Decidido: no se migra (ver decisiones arriba). Con la marca por defecto no hay impacto.
- Los `SKILL.md`, prompts y agentes nombran los comandos en texto fijo. Decidido: se sustituye el prefijo. Queda al implementador elegir entre sustituir al cargar o generar en el rebrand, con la restricción de que los tests que fijan prompts sigan pasando con la marca por defecto y que el empaquetado (`verify-package-files`, `test:packed-package`) siga en verde.
- Contraste: colores derivados de una marca ajena pueden quedar ilegibles sobre fondo oscuro. Mitigación: validar contraste mínimo o permitir override manual.
- El usuario con un `/nubia:*` memorizado o en scripts deja de tenerlo si cambia el prefijo.

## Lo que se deja al implementador

- Esquema exacto y nombres de campos de `brand.json`.
- Algoritmo de derivación de la paleta.
- Dónde se guarda el arte generado y cómo se carga.
- Orden de migración de los ~15 archivos y estrategia de tests.
- Cómo se implementa el comando de rebrand (script `node` o subcomando del launcher).
- Mecanismo de sustitución del prefijo en textos estáticos (al cargar o al generar).

## Criterio de éxito

Con la marca por defecto, el producto se ve y se comporta igual que hoy (misma salida del banner, mismos comandos). Con una marca de prueba distinta (otro nombre, otros colores, otro logo, otro slug), el banner, los colores, los comandos `/<prefijo>:*`, el directorio home y el `--help` reflejan la nueva marca, sin editar código y con la suite de tests en verde.

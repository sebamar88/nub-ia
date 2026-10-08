# Historial de prompts

El historial guarda los prompts enviados por cada instancia de Pi, puede importar historial viejo y transcripts de sesión del proyecto, y permite borrar prompts desde el selector. Las sesiones con captura activa consolidan los archivos del proyecto al cerrar (ver "Compactación").

## La captura es opt-in

La grabación está **apagada por defecto**: un prompt puede contener secretos, así que no se guarda nada salvo que lo habilites.

1. Ejecutá `/nubia:customize` y abrí la categoría **History**.
2. Elegí **Prompt history capture: enable** (o **disable**) y presioná Enter o Espacio. Resaltar una fila solo previsualiza.
3. Aplica desde el próximo prompt; no hace falta reiniciar Pi.

La preferencia es global: `<configHome>/history-capture.json` con la forma estricta `{"schema":"gentle-pi.history-capture/v1","policy":"on"}` (u `off`), escrita de forma atómica y fuera de los perfiles visuales. `configHome` es `NUB_IA_CONFIG_HOME` o, por defecto, `~/.pi/gentle-ai` (ruta heredada del upstream). Para una sola sesión: `NUB_IA_HISTORY_CAPTURE=1 nub-ia`.

| Situación | Captura |
| --- | --- |
| `NUB_IA_HISTORY_CAPTURE` = `1`, `true` u `on` | activa, diga lo que diga Customize |
| `NUB_IA_HISTORY_CAPTURE` = `0`, `false` u `off` | apagada |
| Variable sin definir, vacía u otro valor | la preferencia de Customize |
| Sin preferencia guardada | apagada |
| Archivo malformado o ilegible | apagada (falla cerrado) |

Los valores se recortan y no distinguen mayúsculas. Un archivo malformado se reporta y Customize nunca lo reescribe: arreglalo o borralo a mano. El chequeo se hace por prompt. Con la captura apagada la extensión está inerte: no crea registro ni archivos, y el selector solo avisa qué control decide.

## Migración e importación (también opt-in)

Una sesión con captura activa intenta migrar el historial viejo del editor y hacer un bootstrap único desde los transcripts del proyecto poco después de cargar la extensión. Crea **copias nuevas y buscables** en `~/.pi/agent/history`; los transcripts originales no se modifican. Apagar la captura no borra lo ya importado. La migración toma el directorio `history-global.jsonl.migration-lock`; si un proceso de Pi muere en esa ventana, el lock queda y la migración se saltea hasta que lo elimines a mano.

## Dónde viven los archivos

Todo está bajo `~/.pi/agent/history/`:

- `registry.json` — mapa orientativo hash de proyecto → cwd (para etiquetas).
- `projects/<hash>/<instancia>.jsonl` — un archivo append-only por proceso de Pi.
- `projects/<hash>/seed.jsonl` — importación única de transcripts del proyecto.
- `projects/<hash>/compact-<pid>-<ts>.jsonl` — archivos viejos fusionados por compactación.
- `history-global.jsonl` — prompts importados del historial legacy del editor.
- `hidden.json` — registros de borrado (tombstones).

`<hash>` son los primeros 16 hex del SHA-256 del cwd canonicalizado. Cada línea es un prompt enviado: `{"v":1,"text":"el prompt tal cual","ts":1700000000000}`. Los prompts tipo comando (`/nombre ...`) y las líneas vacías nunca se capturan.

**Quién puede leerlos.** Es JSONL plano en tu disco, sin cifrar y con permisos por defecto del proceso (típicamente `0644`): cualquier proceso de tu usuario puede leerlo. Tratalo como sensible: guarda tus prompts textuales. Apagar la captura no borra nada; para eliminar el almacén:

```bash
rm -rf ~/.pi/agent/history                      # todo el almacén
rm -rf ~/.pi/agent/history/projects/<hash>      # un proyecto (ver registry.json)
```

## Selector

- `Home`/`End` con el buscador vacío mueven la selección (`End` carga todo y va al más viejo); con texto en el buscador mueven el cursor del texto y no tocan la lista.
- Tiene siempre 30 filas. El header se adapta al ancho (ancho / medio / angosto: en angosto la lista muestra 9 prompts y el radio `◉ Current project | ○ All projects` se acorta). En fullscreen con sidebar visible (140+ columnas) el selector queda en la columna del editor.

## Borrado

La tecla de borrado (`ctrl+shift+backspace`) pide confirmación en dos pasos: la primera pulsación **arma** el borrado de la fila seleccionada (pie: "Delete this prompt from history (y/n)? Prompt stays in session log"); luego `y` ejecuta, `n` o `Esc` cancelan y cualquier otra tecla se ignora.

Se borra por identidad: espacios colapsados, recorte y sin distinguir mayúsculas; solo ese prompt exacto. 1) **Se eliminan las copias del almacén** (proyecto actual: `<instancia>.jsonl` y `seed.jsonl`; alcance global: todos los proyectos y `history-global.jsonl`), reescribiendo cada archivo de forma atómica; nunca se eliminan archivos aunque queden vacíos, y las líneas que otra instancia agregue durante el reescrito se preservan. 2) **Se escribe un tombstone** en `hidden.json` para que el prompt siga oculto y el bootstrap no lo reimporte. Los transcripts de sesión nunca se modifican. Borrar requiere captura activa.

`hidden.json` es un array JSON de strings (más viejo primero); cada borrado agrega `sha256:` + el digest del prompt normalizado, así que no guarda el texto borrado. Se leen entradas de texto plano de versiones anteriores (primeros 120 caracteres normalizados). Es una caché acotada a **1000 entradas**. Si existe pero no es confiable (ilegible, corrupto o no-array), el historial se bloquea con una advertencia, el bootstrap espera y los borrados se niegan: restaurá o borrá el archivo tú mismo (los prompts ocultos podrían reaparecer).

**Fallos.** Siempre se muestra una notificación de error y nunca se informa un borrado limpio falso: si falla antes de tocar archivos no se elimina nada ni se escribe tombstone; si algunos archivos no se pueden reescribir, el resto se limpia y el tombstone igual se escribe (pueden quedar copias en disco); si falla el tombstone tras borrar copias, el prompt puede reaparecer desde los transcripts; si pasan ambas cosas, un único aviso lo dice.

## Compactación

Mantiene chico el número de archivos por proyecto. Es mantenimiento, **no un límite de retención**: nunca descarta un prompt visible por antigüedad o cantidad. Corre al cerrar una sesión con captura activa, solo para el proyecto actual, cuando su directorio tiene **más de 50 archivos** o **más de 5000 entradas**:

- Los **10 archivos más nuevos** (por timestamp de la entrada más reciente) quedan como están.
- Los más viejos se fusionan, del más antiguo al más nuevo, en un único `compact-<pid>-<ts>.jsonl`, escrito completo (archivo temporal + rename) antes de eliminar los fusionados. Solo corre si hay al menos **dos** archivos para fusionar.
- Nunca se fusionan `seed.jsonl` ni el archivo de la sesión que está cerrando; `history-global.jsonl` queda fuera.
- Los prompts con tombstone no se copian al compacto. Si `hidden.json` no es confiable, se saltea la compactación.
- Cada archivo se renombra a un nombre de reclamo (`<nombre>.gc-<pid>-<ts>.jsonl`) antes de leerse, de modo que un append posterior de otra instancia abre un archivo nuevo; las líneas completas escritas después se agregan al compacto antes de quitar el reclamo. Los fallos nunca pierden prompts: un archivo ilegible queda intacto y, si no se puede escribir el compacto, los reclamos siguen en disco y se leen igual (el selector elimina duplicados).

Los prompts salen del almacén solo por el flujo de borrado o cuando eliminás archivos a mano.

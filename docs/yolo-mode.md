# Permiso YOLO de sesión

> 🚀 **Máxima velocidad, las acciones destructivas siguen preguntando.** YOLO deja que el agente implemente, commitee, pushee y abra PRs dentro de la tarea ya autorizada sin pedir permiso cada vez, útil para corridas largas y autónomas. Las operaciones destructivas siguen exigiendo confirmación nueva.

Usá `/nubia:yolo enable` en la TUI primaria e interactiva de Pi para dejar de recibir preguntas de permiso repetidas en el trabajo ordinario **dentro de la tarea que ya autorizaste**. YOLO está **APAGADO** por defecto. El estado activo y un widget propio junto al editor indican **🚀 YOLO ON 🔥 — destructive confirmations remain**.

| Comando | Efecto |
| --- | --- |
| `/nubia:yolo enable` | Activa para esta sesión en vivo y este clon de Git. |
| `/nubia:yolo disable` | Revoca al instante y limpia los indicadores. |
| `/nubia:yolo status` | Muestra el estado sin activar. |
| `/nubia:yolo` | Abre un menú con `enable`, `disable` y `status`; cancelar no cambia nada. Sin UI de menú se comporta como `status`. |

Los argumentos inválidos no cambian el estado. La activación falla cerrada si no hay un clon de Git identificable, TUI interactiva o identidad de sesión viva. No existe variable de entorno, configuración persistida ni herramienta invocable por el modelo para activar YOLO.

**Desde el menú:** `/nubia:customize` → **Editor** → **YOLO: OFF · session only** (Enter o Espacio alterna). Navegar, la vista previa y Escape nunca otorgan permiso. A diferencia de Vim, este control no escribe ninguna preferencia global, perfil visual ni guardrail; reload o reemplazo de sesión lo resetea.

## Qué autoriza la activación

Permiso humano permanente para implementación ordinaria ya acotada, checks, commits, pushes sin force y creación de PRs. Su instrucción de sistema (solo mientras está activo) matiza las cláusulas por defecto de confirmar commit/push/PR y le pide al agente tomar decisiones de implementación ordinarias y reversibles sin entrevistas innecesarias.

Solo un `git push` simple puede saltear la confirmación rutinaria del guard de shell (se aceptan remote/ref simples y `-u`/`--set-upstream`). Los comandos compuestos, wrappers, opciones que cambian el repositorio u otras opciones de push conservan el comportamiento normal. Antes se evalúa el comando completo, incluidas las guardas de pérdida de datos. Las confirmaciones o bloqueos explícitos de push en cualquiera de las dos capas de configuración siguen siendo restricciones. YOLO nunca cambia el `autonomousMode` persistente.

## Qué sigue requiriendo una decisión

- Las operaciones destructivas conservan confirmación nueva o denegación: SQL DROP/TRUNCATE, borrados amplios, remoción recursiva, Git destructivo y otras operaciones guardadas no se eximen. Las confirmaciones/bloqueos configurados y la protección de rutas sensibles siguen.
- Las restricciones humanas explícitas, la política del repositorio, la confianza del proyecto y el alcance autorizado siguen rigiendo. Ampliar el alcance, divulgar información sensible y decisiones de producto genuinamente abiertas requieren una decisión humana.
- Los destinos o credenciales ambiguos quedan sin resolver: YOLO no inventa un remoto, destino de deploy, cuenta ni credencial, ni autoriza descubrir o reutilizar credenciales ambientales.
- Las herramientas `ask_user` y las opciones opacas nunca se responden automáticamente. Los hijos conservan solo su alcance delegado: no activan ni heredan YOLO.

## Vida útil y límites

El permiso vive en memoria de la instancia de la extensión, atado a la sesión viva y a la identidad del directorio común de Git (los worktrees del mismo clon pueden conservarlo). Sesiones nuevas, reanudadas, forkeadas, reemplazadas, el cierre, **reload** y reiniciar el proceso lo resetean a OFF. Ninguna entrada de sesión restaura un grant.

Esto es orientación de permisos y defensa en profundidad del guard de shell, **no un sandbox**: la detección cubre solo formas de comando reconocidas; scripts, herramientas custom y prompt injection pueden evadir la guía. Si necesitás contención real usá aislamiento del SO/contenedor y credenciales de alcance mínimo.

## Frontera de pérdida de datos reconocida

Los comandos destructivos reconocidos de bases de datos y de filesystem amplio requieren **confirmación nueva del primario** y están **bloqueados en los hijos del paquete**, independientemente de YOLO y del modo autónomo.

| Forma reconocida | Sesión primaria | Hijo delegado |
| --- | --- | --- |
| SQL `DROP TABLE/DATABASE/SCHEMA/INDEX/VIEW`, `TRUNCATE [TABLE]` | Confirmación nueva | Bloqueo |
| SQL `DELETE FROM` sin `WHERE`, o con `WHERE 1=1` / `WHERE TRUE` final | Confirmación nueva | Bloqueo |
| `rm` recursivo, `find -delete`, `find -exec/-execdir` destructivo y `xargs` reconocidos | Confirmación nueva | Bloqueo |
| `rm` recursivo sobre `/`, `/*`, `.`, `..`, home o sus descendientes | Bloqueo duro | Bloqueo |
| Git force push, hard reset, clean forzado | Bloqueo duro | Bloqueo |
| Borrado forzado de rama, reset/clean/restore/rebase, checkout con `--` o force, stash drop/clear | Política primaria existente | Bloqueo |

El reconocimiento de SQL se limita a argumentos literales pasados a `psql`, `mysql`, `mariadb` o `sqlite3`, pipelines literales de `echo`/`printf` hacia esos clientes y heredocs simples. El reconocimiento sigue separadores simples, pipelines y grupos entre paréntesis; entiende rutas de ejecutables, asignaciones iniciales, wrappers comunes (`env`, `sudo`, `command`, `exec`, `nohup`, `timeout`, `xargs`) y payloads literales de `sh/bash/zsh/dash -c` (hasta cinco niveles). Cada operación reconocida de un comando compuesto participa. Builds, tests, SQL de solo lectura, borrados literales acotados por predicado, `git status/log` y pushes simples no cambian.

**Precedencia:** 1) los hard deny ganan en todo el comando; 2) los bloqueos explícitos configurados ganan antes que la confirmación por pérdida de datos (YOLO respeta además las restricciones explícitas de push); 3) la pérdida de datos reconocida siempre pide confirmación nueva, aunque el modo autónomo o una acción de entrega la permitan; 4) sin UI, cancelación, respuesta no verdadera o error de diálogo nunca autorizan. La aprobación no se cachea.

Los hijos reciben la entrada liviana `child-safety.ts` junto a `child-context.ts`; registra algo solo con `NUB_IA_AGENTS_CHILD=1`.

### Limitaciones de la detección

- Es reconocimiento léxico determinístico, **no** evaluación de shell ni de SQL: alias, funciones, comandos armados dinámicamente, expansiones en payloads entrecomillados, flags de wrapper inusuales, heredocs complejos y wrappers muy anidados pueden evadirlo.
- No se inspeccionan scripts, migraciones, archivos SQL redirigidos, programas de intérpretes (Python/Node), payloads codificados ni ejecución remota. Un `WHERE` no prueba impacto acotado.
- Solo las llamadas a la herramienta `bash` llegan a esta frontera; la ejecución directa de procesos, los comandos de shell del usuario, MCP y otras herramientas no están cubiertos. Faltar o sobreescribir la ruta de la extensión hija elimina la frontera liviana: una instalación válida debe incluir la entrada de seguridad.

Mantené vigentes la autorización de la tarea, las restricciones explícitas, la protección de rutas sensibles y los planes de ejecución más seguros. El guard destructivo no otorga autoridad de entrega u operación remota, no activa YOLO ni responde modales por sí solo.

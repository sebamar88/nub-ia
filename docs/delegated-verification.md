# Verificación delegada

Cómo decide el orquestador de Nub-IA quién verifica el trabajo de un writer acotado. La regla vive una sola vez en `assets/orchestrator-verification.md`; esta página es el resumen legible.

## El reporte del writer

El writer acotado ejecuta, en primer plano, los comandos exactos que el padre lista bajo `## Verification` y reporta cada uno como `<comando>: <resultado observado>`. Ese reporte es la verificación de registro del cambio del propio writer. `## Known environmental failures` lista nombres de tests o líneas de comando exactas que ya fallan en la base: se reportan como evidencia y no como bloqueo, mientras que cualquier otro comando requerido que falle obliga a `status: partial`.

## Verificación independiente

Se suma una corrida separada de `gentle-ai-verify` (o el fallback nativo `Agent`, con la misma tarea de solo lectura y los comandos exactos autorizados por el padre) cuando:

- el cambio toca un ítem de riesgo alto de Task Size (datos o efectos irreversibles, seguridad, cambio de un contrato consumido, concurrencia, entrega o entorno, o ningún test detectaría una regresión);
- el writer reporta `partial` o `blocked`;
- el chequeo es caro o externo (E2E, instalaciones) y el padre quiere un perfil más barato; o
- el writer es un modelo chico (mini o esfuerzo bajo) y el cambio es de riesgo medio.

El spot check del padre (volver a ejecutar un comando reportado antes de entregar) sigue siendo obligatorio en todos los casos.

## Review antes de entregar

Antes de entregar un cambio no trivial, el orquestador corre la herramienta `nub_review` sobre el diff y atiende sus hallazgos BLOCKER/CRITICAL. El gate de push pide confirmación cuando los cambios no fueron revisados o quedaron bloqueados. Un code review no reemplaza los checks funcionales aplicables: tests, builds y verificaciones como las de navegador para cambios de UI se siguen corriendo cuando corresponde.

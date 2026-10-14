# Métricas de runtime

Nub-IA agrega en proceso métricas de uso del runtime (tokens, duraciones, modelo y clase de agente) en `lib/runtime-metrics.ts` y `extensions/runtime-metrics.ts`, y las escribe **solo en un archivo local**:

```text
~/.pi/nub-ia/metrics/runtime-<YYYY-MM>.jsonl
```

Un archivo por mes, una fila JSON por línea. Los datos no salen de tu máquina: nada se envía a ningún servicio.

- **Apagado:** `NUB_IA_METRICS=off` desactiva la escritura por completo.
- Los hijos delegados reportan a través del padre (`lib/runtime-metrics-children.ts`); nunca escriben por su cuenta.
- Las filas son locales al evento, nunca totales acumulados de la sesión, y un slot de intento ocupado descarta el evento en lugar de encolarlo. El esquema de fila está en `lib/runtime-metrics-schema.json`.

## Métricas del review 4R

Cada corrida de `nub_review` / `/nubia:review` agrega, al mismo sink local y bajo el mismo interruptor
(`NUB_IA_METRICS=off`), filas de calibración en:

```text
~/.pi/nub-ia/metrics/review-<YYYY-MM>.jsonl
```

Una fila `verdict` por corrida (veredicto, tamaño del diff, duración total y, por lente, modelo normalizado, resultado
`ok|failed`, cantidad de hallazgos, entradas descartadas y duración) seguida de una fila `finding` por hallazgo (lente,
severidad, modelo, si apuntó a un archivo y si trajo sugerencia). **No se guardan rutas, claims, evidencia, refs ni
contenido del diff**; `diffHash` solo agrupa las filas de una corrida. Esquema: `lib/nub-review-metrics-schema.json`
(`nub-ia.review-metrics/v1`); generación en `lib/nub-review-metrics.ts`. Un fallo del sink nunca falla el review.

## Leer las métricas

`nub-ia usage [--month AAAA-MM] [--json]` (o `/nubia:usage --month [AAAA-MM]` en la shell) resume el mes: respuestas y
tokens por clase de agente y por modelo, gasto por día (de los ledgers `spend-<fecha>.json` que alimenta el presupuesto
del router), veredictos de review y conteos de auditoría. Todo local.

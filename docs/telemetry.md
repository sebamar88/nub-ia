# Métricas de runtime

Nub-IA agrega en proceso métricas de uso del runtime (tokens, duraciones, modelo y clase de agente) en `lib/runtime-metrics.ts` y `extensions/runtime-metrics.ts`, y las escribe **solo en un archivo local**:

```text
~/.pi/nub-ia/metrics/runtime-<YYYY-MM>.jsonl
```

Un archivo por mes, una fila JSON por línea. Los datos no salen de tu máquina: nada se envía a ningún servicio.

- **Apagado:** `NUB_IA_METRICS=off` desactiva la escritura por completo.
- Los hijos delegados reportan a través del padre (`lib/runtime-metrics-children.ts`); nunca escriben por su cuenta.
- Las filas son locales al evento, nunca totales acumulados de la sesión, y un slot de intento ocupado descarta el evento en lugar de encolarlo. El esquema de fila está en `lib/runtime-metrics-schema.json`.

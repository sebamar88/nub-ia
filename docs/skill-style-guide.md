# Guía de estilo de skills

Esta guía es el contrato de estilo normativo para las skills LLM-first que trae Nub-IA o que se crean dentro de sus proyectos.

## Propósito

Una skill es un contrato de instrucciones de runtime para un LLM. Debe volver más confiable el comportamiento futuro del agente codificando reglas de workflow reutilizables, compuertas de decisión y expectativas de salida. No es un tutorial, un artículo, un README ni una checklist genérica para humanos.

## Cuándo crear una skill

Creá o actualizá una skill cuando:

- un workflow o convención se reutiliza entre sesiones;
- las restricciones del proyecto difieren de las buenas prácticas genéricas;
- un árbol de decisión ayuda al agente a elegir con seguridad;
- plantillas, esquemas o referencias locales mejoran la repetibilidad;
- los agentes siguen omitiendo la misma instrucción sin un contrato explícito.

No crees una skill para tareas puntuales, documentación genérica, reglas que pertenecen a tests, linters o código ejecutable, ni contexto amplio sin reglas de ejecución concretas.

## Estructura requerida

```text
skills/{skill-name}/
├── SKILL.md
├── assets/       # opcional: plantillas, esquemas, ejemplos, fixtures
└── references/   # opcional: docs locales más largas o fundamentos
```

`SKILL.md` debe usar este orden de secciones (los nombres se mantienen en inglés porque los lee el runtime):

1. `Activation Contract`
2. `Hard Rules`
3. `Decision Gates`
4. `Execution Steps`
5. `Output Contract`
6. `References`

Omití los directorios opcionales cuando no hacen falta.

## Frontmatter

```yaml
---
name: {kebab-case-skill-name}
description: "Trigger: {frases que dirán usuarios o agentes}. {Qué hace esta skill}."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---
```

- `name` en kebab-case y coincidente con el directorio de la skill, salvo una razón deliberada de compatibilidad.
- `description` en una sola línea física, entre comillas, segura para YAML y rica en triggers; las palabras de activación esenciales van primero.
- No agregues una sección `Keywords`. Conservá `license` y `metadata` salvo que el proyecto tenga una convención local más fuerte.

## Reglas de escritura

- Escribí instrucciones imperativas de runtime, no prosa explicativa.
- Mantené `SKILL.md` conciso: objetivo de 180–450 tokens, máximo recomendado 700, máximo duro 1000.
- Preferí viñetas y tablas de decisión compactas a párrafos.
- Indicá cuándo activar la skill y cuándo no.
- Al mejorar una skill existente, preservá la intención del autor.
- No inventes políticas de dominio, triggers ni restricciones: preguntá o marcá la ambigüedad.
- Mové ejemplos largos, esquemas, plantillas generadas y fundamentos a `assets/` o `references/`, y referenciá solo archivos locales que viajen con el proyecto.

## Compuertas de decisión

Usá una tabla cuando las opciones importan:

```markdown
| Situation | Action |
| --- | --- |
| Missing frontmatter | Fix required fields |
| Existing skill covers it | Update the existing skill instead |
| Long examples needed | Move them to `assets/` |
```

Deben prevenir el exceso inseguro, las skills duplicadas y la ceremonia innecesaria.

## Contrato de salida

Toda skill debe decirle al agente qué devolver: archivos creados o modificados, comandos o verificaciones ejecutados, si hace falta refrescar el registro, ambigüedades sin resolver y riesgos residuales.

## Registro de skills

Tras crear, eliminar, mover o renombrar skills de un proyecto, refrescá el registro cuando esté disponible:

```text
/skill-registry:refresh
```

El registro es un índice: `SKILL.md` sigue siendo la fuente de verdad.

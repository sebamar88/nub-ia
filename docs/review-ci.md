# Review 4R en CI (`nub-ia review`)

`nub-ia review` corre el mismo review 4R de la shell sin TUI y devuelve un código de salida apto para pipelines:

```bash
nub-ia review --base origin/main            # resumen en texto; falla (1) con BLOCK o INCOMPLETE
nub-ia review --base origin/main --json     # reporte JSON (schema nub-ia.review-report/v1)
nub-ia review --staged --fail-on warn       # también falla con WARN
nub-ia review --working --fail-on never     # nunca falla por veredicto; solo informa
```

| Código | Significado |
| --- | --- |
| `0` | Veredicto por encima del umbral (`APPROVE`, o `WARN` con `--fail-on block`). |
| `1` | Veredicto en o por debajo de `--fail-on` (default `block`). `INCOMPLETE` (un lente falló) siempre cuenta como fallo: un review que no se pudo completar no aprueba nada. |
| `2` | No hubo nada que revisar, argumentos inválidos, o error al obtener el diff. |

El reporte markdown se guarda igual que en la shell (`.pi/nub-ia/reviews/`), y las métricas locales se escriben igual
(`NUB_IA_METRICS=off` las apaga).

## Requisitos

- El home que resuelve el launcher (aislado por defecto, `~/.nub-ia/agent`) necesita **al menos un provider con
  credenciales**: en CI, lo más simple es Amazon Bedrock con variables `AWS_*` del job, o un token de OpenAI/Copilot
  en un secret. Sin provider, el review termina `INCOMPLETE` → código 1.
- `git fetch` del ref base antes de correrlo (`--base origin/main` necesita que exista localmente).
- `--link` usa tu `~/.pi/agent`: si ahí conviven otros paquetes Pi (por ejemplo `gentle-pi`), su carga puede interferir
  con el modo headless; para CI usá siempre el home aislado.

## GitHub Actions

```yaml
name: nub-ia review
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - name: Install Nub-IA
        run: curl -fsSL https://raw.githubusercontent.com/sebamar88/nub-ia/main/install.sh | sh
      - name: Review
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
          NUB_IA_NO_AUTO_SETUP: "1"
        run: |
          export PATH="$HOME/.local/bin:$PATH"
          nub-ia review --base "origin/${{ github.base_ref }}" --json | tee review.json
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with: { name: nub-ia-review, path: review.json }
```

## Comentario en el PR

`--pr` (en CI) o `/nubia:review --pr` (en la shell, con confirmación) publica el reporte como comentario del pull request
de la rama usando `gh`. Es idempotente: el comentario lleva un marcador oculto y una corrida posterior **edita** el mismo
comentario en vez de agregar otro. Requiere `gh` autenticado (`GH_TOKEN` en CI, con permiso `pull-requests: write`); si
no hay PR, `gh` falta o la API falla, lo informa y no afecta el código de salida del review.

```yaml
      - name: Review and comment
        env:
          GH_TOKEN: ${{ github.token }}
          # …credenciales del provider…
        run: nub-ia review --base "origin/${{ github.base_ref }}" --pr --fail-on block
```

Cómo se comporta internamente: el launcher arranca `pi` en modo print sin sesión y pasa los argumentos por
`NUB_IA_REVIEW_HEADLESS`; la extensión del review los toma en `session_start`, corre los lentes, imprime y sale antes de
que ningún prompt llegue a un modelo.

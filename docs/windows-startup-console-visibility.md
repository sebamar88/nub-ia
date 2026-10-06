# Captura de consolas en el arranque de Windows

Usá este protocolo para validar, en un escritorio Windows real, los procesos hijo de Git del arranque. El CI de Linux puede verificar la configuración de spawn pero no observar ventanas de consola de Windows.

## Captura

1. Iniciá una traza de eventos de ventana de Windows antes de lanzar Pi. Capturá `EVENT_OBJECT_SHOW`, su timestamp, HWND, PID dueño y sesión dueña.
2. Lanzá a propósito una consola visible y de vida corta conocida como control positivo. Si falta su evento de show, la captura es **INCONCLUSIVA**.
3. Instalá o armá el paquete candidato de Nub-IA y ejecutá `nub-ia` desde un repositorio cuya ruta contenga espacios. Dejalo inactivo al menos 10 segundos para que corran las búsquedas de identidad del arranque (`git rev-parse --show-toplevel` y `git rev-parse --git-common-dir`), la búsqueda de rama, el escaneo inicial de la shell y el polling repetido.
4. Correlacioná cada evento de show con `GetWindowThreadProcessId`, y usá su timestamp, el PID/sesión del host y la ascendencia de creación de procesos y la línea de comando de Procmon para asociarlo con una invocación de Git lanzada por Pi. El HWND puede pertenecer a `conhost.exe`, OpenConsole o Windows Terminal en lugar de `git.exe`.

## Resultado esperado

Ningún evento de show `WS_VISIBLE` se asocia con la invocación de Git de las búsquedas de identidad del arranque, la búsqueda de rama del banner, el escaneo inicial de la shell o el polling repetido. Un evento de show visible prueba visibilidad de la ventana, no que no estuviera tapada. Iniciar un proceso no es evidencia de ventana visible. Si no se puede asociar evento e invocación, reportá **INCONCLUSIVO**, no aprobado.

## Alcance

Este protocolo no cubre editores externos configurados por el usuario: su lanzamiento con stdio heredado es intencional y puede abrir una ventana visible.

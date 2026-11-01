# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Plugin comunitario de terceros para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). No es un producto oficial de DeepSeek. MIT.

[English](README.md) | [中文](README-zh.md) | Español | [Português](README-pt.md) | [हिन्दी](README-hi.md)

Expone la **URL autenticada** de la GUI web de DeepSeek Harness en ejecución como herramienta del agente, para que la automatización del navegador abra la GUI en lugar de recibir `401 dsh web authentication required`.

## The problem

`dsh --profile web` genera un token de lanzamiento aleatorio por proceso y lo imprime una sola vez:

```text
dsh web: http://127.0.0.1:3080/?token=...
```

Abrir la dirección sin token devuelve 401. La edición Desktop inicia su propio proceso Host en un puerto aleatorio y nunca imprime esa línea, así que cualquier navegador externo o herramienta de automatización recibe 401 al abrir la dirección básica. No existe un interruptor `--no-browser-auth`.

## How it works

El plugin se ejecuta dentro del proceso Host y llama a la API pública oficial `connection.authenticatedUrl(baseUrl)` — la misma que usa `dsh web` para construir la URL que imprime — y devuelve el resultado como resultado de la herramienta. No lee el secreto de firma de cookies en `$DSH_HOME/.credentials.yaml` ni genera cookies propias, así que la URL es una sesión de primera parte real y ligada a este proceso.

La base se resuelve con `webApp.getAdvertisedUrl()`, luego `webServer.getOrigin()` y, por último, protocolo más puerto de bucle local. El token solo se añade si la base es `http` o `https` absoluta, sin usuario ni contraseña, y el host es de bucle local (`127.0.0.0/8`, `localhost` o `::1`), salvo que la config del plugin sea exactamente `allowPublic: true`. La URL devuelta debe tener el mismo origen y exactamente un `token`. Si la base no vale, se rechaza antes de llamar a `authenticatedUrl`, y el error no incluye la URL.

## Install

```bash
dsh plugin --profile web add github:NingYuanLee/dsh-gui-auth-url
```

El paquete declara `dsh.bundle.patch`, así que `dsh plugin add` añade el bundle al perfil automáticamente. Reinicia DeepSeek Harness.

Instalación desde un checkout local:

```bash
git clone https://github.com/NingYuanLee/dsh-gui-auth-url.git
dsh plugin --profile web add ./dsh-gui-auth-url
```

El paquete está publicado en npm como `dsh-gui-auth-url`. GitHub es el repositorio de origen.

Si vienes del nombre antiguo `dsh-gui-session` (0.1.x), reinstala: cambiaron el paquete, la fila de Cordis y el nombre de la herramienta.

## Usage

La herramienta `gui_auth_url` no recibe parámetros y devuelve:

```json
{
  "url": "http://127.0.0.1:3080/?token=...",
  "origin": "http://127.0.0.1:3080",
  "protocol": "http:",
  "host": "127.0.0.1",
  "port": "3080",
  "secure": false
}
```

El modelo ve el texto de `url`; el resto de campos queda para llamadas programáticas. Pasa la URL a `navigate_page`, `curl` o cualquier cliente HTTP para entrar en la GUI. Es útil para que el agente verifique de verdad la interfaz y las RPC con chrome-devtools-mcp mientras depura DeepSeek Harness.

`/dsh-web` es la mitad humana: escríbelo en el cuadro de entrada de la GUI y el complemento **lanza otro** Host de `dsh web`, con su propio `DSH_HOME` temporal y un puerto asignado por el sistema, y abre esa URL en el navegador predeterminado. No comparte nada con la sesión activa de la edición de escritorio, así que esa GUI es un lugar aislado y desechable. Volver a ejecutarlo reinicia la instancia en el sitio: conserva el DSH_HOME temporal y los complementos instalados, reutiliza el puerto y solo cambia el token de lanzamiento. La instancia es un trabajo en segundo plano de la sesión: aparece en la lista de tareas de la sesión y, al cancelarla allí, se termina el proceso y se borra el directorio temporal. Configura `openBrowser: false` en el parche del perfil cuando la máquina del Host no tenga navegador que abrir; entonces el comando solo muestra el enlace.

Configura `shareApiKey: true` para entregar la `DEEPSEEK_API_KEY` disponible (primero el entorno heredado, luego el almacén de credenciales) al Host aislado como variable de entorno, de modo que pueda hablar con el modelo sin volver a iniciar sesión; la clave nunca se escribe en el directorio temporal y cada turno consume la misma cuenta.

Se ejecutan como máximo 4 instancias a la vez (ajustable con `maxInstances` en el parche del perfil, 1–32); al superar el límite, un arranque nuevo falla pidiendo detener una antes — cada instancia es un proceso `dsh web` completo, así que el tope evita acumulación. Una instancia detenida a propósito aparece como 临cancelada» en la lista de tareas, no como 临fallida».

**Reinicio en el sitio**: con una instancia en marcha, `/dsh-web` la reinicia automáticamente (para forzarlo escribe `/dsh-web restart`, o el agente usa `dsh_web_restart`). El reinicio conserva el `DSH_HOME` temporal y **reutiliza el mismo puerto** cuando puede: el proceso y el token son nuevos, pero la cookie del navegador está ligada a `host:port` y su clave de firma vive en ese directorio temporal, así que la pestaña ya abierta sigue funcionando tras recargar; solo si el puerto está ocupado se recurre a uno aleatorio (el resultado lo indica). Los complementos instalados, la configuración y las sesiones internas se conservan; un stop normal borra todo el directorio temporal. Uso típico: instala un complemento en la instancia temporal, vuelve a ejecutar `/dsh-web` para que surta efecto y detenla al terminar: en el escritorio no queda nada instalado.

Para evitar restos acumulados, cada home temporal registra `instance.json` (PID del host, PID del Desktop, puerto). Al arrancar, el plugin escanea `%TEMP%/dsh-web-gui-*`, borra los homes cuyo host o proceso Desktop ya no existe y solo termina un proceso residual cuando su puerto sigue devolviendo la firma 401 de DSH; los directorios antiguos sin marcador se limpian pasadas 24 horas. Al detener, en Windows se termina el árbol de procesos para no dejar hijos.

Para el agente hay tres entradas, con papeles distintos: `gui_auth_url` devuelve la dirección del **proceso de escritorio actual** (la GUI que estás viendo; solo lectura, sin efectos); `dsh_web_start` arranca o reutiliza una **instancia temporal** y devuelve su `url` y `jobId` (sin abrir navegador); `dsh_web_restart` reinicia esa instancia en el sitio conservando el directorio temporal. Para detenerla usa la lista de tareas o `job_kill`; las tres comparten `shareApiKey`, propiedad y reglas de limpieza.

En una sesión vacía (aún sin mensajes) no se puede ejecutar `/dsh-web`: DSH filtra esas sesiones de la lista, así que al cambiar desaparecería y la instancia perdería su botón de parada. El comando devuelve un aviso pidiendo enviar un mensaje antes o usar una sesión existente; ese aviso aparece sobre el cuadro de entrada, porque una sesión vacía no dibuja la transcripción donde normalmente se muestran los resultados.

Además, al escribir `/dsh-web` completo, el menú `/` puede dejar el resaltado en la siguiente candidata y Enter elegiría esa fila en vez de ejecutar tu comando; selecciona con el ratón la fila 临临时鉴权 DSH Web».

## Security

- La URL contiene el token de lanzamiento de este proceso: es una credencial equivalente a una sesión iniciada y solo funciona mientras el Host siga vivo.
- No la escribas en logs, no la subas al repositorio y no la pegues en chats; vuelve a llamar a la herramienta para obtener una nueva.
- Una llamada correcta guarda el token en la transcripción de la sesión y en las peticiones posteriores al modelo. 临No lo escribas en logs» no impide que el host lo almacene.
- El plugin no lee `.credentials.yaml` ni genera cookies.
- Las URL que no son de bucle local (`--public-url`, una IP de LAN o `0.0.0.0`) se rechazan salvo que la config sea exactamente `allowPublic: true`.
- No tiene relación con [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) (falsificación de cookies dentro de un sandbox): este plugin nunca toca ese secreto.

## Compatibility

| Elemento | Valor |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=22.19.0` |
| Verificado en | dsh `0.2.1-rc.2`, Windows x64, perfiles desktop y web |
| Combinación web | requiere el servicio `connection`; un perfil sin GUI web devuelve un error claro |

Los metadatos de presentación (`locale/*.json` y el `./icon` exportado) hacen que la página de Plugins y Settings muestren título, descripción e icono en lugar del id del paquete. No hay paso de compilación: se publica JavaScript ESM.

## Troubleshooting

**La herramienta no aparece.** Comprueba que `dsh.profile.bundles` en el `package.json` del perfil incluya `dsh-gui-auth-url`; una instalación fallida puede dejar solo la dependencia. Reinicia DSH y verifica con `dsh --profile <name> --dump-config` que exista la fila `gui-auth-url`.

**Instalación rechazada por versión.** DSH comprueba `engines.dsh` (o los rangos peer de dsh) al instalar. Si tu host queda fuera del rango, concede la exención exacta, reinstala y revócala cuando exista una versión compatible:

```bash
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> allow-version dsh-gui-auth-url@0.2.1 --dsh-version <runtime> --accept-risk
dsh plugin --profile <profile> revoke-version dsh-gui-auth-url@0.2.1
```

**`EPERM: rename ...` en Windows.** Detén el proceso DSH que usa el perfil, borra el directorio `node_modules\dsh-gui-auth-url` obsoleto y reintenta.

**"This profile serves no Web GUI".** El perfil necesita `webApp` o `webServer` y `connection`; los perfiles headless no tienen GUI que abrir.

## Development

```bash
node --test test/*.test.js
node --check src/index.js && node --check src/auth-url.js && node --check src/api-key.js && node --check src/command.js && node --check src/isolated-tool.js && node --check src/isolated-web.js && node --check client.js
npm run check:pack
```

```text
src/auth-url.js      resolución de URL base y llamada al Host (funciones puras)
src/api-key.js       resolución de la DEEPSEEK_API_KEY para el Host aislado
src/command.js       comando /dsh-web: arranque/reinicio automático y apertura del navegador
src/isolated-web.js  gestor de instancias por sesión (spawn, restart, stop, barrido)
src/isolated-tool.js herramientas del agente dsh_web_start / dsh_web_restart
src/index.js         entrada de Cordis: gui_auth_url + superficie de instancias
client.js            mitad de navegador: etiqueta/icono del comando, alias oculto, aviso
locale/              metadatos de presentación (en, zh, es, pt, hi)
test/                pruebas node:test, incluidas las invariantes de empaquetado
scripts/             comprobación del tarball usada por prepublishOnly y CI
```

El plugin registra una herramienta de solo lectura, dos herramientas de instancia y un comando humano; los disposers que devuelve `ctx.tools.register` los posee Cordis, así que al descargar o recargar el plugin se eliminan limpiamente.

Empujar una etiqueta `v*` dispara `.github/workflows/publish.yml`; si el secreto del repositorio `NPM_TOKEN` no está configurado, el flujo se salta la publicación e informa en el log. La publicación manual (arriba) sigue siendo válida.

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — scripts locales que reciben 401 en la GUI web
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — petición de `--no-browser-auth`, no adoptada
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop no obtiene una sesión válida
- [Contrato oficial de connection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)

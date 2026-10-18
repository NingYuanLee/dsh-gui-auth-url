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

La base se resuelve con `webApp.getAdvertisedUrl()`, luego `webServer.getOrigin()` y, por último, protocolo más puerto de bucle local.

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

npm todavía no está publicado; GitHub es el único canal por ahora.

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

## Security

- La URL contiene el token de lanzamiento de este proceso: es una credencial equivalente a una sesión iniciada y solo funciona mientras el Host siga vivo.
- No la escribas en logs, no la subas al repositorio y no la pegues en chats; vuelve a llamar a la herramienta para obtener una nueva.
- El plugin no lee `.credentials.yaml` ni genera cookies; su límite de permisos es el mismo que el de `dsh web` en una terminal.
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
node --check src/index.js && node --check src/auth-url.js
npm run check:pack
```

```text
src/auth-url.js    resolución de URL base y llamada al Host (funciones puras)
src/index.js       entrada del plugin Cordis: registra gui_auth_url
locale/            metadatos de presentación (en, zh, es, pt, hi)
test/              pruebas node:test, incluidas las invariantes de empaquetado
scripts/           comprobación del tarball usada por prepublishOnly y CI
```

El plugin solo registra una herramienta; el disposer que devuelve `ctx.tools.register` lo posee Cordis, así que al descargar o recargar el plugin se elimina limpiamente.

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — scripts locales que reciben 401 en la GUI web
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — petición de `--no-browser-auth`, no adoptada
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop no obtiene una sesión válida
- [Contrato oficial de connection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
- [Registro comunitario de plugins](https://dsplugin.app/)

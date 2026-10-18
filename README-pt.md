# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Plugin comunitário de terceiros para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Não é um produto oficial da DeepSeek. MIT.

[English](README.md) | [中文](README-zh.md) | [Español](README-es.md) | Português | [हिन्दी](README-hi.md)

Expõe a **URL autenticada** da GUI web do DeepSeek Harness em execução como ferramenta do agente, para que a automação do navegador abra a GUI em vez de receber `401 dsh web authentication required`.

## The problem

`dsh --profile web` gera um token de inicialização aleatório por processo e o imprime uma única vez:

```text
dsh web: http://127.0.0.1:3080/?token=...
```

Abrir o endereço sem token retorna 401. A edição Desktop inicia seu próprio processo Host em uma porta aleatória e nunca imprime essa linha, então qualquer navegador externo ou ferramenta de automação recebe 401 ao abrir o endereço básico. Não existe uma opção `--no-browser-auth`.

## How it works

O plugin roda dentro do processo Host e chama a API pública oficial `connection.authenticatedUrl(baseUrl)` — a mesma que `dsh web` usa para montar a URL que imprime — devolvendo o resultado como resultado da ferramenta. Ele não lê o segredo de assinatura de cookies em `$DSH_HOME/.credentials.yaml` nem cria cookies próprios, então a URL é uma sessão de primeira parte real, vinculada a este processo.

A base é resolvida com `webApp.getAdvertisedUrl()`, depois `webServer.getOrigin()` e, por fim, protocolo mais porta de loopback.

## Install

```bash
dsh plugin --profile web add github:NingYuanLee/dsh-gui-auth-url
```

O pacote declara `dsh.bundle.patch`, então `dsh plugin add` adiciona o bundle ao perfil automaticamente. Reinicie o DeepSeek Harness.

Instalação a partir de um checkout local:

```bash
git clone https://github.com/NingYuanLee/dsh-gui-auth-url.git
dsh plugin --profile web add ./dsh-gui-auth-url
```

O npm ainda não foi publicado; o GitHub é o único canal por enquanto.

Se você vem do nome antigo `dsh-gui-session` (0.1.x), reinstale: pacote, linha do Cordis e nome da ferramenta mudaram.

## Usage

A ferramenta `gui_auth_url` não recebe parâmetros e retorna:

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

O modelo vê o texto de `url`; os demais campos ficam para chamadas programáticas. Passe a URL para `navigate_page`, `curl` ou qualquer cliente HTTP para entrar na GUI. É útil para o agente verificar de verdade a interface e as RPC com chrome-devtools-mcp enquanto depura o DeepSeek Harness.

## Security

- A URL contém o token de inicialização deste processo: é uma credencial equivalente a uma sessão autenticada e só funciona enquanto o Host estiver vivo.
- Não grave em logs, não faça commit e não cole em conversas; chame a ferramenta de novo para obter outra.
- O plugin não lê `.credentials.yaml` nem cria cookies; seu limite de permissão é o mesmo de `dsh web` em um terminal.
- Não tem relação com [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) (forjar cookies dentro de um sandbox): este plugin nunca toca nesse segredo.

## Compatibility

| Item | Valor |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=22.19.0` |
| Verificado em | dsh `0.2.1-rc.2`, Windows x64, perfis desktop e web |
| Combinação web | exige o serviço `connection`; um perfil sem GUI web devolve um erro claro |

Os metadados de apresentação (`locale/*.json` e o `./icon` exportado) fazem a página de Plugins e Settings mostrarem título, descrição e ícone em vez do id do pacote. Não há etapa de build: publica JavaScript ESM.

## Troubleshooting

**A ferramenta não aparece.** Verifique se `dsh.profile.bundles` no `package.json` do perfil inclui `dsh-gui-auth-url`; uma instalação falha pode deixar só a dependência. Reinicie o DSH e confirme com `dsh --profile <name> --dump-config` que a linha `gui-auth-url` existe.

**Instalação rejeitada por versão.** O DSH verifica `engines.dsh` (ou as faixas peer de dsh) na instalação. Se o host estiver fora da faixa, conceda a isenção exata, reinstale e revogue quando houver versão compatível:

```bash
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> allow-version dsh-gui-auth-url@0.2.1 --dsh-version <runtime> --accept-risk
dsh plugin --profile <profile> revoke-version dsh-gui-auth-url@0.2.1
```

**`EPERM: rename ...` no Windows.** Pare o processo DSH que usa o perfil, apague o diretório `node_modules\dsh-gui-auth-url` obsoleto e tente de novo.

**"This profile serves no Web GUI".** O perfil precisa de `webApp` ou `webServer` e `connection`; perfis headless não têm GUI para abrir.

## Development

```bash
node --test test/*.test.js
node --check src/index.js && node --check src/auth-url.js
npm run check:pack
```

```text
src/auth-url.js    resolução da URL base e chamada ao Host (funções puras)
src/index.js       entrada do plugin Cordis: registra gui_auth_url
locale/            metadados de apresentação (en, zh, es, pt, hi)
test/              testes node:test, incluindo invariantes de empacotamento
scripts/           verificação do tarball usada por prepublishOnly e CI
```

O plugin registra apenas uma ferramenta; o disposer retornado por `ctx.tools.register` pertence ao Cordis, então descarregar ou recarregar o plugin a remove de forma limpa.

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — scripts locais recebendo 401 na GUI web
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — pedido de `--no-browser-auth`, não adotado
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop não obtém uma sessão válida
- [Contrato oficial de connection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
- [Registro comunitário de plugins](https://dsplugin.app/)

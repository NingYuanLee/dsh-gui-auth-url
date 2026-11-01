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

A base é resolvida com `webApp.getAdvertisedUrl()`, depois `webServer.getOrigin()` e, por fim, protocolo mais porta de loopback. O token só é anexado se a base for `http` ou `https` absoluta, sem usuário nem senha, e o host for loopback (`127.0.0.0/8`, `localhost` ou `::1`), a menos que a config do plugin seja exatamente `allowPublic: true`. A URL devolvida precisa ter a mesma origem e exatamente um `token`. Uma base inválida é recusada antes de `authenticatedUrl`, e o erro não inclui a URL.

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

O pacote está publicado no npm como `dsh-gui-auth-url`. O GitHub é o repositório de origem.

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

`/dsh-web` é a metade humana: digite-o na caixa de entrada da GUI e o complemento **inicia outro** Host `dsh web`, com o próprio `DSH_HOME` temporário e uma porta escolhida pelo sistema, e abre essa URL no navegador padrão. Nada é compartilhado com a sessão ativa da edição desktop, então essa GUI é um lugar isolado e descartável. Executar de novo reinicia a instância no lugar: mantém o DSH_HOME temporário e os complementos instalados, reutiliza a porta e só troca o token de inicialização. A instância é um trabalho em segundo plano da sessão: aparece na lista de tarefas da sessão e, ao cancelá-la ali, o processo é encerrado e o diretório temporário é apagado. Defina `openBrowser: false` no patch do perfil quando a máquina do Host não tiver navegador para abrir; nesse caso o comando apenas informa o link.

Defina `shareApiKey: true` para entregar a `DEEPSEEK_API_KEY` disponível (primeiro o ambiente herdado, depois o armazenamento de credenciais) ao Host isolado como variável de ambiente, para que ele fale com o modelo sem novo login; a chave nunca é gravada no diretório temporário e cada turno consome a mesma conta.

No máximo 4 instâncias rodam ao mesmo tempo (ajustável com `maxInstances` no patch do perfil, 1–32); acima do limite, uma nova inicialização falha pedindo para parar uma antes — cada instância é um processo `dsh web` completo, então o teto evita acúmulo. Uma instância parada de propósito aparece como 临cancelada» na lista de tarefas, não como 临falhou».

**Reinício no lugar**: com uma instância ativa, `/dsh-web` a reinicia automaticamente (para forçar, escreva `/dsh-web restart`, ou o agente usa `dsh_web_restart`). O reinício mantém o `DSH_HOME` temporário e **reutiliza a mesma porta** quando possível: processo e token são novos, mas o cookie do navegador é vinculado a `host:port` e a chave de assinatura fica nesse diretório temporário, então a aba já aberta continua funcionando após recarregar; só quando a porta está ocupada ele recorre a uma aleatória (o resultado informa). Complementos instalados, configuração e sessões internas sobrevivem; um stop normal apaga o diretório temporário inteiro. Uso típico: instale um complemento na instância temporária, rode `/dsh-web` de novo para aplicá-lo e pare no final: nada fica instalado no desktop.

Para evitar sobras acumuladas, cada home temporário grava `instance.json` (PID do host, PID do Desktop, porta). No arranque, o plugin varre `%TEMP%/dsh-web-gui-*`, remove homes cujo host ou processo Desktop já morreu e só encerra um processo residual quando a porta ainda retorna a assinatura 401 do DSH; diretórios antigos sem marcador são limpos após 24 horas. Ao parar, no Windows a árvore de processos é encerrada para não deixar filhos.

**Argumentos de inicialização.** Todos são opcionais e repassados ao `dsh web` iniciado. Cada um tem um preço:

- `install` (string[]): specs de pacotes instalados no `DSH_HOME` temporário com `dsh plugin --profile web add` antes de o host iniciar. É assim que um plugin local ou publicado é testado numa instância descartável. **Custo:** o pnpm executa os scripts de ciclo de vida (`postinstall` etc.) desses pacotes com o seu usuário, então só nomeie pacotes que você aceitaria executar; se a instalação falhar, o diretório temporário é apagado e o erro traz a cauda da saída da instalação, sem deixar instância pela metade. Fica liberado por padrão; `allowInstall: false` no patch do perfil recusa toda requisição com `install`.
- `host` (string): endereço de escuta. Precisa ser um literal IPv4 ou IPv6 concreto — `0.0.0.0`, `::` e `*` são recusados, porque um curinga publica a instância em todas as interfaces. Só é aceito com `allowPublic: true`.
- `public_url` (string): URL raiz anunciada, absoluta `http`/`https`, sem usuário nem senha. Mesma porta `allowPublic`.
- `tls_cert` e `tls_key` (string): caminhos PEM do certificado e da chave; precisam vir em par. Mesma porta. TLS cifra o transporte; não torna o token impresso seguro para repassar.
- `trusted_host` (string[]): autoridades extras aceitas pela cerca de confiança de `/api`. Mesma porta.
- `port` (integer, 0–65535): porta de escuta; `0` deixa o sistema escolher. `dsh_web_restart` não aceita `port` de propósito: um reinício reaproveita a porta para que a aba já aberta continue funcionando.

Ligar `allowPublic` é o único ajuste que amplia o raio de dano: a instância passa a responder fora do loopback e o token é a única coisa entre essa rede e uma sessão autenticada. Deixe sem definir num perfil desktop em loopback.

**Ciclo completo: testar um plugin local numa instância descartável.** O que faz «instalar → reiniciar para aplicar → verificar → limpar» ser um ciclo limpo é o `dsh_web_restart` também aceitar `install`:

```text
1. dsh_web_start()
   -> { "url": "http://127.0.0.1:49312/?token=...", "jobId": "job-..." }

2. dsh_web_restart({ "install": ["D:/tools/dsh-plugins/dsh-gui-auth-url"] })
   instala com `dsh plugin --profile web add` no DSH_HOME temporário
   e depois troca o host: mesma porta se estiver livre, token novo.

3. Verifique: abra a url devolvida com navigate_page/curl, ou chame
   dsh_web_status() -> { "running": true, "install": [...], "exposed": false, ... }
   A ferramenta e o comando do plugin existem só nessa instância.

4. dsh_web_stop() -> { "stopped": true }
   encerra a árvore de processos e apaga o diretório temporário;
   o perfil desktop não foi tocado em momento algum.
```

Para uma instância nova, `dsh_web_start({ "install": [...] })` junta os passos 1 e 2 numa chamada. Nos dois casos tudo cai em `%TEMP%/dsh-web-gui-*`, e o reinício mantém esse diretório, então o que foi instalado continua lá.

Para o agente há cinco entradas, e elas não são intercambiáveis: `gui_auth_url` devolve o endereço do **processo desktop atual** (a GUI que você está vendo; somente leitura, sem efeitos); `dsh_web_start` inicia ou reutiliza a **instância temporária** desta sessão e devolve `url` e `jobId` (sem abrir navegador); `dsh_web_restart` troca esse host no lugar mantendo o diretório temporário; `dsh_web_stop` para a instância, apaga o diretório temporário e devolve `{ stopped }`; `dsh_web_status` informa sem mudar nada — `running` e, havendo instância, também `url`, `jobId`, `startedAt`, `home`, `port`, `sharedKey`, `install` e `exposed`, além de `runningCount` e `maxInstances`. Parar pela lista de tarefas, com `job_kill` ou com `dsh_web_stop` termina no mesmo estado.

Numa sessão vazia (sem mensagens) não se pode executar `/dsh-web`: o DSH filtra essas sessões da lista, então ao trocar ela desapareceria e a instância perderia o controle de parada. O comando devolve um aviso pedindo para enviar uma mensagem antes ou usar uma sessão existente; o aviso aparece acima da caixa de entrada, porque uma sessão vazia não desenha a transcrição onde os resultados normalmente aparecem.

Além disso, ao digitar `/dsh-web` completo, o menu `/` pode manter o destaque na candidata seguinte e Enter escolheria essa linha em vez de executar o comando; selecione com o mouse a linha 临临时鉴权 DSH Web».

## Security

- A URL contém o token de inicialização deste processo: é uma credencial equivalente a uma sessão autenticada e só funciona enquanto o Host estiver vivo.
- Não grave em logs, não faça commit e não cole em conversas; chame a ferramenta de novo para obter outra.
- Uma chamada bem-sucedida ainda grava o token na transcrição da sessão e nos pedidos seguintes ao modelo. 临Não grave em logs» não impede o host de armazenar o resultado.
- O plugin não lê `.credentials.yaml` nem cria cookies.
- URLs fora do loopback (`--public-url`, um endereço de LAN ou `0.0.0.0`) são recusadas, a menos que a config seja exatamente `allowPublic: true`.
- Uma instância isolada é um processo filho `dsh web` de verdade. Com `shareApiKey: true` (padrão) ela recebe a `DEEPSEEK_API_KEY` deste processo pelo ambiente: não é gravada no diretório temporário nem impressa, mas qualquer processo do mesmo usuário consegue lê-la, e cada turno dentro dela consome a mesma conta. `shareApiKey: false` desliga isso.
- `install` executa os scripts de ciclo de vida do pnpm dos pacotes indicados com o seu usuário. Os specs passam por validação de caracteres (sem espaços, aspas ou `&|<>^`), o que bloqueia injeção de metacaracteres de shell, mas não diz nada sobre um pacote malicioso bem formado. `allowInstall: false` recusa instalações.
- Os argumentos de exposição (`host`, `public_url`, `tls_cert`/`tls_key`, `trusted_host`) só são aceitos com `allowPublic: true`, e `host` recusa curingas mesmo assim. Ao ligar, a rede alcançável é o público do token; TLS não reduz esse público.
- Ao parar, a árvore de processos é encerrada (`taskkill /T` no Windows) e o diretório temporário é apagado. A varredura de inicialização só mata processo remanescente quando a porta registrada ainda devolve a assinatura 401 do DSH, então PID reutilizado nunca é morto por engano.
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

**`dsh_web_start` recusa `install`.** Ou o perfil tem `allowInstall: false`, ou um spec contém caractere fora de `[A-Za-z0-9@._~:/\\+=%-]` (espaço, aspas, `&|<>^`). Corrija o spec ou reative as instalações no patch do perfil.

**A instalação falha e nenhuma instância aparece.** É o esperado: o diretório temporário é apagado e o erro traz a cauda da saída da instalação. Leia essa cauda: quase sempre é descompasso de versão (`engines.dsh`, veja a isenção acima) ou falha de registry/rede.

**`dsh_web_start` recusa `host`, `public_url`, `tls_cert`, `tls_key` ou `trusted_host`.** Os argumentos de exposição exigem `allowPublic: true` exato; e um curinga (`0.0.0.0`, `::`, `*`) é recusado mesmo assim: passe um endereço concreto e deixe o proxy reverso ou o túnel fora do plugin.

**Um reinício invalidou a URL.** Só a porta é reaproveitada, e só se estiver livre; o token muda a cada inicialização e reinício, então links antigos dão 401. `dsh_web_status` traz a `url` atual.

**`dsh_web_stop` diz que não parou nada.** Esta sessão já não tinha instância: foi parada antes, cancelada na lista de tarefas ou encerrada por `job_kill`. Confirme com `dsh_web_status` antes de supor falha.

## Development

```bash
node --test test/*.test.js
node --check src/index.js && node --check src/auth-url.js && node --check src/api-key.js && node --check src/command.js && node --check src/isolated-tool.js && node --check src/isolated-web.js && node --check client.js
npm run check:pack
```

```text
src/auth-url.js      resolução da URL base e chamada ao Host (funções puras)
src/api-key.js       resolução da DEEPSEEK_API_KEY para o Host isolado
src/command.js       comando /dsh-web: arranque/reinício automático e abertura do navegador
src/isolated-web.js  gestor de instâncias por sessão (spawn, restart, stop, varredura)
src/isolated-tool.js ferramentas do agente dsh_web_start / dsh_web_restart / dsh_web_stop / dsh_web_status
src/index.js         entrada do Cordis: gui_auth_url + superfície de instâncias
client.js            metade do navegador: rótulo/ícone do comando, alias oculto, aviso
locale/              metadados de apresentação (en, zh, es, pt, hi)
test/                testes node:test, incluindo invariantes de empacotamento
scripts/             verificação do tarball usada por prepublishOnly e CI
```

O plugin registra uma ferramenta somente leitura, quatro ferramentas de instância e um comando humano; os disposers retornados por `ctx.tools.register` pertencem ao Cordis, então descarregar ou recarregar o plugin os remove de forma limpa.

Empurrar uma tag `v*` dispara `.github/workflows/publish.yml`; se o secret do repositório `NPM_TOKEN` não estiver configurado, o fluxo pula a publicação e registra isso no log. A publicação manual (acima) continua válida.

## Releasing

Lançar uma versão é um comando: `npm run release -- patch|minor|major` (adicione `--dry-run` para apenas pré-visualizar, sem alterar nada). Ele roda a validação completa (testes, sintaxe, empacotamento) primeiro e aborta sem tocar em nada se algo falhar; depois sobe a versão, faz o commit, cria a tag e envia. A tag dispara `.github/workflows/publish.yml`, que publica no npm quando o secret do repositório `NPM_TOKEN` está configurado em Settings → Secrets and variables → Actions; caso contrário, pula a publicação e registra isso no log.

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — scripts locais recebendo 401 na GUI web
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — pedido de `--no-browser-auth`, não adotado
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop não obtém uma sessão válida
- [Contrato oficial de connection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)

---
sourceHash: 320fef71a80d
title: Memlore — Política de Privacidade
description: Como o Memlore trata o seu diário: ele fica no seu dispositivo, sem servidor do Memlore, sem telemetria, e com nuvem e IA opcionais sob o seu controle.
updated: 11 de outubro de 2026
---

# Política de Privacidade

O Memlore é um diário privado. Esta página explica o que o app e este site fazem com informações — e o que eles nunca fazem.

## Quem somos

O Memlore é feito por [Anh-Thi Dinh](https://dinhanhthi.com). É um app de diário de código aberto. Dúvidas: [contact@memlore.app](mailto:contact@memlore.app).

## O que não coletamos

Não existe servidor do Memlore nem conta do Memlore. O app não vigia você.

- Sem telemetria
- Sem analytics
- Sem publicidade
- Sem pixels de rastreamento

## Seu diário no seu dispositivo

Seu diário fica no seu dispositivo, em um banco de dados local criptografado. Nós não conseguimos lê-lo.

## Sincronização opcional na nuvem

A sincronização fica desligada até você ativá-la. Você escolhe um único lugar — o seu Google Drive ou o seu iCloud Drive. Não há nenhum servidor do Memlore no meio.

Entradas, mídia e configurações são criptografadas no seu dispositivo antes de serem enviadas. Uma pequena lista de sincronização e um registro de dispositivos — IDs, datas e horas, marcações de exclusão e o nome do seu dispositivo, nunca o texto do diário — são armazenados em JSON para que os seus outros dispositivos saibam o que baixar.

## Sincronização opcional com o Google Drive

Se você escolher o Google Drive, você conecta a sua própria conta Google. O Memlore pede apenas o escopo [drive.appdata](https://www.googleapis.com/auth/drive.appdata). Os arquivos sincronizados ficam na pasta oculta Application Data do Google Drive — que não aparece em drive.google.com — e o Memlore não consegue ler os seus outros arquivos do Drive.

O token de atualização, o e-mail da sua conta Google e a sua cota de armazenamento do Drive ficam apenas no banco de dados criptografado deste dispositivo, para que o app possa mostrar qual conta está conectada. Eles permanecem até você desconectar e, então, são apagados do banco de dados local. O token de acesso fica na memória, nunca é gravado em disco e desaparece quando o app é fechado.

Desconectar no app não apaga os arquivos que já estão na sua pasta oculta Application Data. Para remover essa cópia do lado do Google, abra Google Drive → Configurações → Gerenciar apps → Memlore → Desconectar do Drive.

Os dados de usuário do Google são usados apenas para executar a sincronização com o Drive que você ativou. Nenhuma pessoa no Memlore lê os seus dados de usuário do Google. Não existe servidor do Memlore para onde eles possam ir. O Memlore não:

- Vende esses dados nem os transfere para corretores de dados ou revendedores de informações
- Usa esses dados para publicidade, incluindo anúncios direcionados, personalizados ou baseados em interesses
- Usa esses dados para desenvolver, melhorar ou treinar modelos de IA ou ML generalizados ou não personalizados
- Usa esses dados para avaliar capacidade de crédito, conceder empréstimos ou tomar qualquer outra decisão não relacionada aos recursos do app
- Transfere esses dados a terceiros, exceto quando necessário para operar a sincronização com o Drive dentro da sua própria conta Google, ou quando exigido por lei

O uso e a transferência, pelo Memlore, para qualquer outro app, de informações recebidas das APIs do Google seguem a [Política de Dados do Usuário dos Serviços de API do Google](https://developers.google.com/terms/api-services-user-data-policy), incluindo os requisitos de Uso Limitado.

## iCloud Drive opcional

Se você escolher o iCloud Drive (em um Mac), o Memlore grava em uma pasta Memlore no seu iCloud Drive — o mesmo iCloud Drive que você já vê no Finder.

O Memlore não faz login na Apple por você e não armazena nenhuma senha da Apple nem token do iCloud. Ele usa a sessão do iCloud Drive já aberta neste Mac.

Os mesmos conteúdos criptografados e a mesma lista de sincronização em JSON descritos acima vão para essa pasta. A Apple não recebe o seu diário em texto legível. Os termos do iCloud da Apple se aplicam.

Você pode desconectar no app. Desconectar não apaga a pasta Memlore no iCloud Drive. Remova essa pasta você mesmo se quiser que a cópia na nuvem desapareça.

## IA opcional

A IA fica desligada até você optar por usá-la e aceitar um aviso de privacidade. Você escolhe o provedor — local ou no dispositivo, ou um provedor hospedado.

Se você escolher um provedor hospedado, o texto que você envia vai para esse provedor. O Memlore não opera esses serviços e não vê esse tráfego.

## Mapas, lugares e fala opcionais

Mapas, geocodificação e conversão de fala em texto só funcionam se você os ativar. Eles se comunicam com o provedor que você escolher — por exemplo Nominatim/OpenStreetMap, Mapbox, MapTiler, Apple MapKit ou o seu provedor de conversão de fala em texto.

## Atualizações do app

O app pode solicitar metadados de releases do GitHub para avisar quando houver uma atualização disponível. Essa verificação não é telemetria.

## Memlore Web (web.memlore.app)

O Memlore Web é um complemento opcional para o navegador que permite ler o seu diário Memlore existente em um navegador web e fazer edições que o seu app de desktop importa.

- **O que fica armazenado localmente no navegador:** o Memlore Web armazena apenas um cache criptografado no IndexedDB do seu navegador. As chaves mestras de criptografia ficam na memória do WebAssembly e são apagadas assim que você tranca o cofre ou fecha a aba. Para que recarregar a página não peça sua senha de novo, a aba aberta também guarda uma cópia selada da chave mestra, junto com a chave de uso único que a abre, no armazenamento de sessão dessa aba. O app só a usa para recarregar essa aba, até você trancar ou o tempo do bloqueio automático passar; trancar a apaga. O navegador pode manter em disco o armazenamento de sessão de uma aba depois que ela é fechada (para restaurar abas), e o limite de tempo é aplicado pelo app, não pela criptografia, então quem copiar o perfil do navegador antes de você trancar poderia abrir o diário. Tranque o cofre antes de deixar um computador compartilhado. As entradas do seu diário são armazenadas em disco apenas como textos cifrados com AES-256-GCM; texto não criptografado nunca é armazenado no navegador.
- **O Cloudflare Worker:** um Cloudflare Worker efêmero em `web.memlore.app/api/*` cuida da troca de tokens OAuth 2.0 PKCE com o Google para que os segredos do cliente fiquem protegidos. O Worker nunca vê, analisa ou registra a sua frase mestra de recuperação, as suas chaves de criptografia ou o conteúdo do seu diário, e não mantém nenhum banco de dados persistente nem registros de acesso de tokens.
- **Infraestrutura de hospedagem:** o Memlore Web é hospedado no Cloudflare Pages. Como qualquer servidor web, a Cloudflare processa cabeçalhos HTTP padrão e endereços IP estritamente para mitigação de DDoS e entrega de conteúdo.
- **Escopo do Google Drive:** o Memlore Web se conecta exclusivamente ao escopo limitado `drive.appdata` do Google Drive (dados ocultos de aplicativo). Ele não pode ver, ler nem modificar nenhum dos seus documentos, fotos ou planilhas pessoais do Google Drive.
- **Blocos de mapa (opcional, desativado por padrão):** A página de mapa na web primeiro lista seus lugares sem contatar nenhum provedor de mapas. Só depois que você ativa os blocos de mapa com sua própria chave de API do MapTiler o seu navegador carrega blocos do MapTiler, que então recebe a área do mapa que você vê e o seu endereço IP. Sua chave de API fica armazenada criptografada neste navegador. Você pode parar de usar os blocos de mapa a qualquer momento.
- **Sem analytics:** o Memlore Web não contém rastreadores de analytics, scripts de publicidade, cookies de rastreamento nem telemetria comportamental.
- **Como apagar tudo:** você pode remover todos os rastros da web a qualquer momento:
  1. Nas configurações do seu navegador, limpe os dados do site web.memlore.app. Isso apaga tudo o que o Memlore Web armazenou nesse navegador (o cache criptografado, as edições não enviadas e a chave protegida pela senha). O botão **Clear cache** nas configurações do Memlore Web remove apenas as fotos e os vídeos em cache.
  2. No app Memlore para desktop, abra Settings → Security → Security actions → Connected devices e remova o dispositivo web.
  3. Revogue o acesso ao Google Drive em [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Este site

Este site de apresentação não define cookies de analytics e não coleta dados de diário. A demo interativa usa apenas dados de exemplo.

O botão Baixar é a única exceção, e vale a pena ser preciso sobre ele. Ele passa por dl.memlore.app, que conta o download e depois envia você para o arquivo no GitHub. O que é registrado é o horário, a versão do app e o país que a Cloudflare deduz a partir da conexão. Nenhum endereço IP é armazenado e nenhum cookie é definido. Isso acontece quando você baixa o app, nunca enquanto você o usa — o próprio app continua não enviando nada, nunca.

## Alterações

Esta política pode mudar. A data no topo da página mostra quando ela foi atualizada pela última vez.

## Como falar conosco

Dúvidas sobre privacidade: [contact@memlore.app](mailto:contact@memlore.app).

Esta página é uma tradução. Em caso de divergência, prevalece a [versão em inglês](/privacy).

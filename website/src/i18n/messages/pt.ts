/** Brazilian Portuguese website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const pt: Messages = {
  meta: {
    homeTitle: 'Memlore — Uma vida pequena. Uma história que fica.',
    homeDescription:
      'Um diário privado para as suas memórias. Conheça o Memlore, um app de código aberto para escrever, refletir e reencontrar o que importa.',
  },
  socialImageAlt:
    'Memlore, um diário privado: "Uma vida pequena. Uma história que fica." ao lado do app nos temas Signature, Clean e Clay, com um mascote golden retriever em low-poly.',
  chrome: {
    skipToContent: 'Pular para o conteúdo',
    homeAria: 'Página inicial do Memlore',
    mainNavAria: 'Navegação principal',
    navDemo: 'Demo',
    navFeatures: 'Recursos',
    navCompare: 'Comparar',
    navChangelog: 'Novidades',
    navDocs: 'Documentação',
    downloadForMac: 'Baixar para Mac',
    download: 'Baixar',
    downloadAria: 'Baixar a versão beta no GitHub',
    closeMenu: 'Fechar menu',
    openMenu: 'Abrir menu',
    copyright: '© {year} Memlore. Todos os direitos reservados.',
    footerNavAria: 'Sobre, novidades, documentação, privacidade, termos, llms.txt e GitHub',
    footerAbout: 'Sobre',
    footerChangelog: 'Novidades',
    footerDocs: 'Documentação',
    footerPrivacy: 'Privacidade',
    footerTerms: 'Termos',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: 'Jurídico',
    eyebrowAbout: 'Sobre',
    lastUpdated: 'Atualizado em {date}',
  },
  menu: {
    label: 'Idioma',
  },
  notice: {
    onlyEnglish: 'Esta página está disponível apenas em inglês.',
    backHome: 'Ir para a página inicial em português',
  },
  landing: {
    actions: {
      download: 'Baixar',
      downloadAria: 'Baixar a versão beta no GitHub',
      web: 'Web (beta)',
      demo: 'Demo',
      watch: 'Assistir',
      watchAria: 'Assistir à apresentação',
    },
    intro: {
      title: 'Apresentação',
      close: 'Fechar',
      frameTitle: 'Memlore — Uma vida pequena. Uma história que fica.',
    },
    openSource: {
      symbol: 'Feito às claras.',
      title: 'Código aberto',
      text: 'Aberto para que você veja como um diário é protegido e como os seus dados são guardados. O Memlore continua gratuito. O beta existe só para extras que mantêm o projeto vivo.',
      github: 'Ver no GitHub',
    },
    compare: {
      title: 'Como o Memlore se compara.',
      text: 'O Memlore ao lado de três diários que as pessoas já usam.',
      tableLabel: 'Tabela comparativa de diários, uma coluna por diário',
      compared: 'Comparação',
      sourcesLead: 'Veja os detalhes:',
      sourcesNote: 'Recursos e planos podem mudar.',
      levels: ['Alguns', 'Cerca de metade', 'A maioria', 'O conjunto completo'],
      marks: {
        yes: 'Sim',
        no: 'Não',
        soon: 'Em breve',
        partial: 'Varia ou não documentado',
      },
      rows: {
        'open-source': {
          label: 'Código aberto',
          description: 'Qualquer pessoa pode ler o código que guarda o diário.',
        },
        password: {
          label: 'Senha exigida antes de o diário abrir',
          description:
            'Não é uma opção que dá para desligar. Sem ela, os arquivos continuam lacrados.',
        },
        'your-key-only': {
          label: 'Protegido apenas pela sua senha',
          description:
            'Os quatro usam criptografia. Só o Memlore não pede conta, não mantém servidor próprio e não guarda nenhum caminho de recuperação para dentro do seu diário.',
        },
        'local-first': {
          label: 'Local em primeiro lugar — sem servidor de diário do fornecedor',
          description: 'O diário fica no seu computador e funciona com a internet desligada.',
        },
        'own-cloud': {
          label: 'Sincronização por uma pasta na nuvem que já é sua',
          description:
            'O Memlore usa o seu Google Drive ou iCloud Drive. O Journey também oferece Google Drive.',
        },
        'extra-locks': {
          label: 'Segundo cadeado e cofre invisível',
          description:
            'Algumas entradas ficam trancadas, e outras não deixam rastro de que existem.',
        },
        'optional-ai': {
          label: 'Quanta IA opcional você tem',
          description:
            'Títulos, resumos, Go Deeper, Continue & Rewrite, Daily Chat, Ask Journal, memórias, persona, retrospectivas, insights, busca semântica, emoções, máquina do tempo, imagens — local, no dispositivo ou com a sua própria chave.',
        },
        editor: {
          label: 'Um editor que vai além do texto',
          description:
            'Markdown, matemática, blocos de código, comandos de barra e mídia dentro da página.',
        },
        appearance: {
          label: 'Deixe com a sua cara',
          description:
            'Três sistemas de design, cada um com cor, cantos, claro ou escuro e superfície — além do layout dos painéis e de uma fonte de escrita à sua escolha.',
        },
        macos: { label: 'App para macOS' },
        web: {
          label: 'App web (beta)',
          description:
            'Leia e escreva no seu diário em qualquer navegador, ainda com criptografia de ponta a ponta.',
        },
        ios: { label: 'App para iOS' },
        android: { label: 'App para Android' },
        windows: { label: 'App para Windows' },
        linux: { label: 'App para Linux' },
        'beta-free': { label: 'Todos os recursos atuais gratuitos durante o beta' },
      },
    },
    platforms: {
      index: 'Plataformas',
      title: 'Várias plataformas suportadas',
      textWeb: 'macOS e web (beta) hoje. Acompanhe o Memlore enquanto ele cresce.',
      textMac:
        'Estamos começando pelo macOS e levando o tempo necessário para que ele fique do jeito certo. Acompanhe o Memlore enquanto ele cresce.',
      web: 'Web',
      download: 'Baixar',
      open: 'Beta',
      comingSoon: 'Em breve',
      downloadAria: 'Baixar a versão beta no GitHub',
      openAria: 'Abrir o app web',
    },
    footer: {
      titleLead: 'Os dias comuns',
      titleTail: 'merecem ser guardados.',
    },
    hero: {
      mascotFollowAlt: 'O cachorro mascote do Memlore. A cabeça segue o seu cursor.',
      mascotAlt: 'O cachorro mascote do Memlore.',
      portraitLead: 'Um lugar para pousar.',
      portraitTail: 'Mesmo nos dias comuns.',
      openSource: 'Código aberto',
      free: 'Gratuito',
      titleLead: 'Uma vida pequena.',
      titleTail: 'Uma história que fica.',
      descriptionLead: 'O Memlore é um diário privado.',
      descriptionTail:
        'Para os dias que você quer lembrar e os pensamentos que precisam de um lugar.',
      meta: 'Sem conta · Criptografado no seu dispositivo',
      metaWeb: 'macOS e web (beta) hoje',
      metaMac: 'macOS hoje',
    },
    spec: {
      label: 'O que é o Memlore',
      readSource: 'Ler o código-fonte',
      syncValue: 'Sua nuvem',
      syncNote: 'Google Drive ou iCloud Drive.',
      sizeNote: 'Após a instalação',
      aiValue: 'Opcional',
      aiNote: 'Local, no dispositivo ou com a sua própria chave.',
      pluginsValue: 'Em breve',
      pluginsNote: 'Instale só o que precisar.',
      terms: {
        license: 'licença',
        version: 'versão',
        sync: 'sync',
        size: 'tamanho',
        ai: 'ia',
        plugins: 'plugins',
      },
    },
    demo: {
      index: 'Demo',
      title: 'Experimente.',
      subtitle: 'Uma simulação do app Memlore com dados fictícios.',
      cue: 'Clique à vontade. Funciona como o app de verdade.',
      chooseAppearance: 'Escolher aparência',
      openSeparately: 'Abrir separadamente',
      frameTitle: 'Demo interativa do Memlore com entradas de diário fictícias',
      posterAlt: 'Prévia desfocada do diário Memlore com uma entrada de exemplo aberta',
      start: 'Iniciar a demo',
      loadingTitle: 'Abrindo o seu diário de exemplo…',
      loadingText: 'Há algumas memórias para desembrulhar.',
      slowTitle: 'A demo está demorando um pouco mais.',
      slowText: 'Tente carregar de novo ou abra a demo em uma aba separada.',
      tryAgain: 'Tentar de novo',
      openDemo: 'Abrir demo',
      disclaimer: 'Dados de exemplo. Escrita, cadeados, sincronização e IA são simulados.',
      placeholderTitle: 'Esta prévia precisa de uma janela mais larga.',
      placeholderText:
        'O diário de verdade é um app de desktop, então não pode rodar aqui. Quando os apps para iOS e Android chegarem, eles vão ocupar este espaço.',
    },
    encrypt: {
      index: 'Recursos',
      title: 'Sem servidor. Sem porta dos fundos. Nós não conseguimos ler.',
      text: 'Tudo é criptografado no seu dispositivo com a sua senha — inclusive o que é sincronizado com a sua própria nuvem. Não há nenhum servidor do Memlore no meio, e não há como entrar sem essa senha.',
      content: 'Seu conteúdo',
      password: 'Sua senha',
      cloud: 'Sua nuvem',
      noAccess: 'Sem acesso',
      others: 'Outros (até nós)',
      unseen: 'Criptografado antes de sair do seu dispositivo',
    },
    sync: {
      title: 'Sua nuvem. Sua conta. Sua chave.',
      text: 'As entradas são criptografadas no seu dispositivo e depois sincronizadas pelo seu próprio Google Drive ou iCloud Drive. Nunca guardamos seus arquivos, sua conta ou sua chave.',
      thisDevice: 'Este dispositivo',
      encrypted: 'Criptografado com a sua senha',
      ownCloud: 'Sua própria nuvem',
      synced: 'Sincronizado',
      otherDevices: 'Seus outros dispositivos',
      unseen: 'Nenhum servidor do Memlore no meio',
    },
    locks: {
      title: 'Você pode trancar entradas de 3 jeitos diferentes.',
      items: {
        app: {
          title: 'Cadeado do app',
          text: 'O diário só abre com a senha ou com o Touch ID. Este cadeado é obrigatório e protege contra acessos não autorizados.',
        },
        second: {
          title: 'Segundo cadeado',
          text: 'Para manter algumas entradas privadas, adicione um segundo cadeado. Quem tem acesso ao app vai saber que existem entradas privadas, mas não vai conseguir abri-las.',
        },
        invisible: {
          title: 'Cofre invisível',
          text: 'Se você precisa que algumas entradas fiquem totalmente invisíveis e privadas, até para quem consegue desbloquear o app, ninguém vai saber que elas existem.',
        },
      },
    },
    editor: {
      title: 'Editor completo',
      text: 'O editor suporta totalmente Markdown, matemática, código, mídia, @-menções e plugins opcionais. Ele responde rápido, mesmo com conteúdos muito longos.',
      panes: {
        text: 'Palavras',
        math: 'Matemática',
        code: 'Código',
        media: 'Mídia',
        slash: 'Comando de barra',
        mention: 'Menções',
        markdown: 'Markdown',
        plugins: 'Mais plugins',
        request: 'Precisa de mais?',
      },
    },
    emotions: {
      title: 'Registro de emoções',
      text: 'Seu humor pode ser registrado e analisado ao longo do tempo.',
      prompt: 'Como você está se sentindo?',
      options: { bad: 'Nada bem', neutral: 'Mais ou menos', good: 'Bem' },
    },
    locations: {
      title: 'Entradas no mapa',
      text: 'Entradas e fotos ficam onde aconteceram. Abra um marcador para voltar àquela página.',
    },
    transfer: {
      title: 'Importar e exportar',
      text: 'Você pode importar entradas (inclusive mídia) de outras plataformas para o Memlore, e vice-versa. A migração é feita sem complicação.',
      formats: { backup: 'Backup', markdown: 'Markdown', plainText: 'Texto simples' },
    },
    looks: {
      title: 'Deixe com a sua cara.',
      textLead: 'Signature, Clean e Clay — experimente-os na ',
      demoLink: 'demo',
      textTail: ' acima. Depois, continue personalizando.',
      cards: {
        clay: { title: 'Terça-feira', line: 'Uma manhã tranquila' },
        signature: { title: 'Segunda-feira', line: 'Depois que escurece' },
        clean: { title: 'Notas', line: 'Simples e claro' },
        lumen: { title: 'Noite', line: 'Escuro de fundição' },
        'clay-dark': { title: 'Fim de tarde', line: 'Papel aconchegante' },
      },
      editorCard: {
        title: 'Uma história que fica.',
        line: 'A fonte em que você escreve.',
        font: 'Google Font · contraste',
      },
      items: {
        skins: {
          title: 'Três sistemas de design',
          text: 'Signature, Clean e Clay. Troque entre eles ao vivo na demo acima.',
        },
        knobs: {
          title: 'Depois, os ajustes',
          text: 'Cor de destaque, raio dos cantos, claro ou escuro e a superfície escura — Deep, Soft ou Lumen.',
        },
        layout: {
          title: 'Layout dos painéis',
          text: 'Barra lateral e lista à esquerda, à direita ou com a página no meio.',
        },
        type: {
          title: 'Tipografia',
          text: 'A fonte do app acompanha o tema. O editor tem a sua própria fonte — uma embutida ou uma Google Font personalizada, além de tamanho e contraste.',
        },
      },
    },
    talk: {
      title: 'Converse sobre o dia. Depois, guarde a página.',
      text: 'Uma conversa sobre o dia pode virar uma entrada do diário quando você a salva. Fica desligado até você ativar.',
      items: {
        daily: {
          title: 'Daily Chat',
          text: 'Escreva dentro do Memlore. Quando estiver pronto, salve a conversa como uma entrada.',
        },
        voice: { title: 'Modo de voz', text: 'Fale sobre o dia em vez de digitar.' },
        mcp: {
          title: 'MCP',
          text: 'Converse no ChatGPT, Claude, Gemini, Ollama ou outra IA que você já usa.',
        },
      },
      figure: {
        daily: 'Daily Chat',
        you1: 'A caminhada ajudou.',
        ai1: 'O que ficou com você?',
        you2: 'Como a rua estava silenciosa.',
        ai2: 'Vou guardar isso para a página.',
        voice: 'Voz',
        more: 'Mais',
        search: 'Buscar entradas',
        read: 'Ler uma página',
        append: 'Acrescentar a hoje',
        into: 'Depois, salve como entrada',
      },
    },
    persona: {
      title: 'Crie um segundo você.',
      text: 'A partir do seu estilo de escrita, das suas memórias e de como você se descreve, o Memlore cria uma persona que escreve como você — para continuar uma página com a sua voz, ou para sentar e conversar com ela. Fica desligado até você ativar.',
      items: {
        style: {
          title: 'Seu estilo de escrita',
          text: 'Extraído das páginas que você já escreveu.',
        },
        memories: {
          title: 'Suas memórias',
          text: 'As pessoas, os lugares e os fatos que o Memlore aprendeu.',
        },
        words: {
          title: 'Suas próprias palavras',
          text: 'Algumas respostas sobre como você quer soar — e sobre quem você é.',
        },
      },
    },
    plugins: {
      title: 'Plugins, só quando você quiser.',
      soon: 'Em breve',
      text: 'Ferramentas extras chegam como plugins. Instale um quando precisar e deixe o resto de fora.',
    },
    ai: {
      index: 'IA',
      title: 'Um conjunto completo de recursos de IA',
      text: 'As ferramentas de IA só são ativadas se você quiser. O Memlore suporta IA 100% local, além de provedores hospedados usando a sua própria chave.',
      items: {
        titles: {
          title: 'Títulos inteligentes',
          text: 'Uma sugestão de título curto a partir da entrada que você acabou de escrever.',
        },
        summaries: {
          title: 'Destaques e resumos',
          text: 'Um resumo recolhível de temas, emoções e momentos, salvo junto com a entrada.',
        },
        deeper: {
          title: 'Go Deeper',
          text: 'Três perguntas de reflexão para aprofundar, inseridas como cartões abaixo do editor.',
        },
        continue: {
          title: 'Continue & Rewrite',
          text: 'Continue a entrada pelo rodapé ou reescreva um trecho selecionado — com a sua voz.',
        },
        chat: {
          title: 'Daily Chat',
          text: 'Uma conversa sobre o dia que pode virar uma entrada do diário quando você a salva.',
        },
        ask: {
          title: 'Ask Journal',
          text: 'Você pode perguntar sobre as memórias e entradas que o Memlore aprendeu.',
        },
        memories: {
          title: 'Memórias e persona',
          text: 'Com base nas suas entradas e nas informações que você fornece, o Memlore pode criar um segundo você que escreve com a sua voz e o seu estilo.',
        },
        reviews: {
          title: 'Retrospectivas e insights',
          text: 'Você pode usar a IA para ver as estatísticas do que escreveu em um determinado período.',
        },
        search: {
          title: 'Busca semântica',
          text: 'Não apenas uma busca por palavras-chave, mas uma busca pelo significado, feita livremente em linguagem natural.',
        },
        emotion: {
          title: 'Sugestão de emoções',
          text: 'Se você ativar o registro de emoções, a IA pode sugerir o que você está sentindo com base nas entradas que escreveu.',
        },
        time: {
          title: 'Resumo máquina do tempo',
          text: 'A mesma data do calendário ao longo dos anos, reunida em um único resumo.',
        },
        image: {
          title: 'Geração de imagens',
          text: 'Use a IA para gerar imagens de capa e ilustrações no meio do texto das suas entradas.',
        },
        coming: { title: 'Mais por vir' },
        request: { title: 'Precisa de mais?' },
        device: {
          title: 'Opções no dispositivo',
          text: 'O Memlore vem com IA local integrada, para que os seus dados fiquem sempre 100% privados e nunca saiam do seu dispositivo.',
        },
      },
    },
  },
}

export default pt

/** French website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const fr: Messages = {
  meta: {
    homeTitle: 'Memlore — Une petite vie. Une histoire qui dure.',
    homeDescription:
      'Un journal intime pour vos souvenirs. Découvrez Memlore, une application open source pour écrire, prendre du recul et retrouver ce qui compte.',
  },
  socialImageAlt:
    'Memlore, un journal intime : "Une petite vie. Une histoire qui dure." à côté de l’application dans ses thèmes Signature, Clean et Clay, avec un golden retriever low-poly en mascotte.',
  chrome: {
    skipToContent: 'Aller au contenu',
    homeAria: 'Accueil Memlore',
    mainNavAria: 'Navigation principale',
    navDemo: 'Démo',
    navFeatures: 'Fonctionnalités',
    navCompare: 'Comparer',
    navChangelog: 'Nouveautés',
    navDocs: 'Docs',
    downloadForMac: 'Télécharger pour Mac',
    download: 'Télécharger',
    downloadAria: 'Télécharger depuis GitHub',
    closeMenu: 'Fermer le menu',
    openMenu: 'Ouvrir le menu',
    copyright: '© {year} Memlore. Tous droits réservés.',
    footerNavAria: 'À propos, nouveautés, docs, confidentialité, conditions, llms.txt et GitHub',
    footerAbout: 'À propos',
    footerChangelog: 'Nouveautés',
    footerDocs: 'Docs',
    footerPrivacy: 'Confidentialité',
    footerTerms: 'Conditions',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: 'Mentions légales',
    eyebrowAbout: 'À propos',
    lastUpdated: 'Dernière mise à jour : {date}',
  },
  menu: {
    label: 'Langue',
  },
  notice: {
    onlyEnglish: 'Cette page n’est disponible qu’en anglais.',
    backHome: 'Aller à l’accueil en français',
  },
  landing: {
    actions: {
      download: 'Télécharger',
      downloadAria: 'Télécharger depuis GitHub',
      web: 'Web',
      demo: 'Démo',
      watch: 'Regarder',
      watchAria: 'Regarder la présentation',
    },
    intro: {
      title: 'Présentation',
      close: 'Fermer',
      frameTitle: 'Memlore — Une petite vie. Une histoire qui dure.',
    },
    openSource: {
      symbol: 'Fait au grand jour.',
      title: 'Open source',
      text: 'Ouvert, pour que vous puissiez voir comment un journal est sécurisé et comment vos données sont conservées. Memlore reste gratuit.',
      github: 'Voir sur GitHub',
    },
    compare: {
      title: 'Memlore face aux autres.',
      text: 'Memlore à côté de trois journaux que les gens tiennent déjà.',
      tableLabel: 'Tableau comparatif des journaux, une colonne par journal',
      compared: 'Comparé',
      sourcesLead: 'Voir le détail :',
      sourcesNote: 'Les fonctionnalités et les offres peuvent évoluer.',
      levels: ['Quelques-unes', 'Environ la moitié', 'La plupart', 'Toutes'],
      marks: {
        yes: 'Oui',
        no: 'Non',
        soon: 'Bientôt',
        planned: 'Prévu',
        partial: 'Variable ou non documenté',
      },
      rows: {
        'open-source': {
          label: 'Open source',
          description: 'Tout le monde peut lire le code qui protège le journal.',
        },
        password: {
          label: 'Mot de passe exigé avant l’ouverture du journal',
          description:
            'Ce n’est pas un réglage que l’on peut désactiver. Sans lui, les fichiers restent scellés.',
        },
        'your-key-only': {
          label: 'Protégé par votre seul mot de passe',
          description:
            'Les quatre chiffrent. Seul Memlore ne demande aucun compte, n’a aucun serveur éditeur et ne garde aucune porte de récupération vers votre journal.',
        },
        'local-first': {
          label: 'Local d’abord — aucun serveur de journal chez l’éditeur',
          description: 'Le journal vit sur votre machine et fonctionne hors connexion.',
        },
        'own-cloud': {
          label: 'Synchronisation via un dossier cloud qui vous appartient déjà',
          description:
            'Memlore utilise votre Google Drive ou votre iCloud Drive. Journey propose aussi Google Drive.',
        },
        'extra-locks': {
          label: 'Second verrou et coffre invisible',
          description:
            'Certaines entrées restent fermées, et d’autres ne laissent aucune trace de leur existence.',
        },
        'optional-ai': {
          label: 'L’étendue de l’IA facultative',
          description:
            'Titres, résumés, Go Deeper, Continue & Rewrite, Daily Chat, Ask Journal, souvenirs, persona, bilans, analyses, recherche sémantique, émotions, voyage dans le temps, images — en local, sur l’appareil ou avec votre propre clé.',
        },
        editor: {
          label: 'Un éditeur qui contient plus que du texte',
          description:
            'Markdown, formules mathématiques, blocs de code, commandes slash et médias dans la page.',
        },
        appearance: {
          label: 'À votre image',
          description:
            'Trois systèmes de design, chacun avec sa couleur, ses arrondis, son mode clair ou sombre et sa surface — plus la disposition des panneaux et une police d’écriture de votre choix.',
        },
        macos: { label: 'App macOS' },
        web: {
          label: 'App web',
          description:
            'Lisez et écrivez votre journal depuis n’importe quel navigateur, toujours chiffré de bout en bout.',
        },
        ios: { label: 'App iOS' },
        android: { label: 'App Android' },
        windows: { label: 'App Windows' },
        linux: { label: 'App Linux' },
        'beta-free': { label: 'Toutes les fonctionnalités actuelles gratuites pendant la bêta' },
      },
    },
    platforms: {
      index: 'Plateformes',
      title: 'Plusieurs plateformes prises en charge',
      textWeb: 'macOS et le web aujourd’hui. Suivez Memlore au fil de son évolution.',
      textMac:
        'Nous commençons par macOS et prenons le temps de bien faire les choses. Suivez Memlore au fil de son évolution.',
      web: 'Web',
      download: 'Télécharger',
      comingSoon: 'Bientôt',
      planned: 'Prévu',
      downloadAria: 'Télécharger depuis GitHub',
      openAria: 'Ouvrir l’application web',
    },
    footer: {
      titleLead: 'Les jours ordinaires',
      titleTail: 'méritent d’être gardés.',
    },
    hero: {
      mascotFollowAlt: 'Le chien mascotte de Memlore. Sa tête suit votre curseur.',
      mascotAlt: 'Le chien mascotte de Memlore.',
      portraitLead: 'Un endroit où se poser.',
      portraitTail: 'Même les jours ordinaires.',
      openSource: 'Open source',
      free: 'Gratuit',
      titleLead: 'Une petite vie.',
      titleTail: 'Une histoire qui dure.',
      descriptionLead: 'Memlore est un journal intime.',
      descriptionTail:
        'Pour les jours dont vous voulez vous souvenir, et les pensées qu’il faut bien poser quelque part.',
      meta: 'Sans compte · Chiffré sur votre appareil',
      metaWeb: 'macOS et web aujourd’hui',
      metaMac: 'macOS aujourd’hui',
    },
    spec: {
      label: 'Ce qu’est Memlore',
      readSource: 'Lire le code source',
      syncValue: 'Votre cloud',
      syncNote: 'Google Drive ou iCloud Drive.',
      sizeNote: 'Après installation',
      aiValue: 'Facultative',
      aiNote: 'En local, sur l’appareil ou avec votre propre clé.',
      pluginsValue: 'Bientôt',
      pluginsNote: 'N’installez que ce dont vous avez besoin.',
      terms: {
        license: 'licence',
        version: 'version',
        sync: 'synchro',
        size: 'taille',
        ai: 'ia',
        plugins: 'plugins',
      },
    },
    demo: {
      index: 'Démo',
      title: 'Faites-vous une idée.',
      subtitle: 'Une maquette de l’application Memlore avec des données fictives.',
      cue: 'Cliquez partout. Elle fonctionne comme la vraie application.',
      chooseAppearance: 'Choisir l’apparence',
      openSeparately: 'Ouvrir à part',
      frameTitle: 'Démo interactive de Memlore avec des entrées de journal fictives',
      posterAlt: 'Aperçu flouté du journal Memlore avec une entrée d’exemple ouverte',
      start: 'Lancer la démo',
      loadingTitle: 'Ouverture de votre journal d’exemple…',
      loadingText: 'Il y a quelques souvenirs à déballer.',
      slowTitle: 'La démo met un peu plus de temps.',
      slowText: 'Essayez de la recharger, ou ouvrez la démo dans un nouvel onglet.',
      tryAgain: 'Réessayer',
      openDemo: 'Ouvrir la démo',
      disclaimer:
        'Données d’exemple. L’écriture, les verrous, la synchronisation et l’IA sont simulés.',
      placeholderTitle: 'Cet aperçu nécessite une fenêtre plus large.',
      placeholderText:
        'Le journal en direct est une application de bureau, il ne peut donc pas s’afficher ici. Quand les applications iOS et Android arriveront, leur vue prendra cette place.',
    },
    encrypt: {
      index: 'Fonctionnalités',
      title: 'Pas de serveur. Pas de porte dérobée. Nous ne pouvons pas le lire.',
      text: 'Tout est chiffré sur votre appareil avec votre mot de passe — y compris ce qui se synchronise vers votre propre cloud. Il n’y a aucun serveur Memlore entre les deux, et aucun moyen d’y revenir sans ce mot de passe.',
      content: 'Votre contenu',
      password: 'Votre mot de passe',
      cloud: 'Votre cloud',
      noAccess: 'Aucun accès',
      others: 'Les autres (nous compris)',
      unseen: 'Chiffré avant de quitter votre appareil',
    },
    sync: {
      title: 'Votre cloud. Votre compte. Votre clé.',
      text: 'Les entrées sont chiffrées sur votre appareil, puis synchronisées via votre propre Google Drive ou iCloud Drive. Nous ne détenons jamais vos fichiers, votre compte ni votre clé.',
      thisDevice: 'Cet appareil',
      encrypted: 'Chiffré avec votre mot de passe',
      ownCloud: 'Votre propre cloud',
      synced: 'Synchronisé',
      otherDevices: 'Vos autres appareils',
      unseen: 'Aucun serveur Memlore entre les deux',
    },
    locks: {
      title: 'Vous pouvez verrouiller vos entrées de 3 façons.',
      items: {
        app: {
          title: 'Verrou de l’app',
          text: 'Le journal ne s’ouvre qu’avec le mot de passe ou Touch ID. Ce verrou est obligatoire et le protège de tout accès non autorisé.',
        },
        second: {
          title: 'Second verrou',
          text: 'Pour garder certaines entrées privées, ajoutez un second verrou. Les personnes ayant accès à l’app sauront que des entrées privées existent, mais ne pourront pas les ouvrir.',
        },
        invisible: {
          title: 'Coffre invisible',
          text: 'Si certaines entrées doivent rester totalement invisibles et privées, même pour les personnes capables de déverrouiller l’app, celles-ci ne sauront jamais qu’elles existent.',
        },
      },
    },
    editor: {
      title: 'Un éditeur riche en fonctionnalités',
      text: 'L’éditeur prend entièrement en charge le Markdown, les mathématiques, le code, les médias, les mentions @ et des plugins facultatifs. Il reste réactif, même avec des contenus très longs.',
      panes: {
        text: 'Texte',
        math: 'Maths',
        code: 'Code',
        media: 'Médias',
        slash: 'Commande slash',
        mention: 'Mentions',
        markdown: 'Markdown',
        plugins: 'Plus de plugins',
        request: 'Besoin d’autre chose ?',
      },
    },
    emotions: {
      title: 'Suivi des émotions',
      text: 'Votre humeur peut être suivie et analysée dans le temps.',
      prompt: 'Comment vous sentez-vous ?',
      options: { bad: 'Pas bien', neutral: 'Bof', good: 'Bien' },
    },
    locations: {
      title: 'Vos entrées sur une carte',
      text: 'Les entrées et les photos sont placées là où elles ont eu lieu. Ouvrez une épingle pour retrouver la page.',
    },
    transfer: {
      title: 'Import et export',
      text: 'Importez vos entrées (médias compris) depuis d’autres plateformes vers Memlore, et inversement. Pour une migration sans accroc.',
      formats: { backup: 'Sauvegarde', markdown: 'Markdown', plainText: 'Texte brut' },
    },
    looks: {
      title: 'À votre image.',
      textLead: 'Signature, Clean et Clay — essayez-les dans la ',
      demoLink: 'démo',
      textTail: ' ci-dessus. Puis allez plus loin.',
      cards: {
        clay: { title: 'Mardi', line: 'Un matin tranquille' },
        signature: { title: 'Lundi', line: 'Après la nuit tombée' },
        clean: { title: 'Notes', line: 'Simple et clair' },
        lumen: { title: 'Nuit', line: 'Foundry sombre' },
        'clay-dark': { title: 'Soirée', line: 'Papier chaleureux' },
      },
      editorCard: {
        title: 'Une histoire qui dure.',
        line: 'La police dans laquelle vous écrivez.',
        font: 'Google Font · contraste',
      },
      items: {
        skins: {
          title: 'Trois systèmes de design',
          text: 'Signature, Clean et Clay. Passez de l’un à l’autre en direct dans la démo ci-dessus.',
        },
        knobs: {
          title: 'Puis les réglages',
          text: 'Couleur d’accent, arrondi des coins, mode clair ou sombre, et la surface sombre — Deep, Soft ou Lumen.',
        },
        layout: {
          title: 'Disposition des panneaux',
          text: 'Barre latérale et liste à gauche, à droite, ou de part et d’autre de la page.',
        },
        type: {
          title: 'Typographie',
          text: 'La police de l’app suit le thème. L’éditeur a sa propre police — intégrée ou une Google Font personnalisée, avec taille et contraste.',
        },
      },
    },
    talk: {
      title: 'Parlez-en. Puis gardez la page.',
      text: 'Une conversation sur votre journée peut devenir une entrée de journal lorsque vous l’enregistrez. Désactivé tant que vous ne l’activez pas.',
      items: {
        daily: {
          title: 'Daily Chat',
          text: 'Écrivez dans Memlore. Quand vous êtes prêt, enregistrez la conversation comme une entrée.',
        },
        voice: {
          title: 'Mode vocal',
          text: 'Racontez votre journée à voix haute au lieu de l’écrire.',
        },
        mcp: {
          title: 'MCP',
          text: 'Discutez dans ChatGPT, Claude, Gemini, Ollama ou une autre IA que vous utilisez déjà.',
        },
      },
      figure: {
        daily: 'Daily Chat',
        you1: 'La promenade m’a fait du bien.',
        ai1: 'Qu’est-ce qui vous a marqué ?',
        you2: 'Le calme de la rue.',
        ai2: 'Je garde ça pour la page.',
        voice: 'Voix',
        more: 'Plus',
        search: 'Chercher des entrées',
        read: 'Lire une page',
        append: 'Ajouter à aujourd’hui',
        into: 'Puis l’enregistrer comme entrée',
      },
    },
    persona: {
      title: 'Créez un second vous.',
      text: 'À partir de votre style d’écriture, de vos souvenirs et de la façon dont vous vous décrivez, Memlore construit un persona qui écrit comme vous — pour continuer une page avec votre voix, ou pour discuter avec lui. Désactivé tant que vous ne l’activez pas.',
      items: {
        style: {
          title: 'Votre style d’écriture',
          text: 'Tiré des pages que vous tenez déjà.',
        },
        memories: {
          title: 'Vos souvenirs',
          text: 'Les personnes, les lieux et les faits que Memlore a appris.',
        },
        words: {
          title: 'Vos propres mots',
          text: 'Quelques réponses sur la façon dont vous voulez sonner — et sur qui vous êtes.',
        },
      },
    },
    plugins: {
      title: 'Des plugins, seulement si vous le voulez.',
      soon: 'Bientôt',
      text: 'Les outils supplémentaires arrivent sous forme de plugins. Installez-en un quand vous en avez besoin, et laissez les autres de côté.',
    },
    ai: {
      index: 'IA',
      title: 'Un large éventail de fonctions d’IA',
      text: 'Les outils d’IA ne sont activés que si vous le choisissez. Memlore prend en charge une IA 100 % locale, ainsi que des fournisseurs hébergés avec votre propre clé.',
      items: {
        titles: {
          title: 'Titres intelligents',
          text: 'Une suggestion de titre court à partir de l’entrée que vous venez d’écrire.',
        },
        summaries: {
          title: 'Temps forts et résumés',
          text: 'Un récapitulatif repliable des thèmes, émotions et moments, enregistré avec l’entrée.',
        },
        deeper: {
          title: 'Go Deeper',
          text: 'Trois pistes de réflexion pour aller plus loin, insérées en cartes sous l’éditeur.',
        },
        continue: {
          title: 'Continue & Rewrite',
          text: 'Continuez l’entrée depuis le pied de page, ou réécrivez une sélection — avec votre voix.',
        },
        chat: {
          title: 'Daily Chat',
          text: 'Une conversation sur votre journée qui peut devenir une entrée de journal lorsque vous l’enregistrez.',
        },
        ask: {
          title: 'Ask Journal',
          text: 'Posez des questions sur les souvenirs et les entrées que Memlore a appris.',
        },
        memories: {
          title: 'Souvenirs et persona',
          text: 'À partir de vos entrées et des informations que vous fournissez, Memlore peut créer un second vous qui écrit avec votre voix et votre style.',
        },
        reviews: {
          title: 'Bilans et analyses',
          text: 'Utilisez l’IA pour obtenir les statistiques de ce que vous avez écrit sur une période donnée.',
        },
        search: {
          title: 'Recherche sémantique',
          text: 'Pas seulement une recherche par mots-clés, mais une recherche par le sens, formulée librement en langage naturel.',
        },
        emotion: {
          title: 'Suggestion d’émotions',
          text: 'Si vous activez le suivi des émotions, l’IA peut suggérer ce que vous ressentez d’après les entrées que vous avez écrites.',
        },
        time: {
          title: 'Résumé voyage dans le temps',
          text: 'La même date du calendrier au fil des années, réunie en un seul récapitulatif.',
        },
        image: {
          title: 'Génération d’images',
          text: 'L’IA génère des images de couverture et des illustrations pour vos entrées.',
        },
        coming: { title: 'Et bien plus à venir' },
        request: { title: 'Besoin d’autre chose ?' },
        device: {
          title: 'Sur l’appareil',
          text: 'Memlore intègre une IA locale pour que vos données restent toujours 100 % privées et ne quittent jamais votre appareil.',
        },
      },
    },
  },
}

export default fr

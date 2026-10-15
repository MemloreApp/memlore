/** German website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const de: Messages = {
  meta: {
    homeTitle: 'Memlore — Ein kleines Leben. Eine bleibende Geschichte.',
    homeDescription:
      'Ein privates Tagebuch für deine Erinnerungen. Entdecke Memlore, eine Open-Source-App zum Schreiben, Nachdenken und um wiederzufinden, was zählt.',
  },
  socialImageAlt:
    'Memlore, ein privates Tagebuch: "Ein kleines Leben. Eine bleibende Geschichte." neben der App in ihren Themes Signature, Clean und Clay, mit einem Low-Poly-Golden-Retriever als Maskottchen.',
  chrome: {
    skipToContent: 'Zum Inhalt springen',
    homeAria: 'Memlore Startseite',
    mainNavAria: 'Hauptnavigation',
    navDemo: 'Demo',
    navFeatures: 'Funktionen',
    navCompare: 'Vergleich',
    navChangelog: 'Changelog',
    navDocs: 'Doku',
    downloadForMac: 'Für Mac laden',
    download: 'Download',
    downloadAria: 'Die Beta von GitHub herunterladen',
    closeMenu: 'Menü schließen',
    openMenu: 'Menü öffnen',
    copyright: '© {year} Memlore. Alle Rechte vorbehalten.',
    footerNavAria:
      'Über uns, Changelog, Doku, Datenschutz, Nutzungsbedingungen, llms.txt und GitHub',
    footerAbout: 'Über uns',
    footerChangelog: 'Changelog',
    footerDocs: 'Doku',
    footerPrivacy: 'Datenschutz',
    footerTerms: 'Nutzungsbedingungen',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: 'Rechtliches',
    eyebrowAbout: 'Über uns',
    lastUpdated: 'Zuletzt aktualisiert am {date}',
  },
  menu: {
    label: 'Sprache',
  },
  notice: {
    onlyEnglish: 'Diese Seite gibt es nur auf Englisch.',
    backHome: 'Zur deutschen Startseite',
  },
  landing: {
    actions: {
      download: 'Download',
      downloadAria: 'Die Beta von GitHub herunterladen',
      web: 'Web (Beta)',
      demo: 'Demo',
      watch: 'Ansehen',
      watchAria: 'Die Einführung ansehen',
    },
    intro: {
      title: 'Einführung',
      close: 'Schließen',
      frameTitle: 'Memlore — Ein kleines Leben. Eine bleibende Geschichte.',
    },
    openSource: {
      symbol: 'Offen entwickelt.',
      title: 'Open Source',
      text: 'Offen, damit du sehen kannst, wie ein Tagebuch geschützt ist und wie deine Daten aufbewahrt werden. Memlore bleibt kostenlos. Die Beta dient nur Extras, die das Projekt am Laufen halten.',
      github: 'Auf GitHub ansehen',
    },
    compare: {
      title: 'Memlore im Vergleich.',
      text: 'Memlore neben drei Tagebüchern, die Menschen bereits führen.',
      tableLabel: 'Vergleichstabelle der Tagebücher, eine Spalte pro Tagebuch',
      compared: 'Verglichen',
      sourcesLead: 'Details ansehen:',
      sourcesNote: 'Funktionen und Tarife können sich ändern.',
      levels: ['Einige', 'Etwa die Hälfte', 'Die meisten', 'Alle'],
      marks: {
        yes: 'Ja',
        no: 'Nein',
        soon: 'Bald',
        planned: 'Geplant',
        partial: 'Unterschiedlich oder nicht dokumentiert',
      },
      rows: {
        'open-source': {
          label: 'Open Source',
          description: 'Jeder kann den Code lesen, der das Tagebuch verwahrt.',
        },
        password: {
          label: 'Passwort nötig, bevor sich das Tagebuch öffnet',
          description:
            'Keine Einstellung, die du abschalten kannst. Ohne Passwort bleiben die Dateien versiegelt.',
        },
        'your-key-only': {
          label: 'Nur durch dein Passwort geschützt',
          description:
            'Alle vier verschlüsseln. Nur Memlore verlangt kein Konto, betreibt keinen eigenen Server und hat keinen Wiederherstellungsweg zurück in dein Tagebuch.',
        },
        'local-first': {
          label: 'Local-first — kein Tagebuch-Server des Anbieters',
          description: 'Das Tagebuch liegt auf deinem Rechner und funktioniert auch offline.',
        },
        'own-cloud': {
          label: 'Sync über einen Cloud-Ordner, den du schon hast',
          description:
            'Memlore nutzt dein Google Drive oder iCloud Drive. Journey bietet ebenfalls Google Drive an.',
        },
        'extra-locks': {
          label: 'Zweite Sperre und unsichtbarer Tresor',
          description:
            'Manche Einträge bleiben verschlossen, und von manchen weiß niemand, dass es sie gibt.',
        },
        'optional-ai': {
          label: 'Wie viel optionale KI du bekommst',
          description:
            'Titel, Zusammenfassungen, Go Deeper, Continue & Rewrite, Daily Chat, Ask Journal, Erinnerungen, Persona, Rückblicke, Einblicke, semantische Suche, Emotionen, Zeitmaschine, Bilder — lokal, auf dem Gerät oder mit deinem eigenen Schlüssel.',
        },
        editor: {
          label: 'Ein Editor, der mehr als Text kann',
          description:
            'Markdown, Mathe, Codeblöcke, Slash-Befehle und Medien direkt auf der Seite.',
        },
        appearance: {
          label: 'Gestalte es nach deinem Geschmack',
          description:
            'Drei Designsysteme, jeweils mit Farbe, Ecken, hell oder dunkel und Oberfläche — dazu Panel-Layout und eine Schreibschrift deiner Wahl.',
        },
        macos: { label: 'macOS-App' },
        web: {
          label: 'Web-App (Beta)',
          description:
            'Lies und schreibe dein Tagebuch in jedem Browser, weiterhin Ende-zu-Ende-verschlüsselt.',
        },
        ios: { label: 'iOS-App' },
        android: { label: 'Android-App' },
        windows: { label: 'Windows-App' },
        linux: { label: 'Linux-App' },
        'beta-free': { label: 'Alle aktuellen Funktionen während der Beta kostenlos' },
      },
    },
    platforms: {
      index: 'Plattformen',
      title: 'Mehrere Plattformen unterstützt',
      textWeb: 'Heute macOS und das Web (Beta). Verfolge, wie Memlore wächst.',
      textMac:
        'Wir beginnen mit macOS und nehmen uns die Zeit, es richtig zu machen. Verfolge, wie Memlore wächst.',
      web: 'Web',
      download: 'Download',
      comingSoon: 'Demnächst',
      planned: 'Geplant',
      downloadAria: 'Die Beta von GitHub herunterladen',
      openAria: 'Die Web-App öffnen',
    },
    footer: {
      titleLead: 'Die gewöhnlichen Tage',
      titleTail: 'sind es wert, bewahrt zu werden.',
    },
    hero: {
      mascotFollowAlt: 'Memlores Hunde-Maskottchen. Der Kopf folgt deinem Mauszeiger.',
      mascotAlt: 'Memlores Hunde-Maskottchen.',
      portraitLead: 'Ein Ort zum Ankommen.',
      portraitTail: 'Auch an gewöhnlichen Tagen.',
      openSource: 'Open Source',
      free: 'Kostenlos',
      titleLead: 'Ein kleines Leben.',
      titleTail: 'Eine bleibende Geschichte.',
      descriptionLead: 'Memlore ist ein privates Tagebuch.',
      descriptionTail:
        'Für die Tage, an die du dich erinnern willst, und die Gedanken, die irgendwohin müssen.',
      meta: 'Kein Konto · Auf deinem Gerät verschlüsselt',
      metaWeb: 'Heute macOS und Web (Beta)',
      metaMac: 'Heute macOS',
    },
    spec: {
      label: 'Was Memlore ist',
      readSource: 'Quellcode lesen',
      syncValue: 'Deine Cloud',
      syncNote: 'Google Drive oder iCloud Drive.',
      sizeNote: 'Nach der Installation',
      aiValue: 'Optional',
      aiNote: 'Lokal, auf dem Gerät oder mit deinem eigenen Schlüssel.',
      pluginsValue: 'Demnächst',
      pluginsNote: 'Installiere nur, was du brauchst.',
      terms: {
        license: 'lizenz',
        version: 'version',
        sync: 'sync',
        size: 'größe',
        ai: 'ki',
        plugins: 'plugins',
      },
    },
    demo: {
      index: 'Demo',
      title: 'Probier es aus.',
      subtitle: 'Ein Modell der Memlore-App mit erfundenen Daten.',
      cue: 'Klick dich durch. Es funktioniert wie die echte App.',
      chooseAppearance: 'Aussehen wählen',
      openSeparately: 'Separat öffnen',
      frameTitle: 'Interaktive Memlore-Demo mit erfundenen Tagebucheinträgen',
      posterAlt: 'Unscharfe Vorschau des Memlore-Tagebuchs mit einem geöffneten Beispieleintrag',
      start: 'Demo starten',
      loadingTitle: 'Dein Beispieltagebuch wird geöffnet…',
      loadingText: 'Ein paar Erinnerungen wollen ausgepackt werden.',
      slowTitle: 'Die Demo braucht etwas länger.',
      slowText: 'Lade sie erneut oder öffne die Demo in einem eigenen Tab.',
      tryAgain: 'Erneut versuchen',
      openDemo: 'Demo öffnen',
      disclaimer: 'Beispieldaten. Schreiben, Sperren, Sync und KI werden simuliert.',
      placeholderTitle: 'Diese Vorschau braucht ein breiteres Fenster.',
      placeholderText:
        'Das echte Tagebuch ist eine Desktop-App und kann hier nicht laufen. Wenn die iOS- und Android-Apps kommen, erscheint hier ihre Ansicht.',
    },
    encrypt: {
      index: 'Funktionen',
      title: 'Kein Server. Keine Hintertür. Wir können es nicht lesen.',
      text: 'Alles wird auf deinem Gerät mit deinem Passwort verschlüsselt — auch was in deine eigene Cloud synchronisiert wird. Es gibt keinen Memlore-Server dazwischen und ohne dieses Passwort keinen Weg zurück hinein.',
      content: 'Deine Inhalte',
      password: 'Dein Passwort',
      cloud: 'Deine Cloud',
      noAccess: 'Kein Zugriff',
      others: 'Andere (auch wir)',
      unseen: 'Verschlüsselt, bevor es dein Gerät verlässt',
    },
    sync: {
      title: 'Deine Cloud. Dein Konto. Dein Schlüssel.',
      text: 'Einträge werden auf deinem Gerät verschlüsselt und dann über dein eigenes Google Drive oder iCloud Drive synchronisiert. Wir haben nie deine Dateien, dein Konto oder deinen Schlüssel.',
      thisDevice: 'Dieses Gerät',
      encrypted: 'Mit deinem Passwort verschlüsselt',
      ownCloud: 'Deine eigene Cloud',
      synced: 'Synchronisiert',
      otherDevices: 'Deine anderen Geräte',
      unseen: 'Kein Memlore-Server dazwischen',
    },
    locks: {
      title: 'Du kannst Einträge auf 3 Arten sperren.',
      items: {
        app: {
          title: 'App-Sperre',
          text: 'Das Tagebuch öffnet sich nur mit dem Passwort oder Touch ID. Diese Sperre ist Pflicht und schützt es vor unbefugtem Zugriff.',
        },
        second: {
          title: 'Zweite Sperre',
          text: 'Um manche Einträge privat zu halten, füge eine zweite Sperre hinzu. Andere mit Zugriff auf die App wissen, dass private Einträge existieren, können sie aber nicht öffnen.',
        },
        invisible: {
          title: 'Unsichtbarer Tresor',
          text: 'Wenn Einträge völlig unsichtbar und privat bleiben sollen, selbst vor Menschen, die die App entsperren können: Sie werden nicht wissen, dass diese Einträge existieren.',
        },
      },
    },
    editor: {
      title: 'Funktionsreicher Editor',
      text: 'Der Editor unterstützt Markdown, Mathe, Code, Medien, @-Erwähnungen und optionale Plugins vollständig. Er reagiert schnell, auch bei sehr langen Inhalten.',
      panes: {
        text: 'Wörter',
        math: 'Mathe',
        code: 'Code',
        media: 'Medien',
        slash: 'Slash-Befehl',
        mention: 'Erwähnungen',
        markdown: 'Markdown',
        plugins: 'Mehr Plugins',
        request: 'Mehr gewünscht?',
      },
    },
    emotions: {
      title: 'Stimmungs-Tracking',
      text: 'Deine Stimmung kann über die Zeit erfasst und ausgewertet werden.',
      prompt: 'Wie fühlst du dich?',
      options: { bad: 'Nicht gut', neutral: 'Geht so', good: 'Gut' },
    },
    locations: {
      title: 'Einträge auf einer Karte',
      text: 'Einträge und Fotos liegen dort, wo sie passiert sind. Öffne eine Markierung, um zu dieser Seite zurückzukehren.',
    },
    transfer: {
      title: 'Import und Export',
      text: 'Du kannst Einträge (samt Medien) aus anderen Plattformen in Memlore importieren und umgekehrt. Damit der Umzug reibungslos gelingt.',
      formats: { backup: 'Backup', markdown: 'Markdown', plainText: 'Klartext' },
    },
    looks: {
      title: 'Gestalte es nach deinem Geschmack.',
      textLead: 'Signature, Clean und Clay — probier sie in der ',
      demoLink: 'Demo',
      textTail: ' oben aus. Und dann geht es weiter.',
      cards: {
        clay: { title: 'Dienstag', line: 'Ein ruhiger Morgen' },
        signature: { title: 'Montag', line: 'Nach Einbruch der Dunkelheit' },
        clean: { title: 'Notizen', line: 'Schlicht und klar' },
        lumen: { title: 'Nacht', line: 'Foundry dunkel' },
        'clay-dark': { title: 'Abend', line: 'Warmes Papier' },
      },
      editorCard: {
        title: 'Eine bleibende Geschichte.',
        line: 'Die Schrift, in der du schreibst.',
        font: 'Google Font · Kontrast',
      },
      items: {
        skins: {
          title: 'Drei Designsysteme',
          text: 'Signature, Clean und Clay. Wechsle sie live in der Demo oben.',
        },
        knobs: {
          title: 'Dann die Feinheiten',
          text: 'Akzentfarbe, Eckenradius, hell oder dunkel und die dunkle Oberfläche — Deep, Soft oder Lumen.',
        },
        layout: {
          title: 'Panel-Layout',
          text: 'Seitenleiste und Liste links, rechts oder mit der Seite in der Mitte.',
        },
        type: {
          title: 'Schrift',
          text: 'Die App-Schrift folgt dem Skin. Der Editor hat seine eigene Schrift — eine mitgelieferte oder eine eigene Google Font, dazu Größe und Kontrast.',
        },
      },
    },
    talk: {
      title: 'Sprich darüber. Dann behalte die Seite.',
      text: 'Ein Gespräch über den Tag kann zum Tagebucheintrag werden, wenn du es speicherst. Bleibt aus, bis du es aktivierst.',
      items: {
        daily: {
          title: 'Daily Chat',
          text: 'Schreib direkt in Memlore. Wenn du so weit bist, speichere den Verlauf als Eintrag.',
        },
        voice: { title: 'Sprachmodus', text: 'Erzähl vom Tag, statt zu tippen.' },
        mcp: {
          title: 'MCP',
          text: 'Chatte in ChatGPT, Claude, Gemini, Ollama oder einer anderen KI, die du schon nutzt.',
        },
      },
      figure: {
        daily: 'Daily Chat',
        you1: 'Der Spaziergang hat geholfen.',
        ai1: 'Was ist dir geblieben?',
        you2: 'Wie still die Straße war.',
        ai2: 'Das halte ich für die Seite fest.',
        voice: 'Sprache',
        more: 'Mehr',
        search: 'Einträge durchsuchen',
        read: 'Eine Seite lesen',
        append: 'An heute anhängen',
        into: 'Dann als Eintrag speichern',
      },
    },
    persona: {
      title: 'Erschaffe ein zweites Ich.',
      text: 'Aus deinem Schreibstil, deinen Erinnerungen und deiner Selbstbeschreibung erstellt Memlore eine Persona, die wie du schreibt — um eine Seite in deiner Stimme fortzusetzen oder dich mit ihr zu unterhalten. Bleibt aus, bis du es aktivierst.',
      items: {
        style: {
          title: 'Dein Schreibstil',
          text: 'Abgeleitet aus den Seiten, die du schon führst.',
        },
        memories: {
          title: 'Deine Erinnerungen',
          text: 'Die Menschen, Orte und Fakten, die Memlore gelernt hat.',
        },
        words: {
          title: 'Deine eigenen Worte',
          text: 'Ein paar Antworten dazu, wie du klingen willst — und wer du bist.',
        },
      },
    },
    plugins: {
      title: 'Plugins, nur wenn du sie willst.',
      soon: 'Demnächst',
      text: 'Zusätzliche Werkzeuge kommen als Plugins. Installiere eines, wenn du es brauchst, und lass den Rest weg.',
    },
    ai: {
      index: 'KI',
      title: 'Viele KI-Funktionen',
      text: 'KI-Werkzeuge sind nur aktiv, wenn du zustimmst. Memlore unterstützt 100 % lokale KI sowie gehostete Anbieter mit deinem eigenen Schlüssel.',
      items: {
        titles: {
          title: 'Smarte Titel',
          text: 'Ein kurzer Titelvorschlag zum Eintrag, den du gerade geschrieben hast.',
        },
        summaries: {
          title: 'Highlights und Zusammenfassungen',
          text: 'Ein ausklappbarer Rückblick auf Themen, Gefühle und Momente, gespeichert mit dem Eintrag.',
        },
        deeper: {
          title: 'Go Deeper',
          text: 'Drei weiterführende Denkanstöße, als Karten unter dem Editor eingefügt.',
        },
        continue: {
          title: 'Continue & Rewrite',
          text: 'Setze den Eintrag von der Fußleiste aus fort oder formuliere eine Auswahl um — in deiner Stimme.',
        },
        chat: {
          title: 'Daily Chat',
          text: 'Ein Gespräch über den Tag, das zum Tagebucheintrag werden kann, wenn du es speicherst.',
        },
        ask: {
          title: 'Ask Journal',
          text: 'Frag nach den Erinnerungen und Einträgen, die Memlore gelernt hat.',
        },
        memories: {
          title: 'Erinnerungen und Persona',
          text: 'Aus deinen Einträgen und deinen Angaben kann Memlore ein zweites Ich erschaffen, das in deiner Stimme und deinem Stil schreibt.',
        },
        reviews: {
          title: 'Rückblicke und Einblicke',
          text: 'Mit KI bekommst du Statistiken zu dem, was du in einem bestimmten Zeitraum geschrieben hast.',
        },
        search: {
          title: 'Semantische Suche',
          text: 'Nicht nur eine Stichwortsuche, sondern eine Suche nach Bedeutung, frei in natürlicher Sprache formuliert.',
        },
        emotion: {
          title: 'Gefühlsvorschläge',
          text: 'Wenn du das Stimmungs-Tracking aktivierst, kann KI anhand deiner Einträge vorschlagen, welche Gefühle du hast.',
        },
        time: {
          title: 'Zeitmaschinen-Rückblick',
          text: 'Dasselbe Kalenderdatum über die Jahre, zu einem Rückblick zusammengefasst.',
        },
        image: {
          title: 'Bildgenerierung',
          text: 'Mit KI Titelbilder und Illustrationen für deine Einträge erzeugen.',
        },
        coming: { title: 'Mehr folgt' },
        request: { title: 'Mehr gewünscht?' },
        device: {
          title: 'Auf dem Gerät',
          text: 'Memlore bringt integrierte, lokale KI mit, damit deine Daten immer zu 100 % privat bleiben und dein Gerät nie verlassen.',
        },
      },
    },
  },
}

export default de

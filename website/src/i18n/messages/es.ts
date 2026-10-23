/** Spanish website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const es: Messages = {
  meta: {
    homeTitle: 'Memlore — Una pequeña vida. Una historia que perdura.',
    homeDescription:
      'Un diario privado para tus recuerdos. Descubre Memlore, una app de código abierto para escribir, reflexionar y volver a lo que de verdad importa.',
  },
  socialImageAlt:
    'Memlore, un diario privado: "Una pequeña vida. Una historia que perdura." junto a la app en sus temas Signature, Clean y Clay, con un golden retriever low-poly como mascota.',
  chrome: {
    skipToContent: 'Saltar al contenido',
    homeAria: 'Inicio de Memlore',
    mainNavAria: 'Navegación principal',
    navDemo: 'Demo',
    navFeatures: 'Funciones',
    navCompare: 'Comparar',
    navChangelog: 'Novedades',
    navDocs: 'Documentación',
    downloadForMac: 'Descargar para Mac',
    download: 'Descargar',
    downloadAria: 'Descargar desde GitHub',
    closeMenu: 'Cerrar menú',
    openMenu: 'Abrir menú',
    copyright: '© {year} Memlore. Todos los derechos reservados.',
    footerNavAria: 'Acerca de, novedades, documentación, privacidad, términos, llms.txt y GitHub',
    footerAbout: 'Acerca de',
    footerChangelog: 'Novedades',
    footerDocs: 'Documentación',
    footerPrivacy: 'Privacidad',
    footerTerms: 'Términos',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: 'Legal',
    eyebrowAbout: 'Acerca de',
    lastUpdated: 'Última actualización: {date}',
  },
  menu: {
    label: 'Idioma',
  },
  notice: {
    onlyEnglish: 'Esta página solo está disponible en inglés.',
    backHome: 'Ir a la página de inicio en español',
  },
  landing: {
    actions: {
      download: 'Descargar',
      downloadAria: 'Descargar desde GitHub',
      web: 'Web',
      demo: 'Demo',
      watch: 'Ver',
      watchAria: 'Ver la presentación',
    },
    intro: {
      title: 'Presentación',
      close: 'Cerrar',
      frameTitle: 'Memlore — Una pequeña vida. Una historia que perdura.',
    },
    openSource: {
      symbol: 'Hecho a la vista de todos.',
      title: 'Código abierto',
      text: 'Abierto para que veas cómo se protege un diario y cómo se guardan tus datos. Memlore seguirá siendo gratis.',
      github: 'Ver en GitHub',
    },
    compare: {
      title: 'Memlore frente a los demás.',
      text: 'Memlore junto a tres diarios que la gente ya usa.',
      tableLabel: 'Tabla comparativa de diarios, una columna por diario',
      compared: 'Comparativa',
      sourcesLead: 'Consulta los detalles:',
      sourcesNote: 'Las funciones y los planes pueden cambiar.',
      levels: ['Algunas', 'Cerca de la mitad', 'La mayoría', 'Todas'],
      marks: {
        yes: 'Sí',
        no: 'No',
        soon: 'Pronto',
        planned: 'Previsto',
        partial: 'Varía o no está documentado',
      },
      rows: {
        'open-source': {
          label: 'Código abierto',
          description: 'Cualquiera puede leer el código que guarda el diario.',
        },
        password: {
          label: 'Contraseña obligatoria antes de abrir el diario',
          description:
            'No es un ajuste que se pueda desactivar. Sin ella, los archivos siguen sellados.',
        },
        'your-key-only': {
          label: 'Protegido solo por tu contraseña',
          description:
            'Los cuatro cifran. Solo Memlore no pide cuenta, no tiene servidor propio y no guarda ninguna vía de recuperación para entrar en tu diario.',
        },
        'local-first': {
          label: 'Local primero — sin servidor de diario del proveedor',
          description: 'El diario vive en tu equipo y funciona sin conexión.',
        },
        'own-cloud': {
          label: 'Sincronización mediante una carpeta en la nube que ya tienes',
          description:
            'Memlore usa tu Google Drive o iCloud Drive. Journey también ofrece Google Drive.',
        },
        'extra-locks': {
          label: 'Segundo bloqueo y bóveda invisible',
          description: 'Algunas entradas siguen cerradas y otras no dejan rastro de que existen.',
        },
        'optional-ai': {
          label: 'Cuánta IA opcional obtienes',
          description:
            'Títulos, resúmenes, Go Deeper, Continue & Rewrite, Daily Chat, Ask Journal, recuerdos, persona, balances, análisis, búsqueda semántica, emociones, máquina del tiempo, imágenes — en local, en el dispositivo o con tu propia clave.',
        },
        editor: {
          label: 'Un editor que admite mucho más que texto',
          description:
            'Markdown, fórmulas, bloques de código, comandos con barra y multimedia dentro de la página.',
        },
        appearance: {
          label: 'Hazlo a tu manera',
          description:
            'Tres sistemas de diseño, cada uno con color, esquinas, modo claro u oscuro y superficie — además de la disposición de paneles y una fuente de escritura a tu elección.',
        },
        macos: { label: 'App para macOS' },
        web: {
          label: 'App web',
          description:
            'Lee y escribe tu diario desde cualquier navegador, con cifrado de extremo a extremo.',
        },
        ios: { label: 'App para iOS' },
        android: { label: 'App para Android' },
        windows: { label: 'App para Windows' },
        linux: { label: 'App para Linux' },
        'beta-free': { label: 'Todas las funciones actuales gratis durante la beta' },
      },
    },
    platforms: {
      index: 'Plataformas',
      title: 'Disponible en varias plataformas',
      textWeb: 'macOS y la web, por ahora. Sigue cómo crece Memlore.',
      textMac:
        'Empezamos por macOS y nos tomamos el tiempo de hacerlo bien. Sigue cómo crece Memlore.',
      web: 'Web',
      download: 'Descargar',
      comingSoon: 'Próximamente',
      planned: 'Previsto',
      downloadAria: 'Descargar desde GitHub',
      openAria: 'Abrir la app web',
    },
    footer: {
      titleLead: 'Los días corrientes',
      titleTail: 'también merecen guardarse.',
    },
    hero: {
      mascotFollowAlt: 'La mascota perro de Memlore. Su cabeza sigue tu cursor.',
      mascotAlt: 'La mascota perro de Memlore.',
      portraitLead: 'Un lugar donde aterrizar.',
      portraitTail: 'Incluso en los días corrientes.',
      openSource: 'Código abierto',
      free: 'Gratis',
      titleLead: 'Una pequeña vida.',
      titleTail: 'Una historia que perdura.',
      descriptionLead: 'Memlore es un diario privado.',
      descriptionTail:
        'Para los días que quieres recordar y los pensamientos que necesitas dejar en algún sitio.',
      meta: 'Sin cuenta · Cifrado en tu dispositivo',
      metaWeb: 'macOS y web, por ahora',
      metaMac: 'macOS, por ahora',
    },
    spec: {
      label: 'Qué es Memlore',
      readSource: 'Leer el código',
      syncValue: 'Tu nube',
      syncNote: 'Google Drive o iCloud Drive.',
      sizeNote: 'Tras la instalación',
      aiValue: 'Opcional',
      aiNote: 'En local, en el dispositivo o con tu propia clave.',
      pluginsValue: 'Próximamente',
      pluginsNote: 'Instala solo lo que necesites.',
      terms: {
        license: 'licencia',
        version: 'versión',
        sync: 'sincronización',
        size: 'tamaño',
        ai: 'ia',
        plugins: 'plugins',
      },
    },
    screenshots: {
      index: 'Capturas',
      title: 'Un vistazo por dentro.',
      subtitle:
        'Las pantallas principales con datos de ejemplo, en los estilos Clay, Clean y Signature.',
      open: 'Ver a pantalla completa: {label}',
      openMore: 'Ver a pantalla completa: {label}, y {count} capturas más',
      viewer: 'Visor de capturas',
      previous: 'Captura anterior',
      next: 'Captura siguiente',
      close: 'Cerrar',
      items: {
        write: {
          label: 'Escribe con fotos',
          alt: 'Una entrada con una foto, abierta junto a la lista de entradas',
        },
        search: {
          label: 'Búscalo todo',
          alt: 'Resultados de búsqueda de "coffee" con las coincidencias resaltadas y filtros por diario, etiquetas y emoción',
        },
        home: {
          label: 'Inicio de un vistazo',
          alt: 'Inicio con la racha de escritura, el número de entradas y palabras, una idea para escribir y las entradas recientes',
        },
        calendar: {
          label: 'Calendario',
          alt: 'Un mes en el calendario con un día elegido y su entrada de viaje abierta',
        },
        gallery: {
          label: 'Galería de fotos',
          alt: 'Una cuadrícula con las fotos adjuntas a entradas de todos los diarios',
        },
        lock: {
          label: 'Bloqueado con tu contraseña',
          alt: 'La pantalla de bloqueo pide la contraseña antes de abrir el diario',
        },
        tags: {
          label: 'Etiquetas',
          alt: 'Etiquetas con su número de entradas y una entrada etiquetada gratitude abierta',
        },
        stats: {
          label: 'Estadísticas',
          alt: 'Estadísticas con entradas, palabras, racha, reparto del ánimo y un mapa de calor del año',
        },
        chat: {
          label: 'Daily Chat con IA',
          alt: 'Una conversación de Daily Chat sobre el día, con respuestas de una IA',
        },
        focus: {
          label: 'Modo sin distracciones',
          alt: 'Una entrada en modo sin distracciones, sin la barra lateral ni la lista de entradas',
        },
        appearance: {
          label: 'Tres estilos, claro u oscuro',
          alt: 'Ajustes de apariencia para elegir el estilo Clay, Clean o Signature, claro u oscuro, y un color de acento',
        },
        sync: {
          label: 'Sincroniza con tu propia nube',
          alt: 'Ajustes de sincronización para elegir iCloud Drive, Google Drive o una carpeta local',
        },
        locks: {
          label: 'Segundo bloqueo',
          alt: 'Ajustes del segundo bloqueo para ocultar entradas elegidas tras una contraseña extra',
        },
        data: {
          label: 'Importar y exportar',
          alt: 'Ajustes de datos para importar una copia de Memlore o una carpeta de notas',
        },
      },
    },
    demo: {
      index: 'Demo',
      title: 'Pruébalo tú mismo.',
      subtitle: 'Una maqueta de la app Memlore con datos ficticios.',
      cue: 'Haz clic donde quieras. Funciona como la app real.',
      chooseAppearance: 'Elegir apariencia',
      openSeparately: 'Abrir aparte',
      frameTitle: 'Demo interactiva de Memlore con entradas de diario ficticias',
      posterAlt: 'Vista previa difuminada del diario Memlore con una entrada de ejemplo abierta',
      start: 'Iniciar la demo',
      loadingTitle: 'Abriendo tu diario de ejemplo…',
      loadingText: 'Hay unos cuantos recuerdos por desempacar.',
      slowTitle: 'La demo está tardando un poco más.',
      slowText: 'Vuelve a cargarla o abre la demo en su propia pestaña.',
      tryAgain: 'Reintentar',
      openDemo: 'Abrir la demo',
      disclaimer:
        'Datos de ejemplo. La escritura, los bloqueos, la sincronización y la IA son simulados.',
      placeholderTitle: 'Esta vista previa necesita una ventana más ancha.',
      placeholderText:
        'El diario real es una app de escritorio, así que no puede ejecutarse aquí. Cuando lleguen las apps para iOS y Android, su vista ocupará este lugar.',
    },
    encrypt: {
      index: 'Funciones',
      title: 'Sin servidor. Sin puerta trasera. No podemos leerlo.',
      text: 'Todo se cifra en tu dispositivo con tu contraseña — incluido lo que se sincroniza con tu propia nube. No hay ningún servidor de Memlore de por medio, ni forma de volver a entrar sin esa contraseña.',
      content: 'Tu contenido',
      password: 'Tu contraseña',
      cloud: 'Tu nube',
      noAccess: 'Sin acceso',
      others: 'Otros (incluidos nosotros)',
      unseen: 'Cifrado antes de salir de tu dispositivo',
    },
    sync: {
      title: 'Tu nube. Tu cuenta. Tu clave.',
      text: 'Las entradas se cifran en tu dispositivo y luego se sincronizan a través de tu propio Google Drive o iCloud Drive. Nunca guardamos tus archivos, tu cuenta ni tu clave.',
      thisDevice: 'Este dispositivo',
      encrypted: 'Cifrado con tu contraseña',
      ownCloud: 'Tu propia nube',
      synced: 'Sincronizado',
      otherDevices: 'Tus otros dispositivos',
      unseen: 'Ningún servidor de Memlore de por medio',
    },
    locks: {
      title: 'Puedes bloquear las entradas de 3 formas distintas.',
      items: {
        app: {
          title: 'Bloqueo de la app',
          text: 'El diario solo se abre con la contraseña o Touch ID. Este bloqueo es obligatorio y lo protege de accesos no autorizados.',
        },
        second: {
          title: 'Segundo bloqueo',
          text: 'Para mantener algunas entradas en privado, añade un segundo bloqueo. Quien tenga acceso a la app sabrá que existen entradas privadas, pero no podrá abrirlas.',
        },
        invisible: {
          title: 'Bóveda invisible',
          text: 'Si necesitas que ciertas entradas sean totalmente invisibles y privadas, incluso para quien pueda desbloquear la app, nadie sabrá que existen.',
        },
      },
    },
    editor: {
      title: 'Un editor completo',
      text: 'El editor admite por completo Markdown, fórmulas matemáticas, código, multimedia, menciones con @ y plugins opcionales. Responde con rapidez, incluso con contenidos muy largos.',
      panes: {
        text: 'Palabras',
        math: 'Fórmulas',
        code: 'Código',
        media: 'Multimedia',
        slash: 'Comando con barra',
        mention: 'Menciones',
        markdown: 'Markdown',
        plugins: 'Más plugins',
        request: '¿Necesitas más?',
      },
    },
    emotions: {
      title: 'Seguimiento de emociones',
      text: 'Tu estado de ánimo puede registrarse y analizarse con el tiempo.',
      prompt: '¿Cómo te sientes?',
      options: { bad: 'No muy bien', neutral: 'Regular', good: 'Bien' },
    },
    locations: {
      title: 'Entradas en un mapa',
      text: 'Las entradas y las fotos aparecen donde ocurrieron. Abre un marcador para volver a esa página.',
    },
    transfer: {
      title: 'Importar y exportar',
      text: 'Puedes importar entradas (multimedia incluida) desde otras plataformas a Memlore, y viceversa, para que la migración sea fluida.',
      formats: { backup: 'Copia de seguridad', markdown: 'Markdown', plainText: 'Texto plano' },
    },
    looks: {
      title: 'Hazlo a tu manera.',
      textLead: 'Signature, Clean y Clay — pruébalos en la ',
      demoLink: 'demo',
      textTail: ' de arriba. Y sigue personalizando.',
      cards: {
        clay: { title: 'Martes', line: 'Una mañana tranquila' },
        signature: { title: 'Lunes', line: 'Al caer la noche' },
        clean: { title: 'Notas', line: 'Simple y claro' },
        lumen: { title: 'Noche', line: 'Oscuro fundición' },
        'clay-dark': { title: 'Tarde', line: 'Papel cálido' },
      },
      editorCard: {
        title: 'Una historia que perdura.',
        line: 'La letra con la que escribes.',
        font: 'Google Font · contraste',
      },
      items: {
        skins: {
          title: 'Tres sistemas de diseño',
          text: 'Signature, Clean y Clay. Cámbialos en directo en la demo de arriba.',
        },
        knobs: {
          title: 'Y luego, los ajustes',
          text: 'Color de acento, radio de las esquinas, modo claro u oscuro y la superficie oscura — Deep, Soft o Lumen.',
        },
        layout: {
          title: 'Disposición de paneles',
          text: 'Barra lateral y lista a la izquierda, a la derecha o con la página en el centro.',
        },
        type: {
          title: 'Tipografía',
          text: 'La tipografía de la app sigue al tema. El editor tiene su propia fuente — una integrada o una Google Font personalizada, además de tamaño y contraste.',
        },
      },
    },
    talk: {
      title: 'Háblalo. Y quédate con la página.',
      text: 'Una conversación sobre tu día puede convertirse en una entrada del diario cuando la guardas. Desactivado hasta que decidas activarlo.',
      items: {
        daily: {
          title: 'Daily Chat',
          text: 'Escribe dentro de Memlore. Cuando quieras, guarda la conversación como una entrada.',
        },
        voice: { title: 'Modo de voz', text: 'Cuenta tu día en voz alta en lugar de escribirlo.' },
        mcp: {
          title: 'MCP',
          text: 'Chatea en ChatGPT, Claude, Gemini, Ollama u otra IA que ya uses.',
        },
      },
      figure: {
        daily: 'Daily Chat',
        you1: 'El paseo me sentó bien.',
        ai1: '¿Qué es lo que más se te quedó?',
        you2: 'Lo tranquila que estaba la calle.',
        ai2: 'Lo guardaré para la página.',
        voice: 'Voz',
        more: 'Más',
        search: 'Buscar entradas',
        read: 'Leer una página',
        append: 'Añadir a hoy',
        into: 'Y luego guárdalo como entrada',
      },
    },
    persona: {
      title: 'Crea un segundo tú.',
      text: 'A partir de tu forma de escribir, tus recuerdos y cómo te describes, Memlore crea una persona que escribe como tú — para continuar una página con tu voz o sentarte a hablar con ella. Desactivado hasta que decidas activarlo.',
      items: {
        style: {
          title: 'Tu estilo de escritura',
          text: 'Extraído de las páginas que ya escribes.',
        },
        memories: {
          title: 'Tus recuerdos',
          text: 'Las personas, los lugares y los datos que Memlore ha aprendido.',
        },
        words: {
          title: 'Tus propias palabras',
          text: 'Unas cuantas respuestas sobre cómo quieres sonar — y quién eres.',
        },
      },
    },
    plugins: {
      title: 'Plugins, solo cuando los quieras.',
      soon: 'Próximamente',
      text: 'Las herramientas adicionales llegan como plugins. Instala uno cuando lo necesites y deja fuera el resto.',
    },
    ai: {
      index: 'IA',
      title: 'Un amplio conjunto de funciones de IA',
      text: 'Las herramientas de IA solo se activan si tú lo decides. Memlore admite IA 100 % local, además de proveedores en la nube con tu propia clave.',
      items: {
        titles: {
          title: 'Títulos inteligentes',
          text: 'Una sugerencia de título breve a partir de la entrada que acabas de escribir.',
        },
        summaries: {
          title: 'Destacados y resúmenes',
          text: 'Un resumen desplegable de temas, emociones y momentos, guardado con la entrada.',
        },
        deeper: {
          title: 'Go Deeper',
          text: 'Tres preguntas de reflexión para seguir profundizando, insertadas como tarjetas bajo el editor.',
        },
        continue: {
          title: 'Continue & Rewrite',
          text: 'Continúa la entrada desde el pie, o reescribe una selección — con tu propia voz.',
        },
        chat: {
          title: 'Daily Chat',
          text: 'Una conversación sobre tu día que puede convertirse en una entrada del diario cuando la guardas.',
        },
        ask: {
          title: 'Ask Journal',
          text: 'Puedes preguntar sobre los recuerdos y las entradas que Memlore ha aprendido.',
        },
        memories: {
          title: 'Recuerdos y persona',
          text: 'A partir de tus entradas y de la información que aportas, Memlore puede crear un segundo tú que escribe con tu voz y tu estilo.',
        },
        reviews: {
          title: 'Balances y análisis',
          text: 'Puedes usar la IA para obtener estadísticas de lo que has escrito en un periodo determinado.',
        },
        search: {
          title: 'Búsqueda semántica',
          text: 'No solo una búsqueda por palabras clave, sino una búsqueda por significado, expresada libremente en lenguaje natural.',
        },
        emotion: {
          title: 'Sugerencia de emociones',
          text: 'Si activas el seguimiento de emociones, la IA puede sugerir cómo te sientes a partir de las entradas que has escrito.',
        },
        time: {
          title: 'Resumen de la máquina del tiempo',
          text: 'La misma fecha del calendario a lo largo de los años, reunida en un solo resumen.',
        },
        image: {
          title: 'Generación de imágenes',
          text: 'Usa la IA para generar imágenes de portada e ilustraciones dentro de tus entradas.',
        },
        coming: { title: 'Y mucho más por venir' },
        request: { title: '¿Necesitas más?' },
        device: {
          title: 'Opciones en el dispositivo',
          text: 'Memlore incluye IA local integrada para que tus datos sean siempre 100 % privados y nunca salgan de tu dispositivo.',
        },
      },
    },
  },
}

export default es

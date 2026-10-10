/** Simplified Chinese website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const zhHans: Messages = {
  meta: {
    homeTitle: 'Memlore — 一段小小的人生，一个长久的故事。',
    homeDescription:
      '一本珍藏回忆的私人日记。了解 Memlore：一款开源应用，用来书写、回顾，并找回对你重要的事。',
  },
  socialImageAlt:
    'Memlore，一本私人日记："一段小小的人生，一个长久的故事。"旁边是应用的 Signature、Clean 和 Clay 三种主题，还有一只低多边形风格的金毛寻回犬吉祥物。',
  chrome: {
    skipToContent: '跳到正文',
    homeAria: 'Memlore 首页',
    mainNavAria: '主导航',
    navDemo: '演示',
    navFeatures: '功能',
    navCompare: '对比',
    navChangelog: '更新日志',
    navDocs: '文档',
    downloadForMac: '下载 Mac 版',
    download: '下载',
    downloadAria: '从 GitHub 下载测试版',
    closeMenu: '关闭菜单',
    openMenu: '打开菜单',
    copyright: '© {year} Memlore。保留所有权利。',
    footerNavAria: '关于、更新日志、文档、隐私、条款和 GitHub',
    footerAbout: '关于',
    footerChangelog: '更新日志',
    footerDocs: '文档',
    footerPrivacy: '隐私',
    footerTerms: '条款',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: '法律信息',
    eyebrowAbout: '关于',
    lastUpdated: '最后更新于 {date}',
  },
  menu: {
    label: '语言',
  },
  notice: {
    onlyEnglish: '此页面仅提供英文版本。',
    backHome: '前往简体中文首页',
  },
  landing: {
    actions: {
      download: '下载',
      downloadAria: '从 GitHub 下载测试版',
      web: '网页版',
      demo: '演示',
      watch: '观看',
      watchAria: '观看介绍视频',
    },
    intro: {
      title: '介绍',
      close: '关闭',
      frameTitle: 'Memlore — 一段小小的人生，一个长久的故事。',
    },
    openSource: {
      symbol: '公开打造。',
      title: '开源',
      text: '开源，让你能看清一本日记如何被保护、你的数据如何被保管。Memlore 始终免费。测试版之外的付费内容，只会是支持项目持续发展的额外功能。',
      github: '在 GitHub 上查看',
    },
    compare: {
      title: 'Memlore 与其他日记的对比。',
      text: '把 Memlore 和人们已经在用的三款日记应用放在一起比较。',
      tableLabel: '日记应用对比表，每列对应一款日记应用',
      compared: '对比项',
      sourcesLead: '查看详情：',
      sourcesNote: '功能和方案可能会有变化。',
      levels: ['少量', '约一半', '大部分', '全部'],
      marks: {
        yes: '是',
        no: '否',
        soon: '即将推出',
        partial: '视情况而定或未说明',
      },
      rows: {
        'open-source': {
          label: '开源',
          description: '任何人都可以阅读保管日记的代码。',
        },
        password: {
          label: '打开日记前必须输入密码',
          description: '这不是可以关闭的设置。没有密码，文件就始终处于加密状态。',
        },
        'your-key-only': {
          label: '只由你的密码掌控',
          description:
            '四款应用都会加密。但只有 Memlore 不需要账户、没有厂商服务器，也没有任何能绕回你日记的恢复途径。',
        },
        'local-first': {
          label: '本地优先 — 没有厂商日记服务器',
          description: '日记保存在你的电脑上，断网也能使用。',
        },
        'own-cloud': {
          label: '通过你已有的云盘文件夹同步',
          description:
            'Memlore 使用你的 Google Drive 或 iCloud Drive。Journey 也支持 Google Drive。',
        },
        'extra-locks': {
          label: '二级锁和隐形保险库',
          description: '有些日记保持锁定，有些则不留下任何存在的痕迹。',
        },
        'optional-ai': {
          label: '可选 AI 功能的丰富程度',
          description:
            '标题、摘要、Go Deeper、Continue & Rewrite、Daily Chat、Ask Journal、记忆、分身、回顾、洞察、语义搜索、情绪、时光机、图像 — 本地运行、设备端运行，或使用你自己的密钥。',
        },
        editor: {
          label: '不只能写文字的编辑器',
          description: 'Markdown、数学公式、代码块、斜杠命令，以及嵌入页面的媒体。',
        },
        appearance: {
          label: '打造属于你的外观',
          description:
            '三套设计系统，每套都可调整颜色、圆角、浅色或深色模式和表面风格 — 还能自选面板布局和写作字体。',
        },
        macos: { label: 'macOS 应用' },
        web: {
          label: '网页应用',
          description: '在任何浏览器中阅读和书写日记，依然端到端加密。',
        },
        ios: { label: 'iOS 应用' },
        android: { label: 'Android 应用' },
        windows: { label: 'Windows 应用' },
        linux: { label: 'Linux 应用' },
        'beta-free': { label: '测试期间所有现有功能免费' },
      },
    },
    platforms: {
      index: '平台',
      title: '支持多个平台',
      textWeb: '目前支持 macOS 和网页版。欢迎关注 Memlore 的成长。',
      textMac: '我们从 macOS 开始，花时间把体验打磨好。欢迎关注 Memlore 的成长。',
      web: '网页版',
      download: '下载',
      open: '打开',
      comingSoon: '即将推出',
      downloadAria: '从 GitHub 下载测试版',
      openAria: '打开网页应用',
    },
    footer: {
      titleLead: '平凡的日子，',
      titleTail: '也值得珍藏。',
    },
    hero: {
      mascotFollowAlt: 'Memlore 的小狗吉祥物，它的头会跟着你的光标转动。',
      mascotAlt: 'Memlore 的小狗吉祥物。',
      portraitLead: '一个可以停靠的地方。',
      portraitTail: '即使在平凡的日子里。',
      openSource: '开源',
      free: '免费',
      titleLead: '一段小小的人生。',
      titleTail: '一个长久的故事。',
      descriptionLead: 'Memlore 是一本私人日记。',
      descriptionTail: '留给你想记住的日子，也留给那些需要安放的思绪。',
      meta: '无需账户 · 在你的设备上加密',
      metaWeb: '目前支持 macOS 和网页版',
      metaMac: '目前支持 macOS',
    },
    spec: {
      label: 'Memlore 是什么',
      readSource: '阅读源代码',
      syncValue: '你的云盘',
      syncNote: 'Google Drive 或 iCloud Drive。',
      sizeNote: '安装后',
      aiValue: '可选',
      aiNote: '本地运行、设备端运行，或使用你自己的密钥。',
      pluginsValue: '即将推出',
      pluginsNote: '只安装你需要的。',
      terms: {
        license: '许可证',
        version: '版本',
        sync: '同步',
        size: '大小',
        ai: 'AI',
        plugins: '插件',
      },
    },
    demo: {
      index: '演示',
      title: '亲自感受一下。',
      subtitle: '使用虚构数据的 Memlore 应用模型。',
      cue: '随意点点看，它和真正的应用一样好用。',
      chooseAppearance: '选择外观',
      openSeparately: '单独打开',
      frameTitle: '包含虚构日记的 Memlore 交互式演示',
      posterAlt: 'Memlore 日记的模糊预览，打开了一篇示例日记',
      start: '开始演示',
      loadingTitle: '正在打开你的示例日记…',
      loadingText: '有一些回忆需要慢慢展开。',
      slowTitle: '演示加载得有点慢。',
      slowText: '请重新加载，或在新标签页中打开演示。',
      tryAgain: '重试',
      openDemo: '打开演示',
      disclaimer: '示例数据。书写、锁定、同步和 AI 均为模拟。',
      placeholderTitle: '此预览需要更宽的窗口。',
      placeholderText:
        '真正的日记是一款桌面应用，无法在这里运行。等 iOS 和 Android 应用推出后，这里将显示它们的界面。',
    },
    encrypt: {
      index: '功能',
      title: '没有服务器。没有后门。我们无法读取。',
      text: '所有内容都在你的设备上用你的密码加密 — 包括同步到你自己云盘的内容。中间没有 Memlore 服务器，没有密码就无法再次打开。',
      content: '你的内容',
      password: '你的密码',
      cloud: '你的云盘',
      noAccess: '无法访问',
      others: '其他人（包括我们）',
      unseen: '离开设备前即已加密',
    },
    sync: {
      title: '你的云盘。你的账户。你的密钥。',
      text: '日记先在你的设备上加密，再通过你自己的 Google Drive 或 iCloud Drive 同步。我们从不保管你的文件、账户或密钥。',
      thisDevice: '本设备',
      encrypted: '用你的密码加密',
      ownCloud: '你自己的云盘',
      synced: '已同步',
      otherDevices: '你的其他设备',
      unseen: '中间没有 Memlore 服务器',
    },
    locks: {
      title: '你可以用 3 种方式锁定日记。',
      items: {
        app: {
          title: '应用锁',
          text: '只有输入密码或使用 Touch ID 才能打开日记。这把锁是必需的，用于防止未经授权的访问。',
        },
        second: {
          title: '二级锁',
          text: '想让某些日记保持私密，可以再加一把二级锁。能进入应用的其他人会知道存在私密日记，但无法打开。',
        },
        invisible: {
          title: '隐形保险库',
          text: '如果你需要某些日记完全隐形、完全私密，即使能解锁应用的人也不会知道这些日记的存在。',
        },
      },
    },
    editor: {
      title: '功能丰富的编辑器',
      text: '编辑器全面支持 Markdown、数学公式、代码、媒体、@ 提及和可选插件。即使内容很长，也能快速响应。',
      panes: {
        text: '文字',
        math: '数学公式',
        code: '代码',
        media: '媒体',
        slash: '斜杠命令',
        mention: '提及',
        markdown: 'Markdown',
        plugins: '更多插件',
        request: '还需要更多？',
      },
    },
    emotions: {
      title: '情绪追踪',
      text: '你的心情可以被长期记录和分析。',
      prompt: '你感觉怎么样？',
      options: { bad: '不太好', neutral: '一般', good: '很好' },
    },
    locations: {
      title: '地图上的日记',
      text: '日记和照片会出现在它们发生的地方。点开一个图钉，就能回到那一页。',
    },
    transfer: {
      title: '导入和导出',
      text: '你可以把其他平台的日记（包括媒体）导入 Memlore，也可以反向导出，确保迁移顺畅无缝。',
      formats: { backup: '备份', markdown: 'Markdown', plainText: '纯文本' },
    },
    looks: {
      title: '打造属于你的外观。',
      textLead: 'Signature、Clean 和 Clay — 在上方的',
      demoLink: '演示',
      textTail: '中试试看，然后继续探索。',
      cards: {
        clay: { title: '星期二', line: '安静的早晨' },
        signature: { title: '星期一', line: '入夜之后' },
        clean: { title: '笔记', line: '简洁清晰' },
        lumen: { title: '夜晚', line: 'Foundry 深色' },
        'clay-dark': { title: '傍晚', line: '温暖的纸张' },
      },
      editorCard: {
        title: '一个长久的故事。',
        line: '你书写时用的字体。',
        font: 'Google 字体 · 对比度',
      },
      items: {
        skins: {
          title: '三套设计系统',
          text: 'Signature、Clean 和 Clay。可以在上方演示中实时切换。',
        },
        knobs: {
          title: '再来调细节',
          text: '强调色、圆角大小、浅色或深色模式，以及深色表面 — Deep、Soft 或 Lumen。',
        },
        layout: {
          title: '面板布局',
          text: '侧边栏和列表可以放在左边、右边，或让页面居中。',
        },
        type: {
          title: '字体',
          text: '应用字体跟随皮肤变化。编辑器有自己的字体 — 内置字体或自定义 Google 字体，还可调整字号和对比度。',
        },
      },
    },
    talk: {
      title: '先聊一聊，再把这一页留下。',
      text: '关于这一天的对话，保存后就能变成一篇日记。在你主动开启之前保持关闭。',
      items: {
        daily: {
          title: 'Daily Chat',
          text: '在 Memlore 里输入。准备好后，把对话保存为一篇日记。',
        },
        voice: { title: '语音模式', text: '用说的代替打字，讲述你的一天。' },
        mcp: {
          title: 'MCP',
          text: '在 ChatGPT、Claude、Gemini、Ollama 或你已经在用的其他 AI 中聊天。',
        },
      },
      figure: {
        daily: 'Daily Chat',
        you1: '散步很有帮助。',
        ai1: '什么让你印象最深？',
        you2: '街道是那么安静。',
        ai2: '我会把它留在这一页。',
        voice: '语音',
        more: '更多',
        search: '搜索日记',
        read: '阅读一页',
        append: '追加到今天',
        into: '然后保存为一篇日记',
      },
    },
    persona: {
      title: '打造另一个你。',
      text: 'Memlore 会根据你的写作风格、你的记忆以及你对自己的描述，打造一个像你一样写作的分身 — 用你的语气续写一页，或者坐下来和它聊聊。在你主动开启之前保持关闭。',
      items: {
        style: { title: '你的写作风格', text: '从你已经写下的页面中提取。' },
        memories: {
          title: '你的记忆',
          text: 'Memlore 了解到的人物、地点和事实。',
        },
        words: {
          title: '你自己的话',
          text: '几个问题的回答，关于你希望听起来怎样 — 以及你是谁。',
        },
      },
    },
    plugins: {
      title: '插件，只在你需要时出现。',
      soon: '即将推出',
      text: '额外的工具以插件形式提供。需要时安装一个，其余的不必理会。',
    },
    ai: {
      index: 'AI',
      title: '丰富的 AI 功能',
      text: 'AI 工具只有在你主动开启后才会启用。Memlore 支持 100% 本地运行的 AI，也支持使用你自己密钥的托管服务商。',
      items: {
        titles: {
          title: '智能标题',
          text: '根据你刚写完的日记，给出一个简短的标题建议。',
        },
        summaries: {
          title: '亮点和摘要',
          text: '可折叠的主题、情绪和瞬间回顾，随日记一起保存。',
        },
        deeper: {
          title: 'Go Deeper',
          text: '三个延伸反思的提示，以卡片形式插入编辑器下方。',
        },
        continue: {
          title: 'Continue & Rewrite',
          text: '从页脚续写日记，或改写选中的内容 — 用你的语气。',
        },
        chat: {
          title: 'Daily Chat',
          text: '关于这一天的对话，保存后就能变成一篇日记。',
        },
        ask: {
          title: 'Ask Journal',
          text: '你可以询问 Memlore 了解到的记忆和日记。',
        },
        memories: {
          title: '记忆和分身',
          text: '根据你的日记和你提供的信息，Memlore 可以打造另一个你，用你的语气和风格写作。',
        },
        reviews: {
          title: '回顾和洞察',
          text: '你可以用 AI 获取某段时间内写作内容的统计数据。',
        },
        search: {
          title: '语义搜索',
          text: '不只是关键词搜索，而是基于含义的搜索，可以用自然语言自由表达。',
        },
        emotion: {
          title: '情绪建议',
          text: '如果你开启了情绪追踪功能，AI 可以根据你写下的日记推测你的情绪。',
        },
        time: {
          title: '时光机摘要',
          text: '把历年同一天的日记汇总成一份回顾。',
        },
        image: {
          title: '图像生成',
          text: '用 AI 为你的日记生成封面图和内嵌插图。',
        },
        coming: { title: '更多功能即将推出' },
        request: { title: '还需要更多？' },
        device: {
          title: '设备端方案',
          text: 'Memlore 内置本地 AI，确保你的数据始终 100% 私密，永远不会离开你的设备。',
        },
      },
    },
  },
}

export default zhHans

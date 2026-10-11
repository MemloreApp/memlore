/** Traditional Chinese (Taiwan) website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const zhHant: Messages = {
  meta: {
    homeTitle: 'Memlore — 小小人生，長久故事。',
    homeDescription:
      '珍藏回憶的私人日記。認識 Memlore：一款開放原始碼的 App，讓你書寫、沉澱思緒，找回真正重要的事物。',
  },
  socialImageAlt:
    'Memlore 私人日記："小小人生，長久故事。"旁邊是採用 Signature、Clean 與 Clay 主題的 App 畫面，以及低多邊形風格的黃金獵犬吉祥物。',
  chrome: {
    skipToContent: '跳至主要內容',
    homeAria: 'Memlore 首頁',
    mainNavAria: '主要導覽',
    navDemo: '試玩',
    navFeatures: '功能',
    navCompare: '比較',
    navChangelog: '更新紀錄',
    navDocs: '文件',
    downloadForMac: '下載 Mac 版',
    download: '下載',
    downloadAria: '從 GitHub 下載 Beta 版',
    closeMenu: '關閉選單',
    openMenu: '開啟選單',
    copyright: '© {year} Memlore. 保留所有權利。',
    footerNavAria: '關於、更新紀錄、文件、隱私權、服務條款、llms.txt 與 GitHub',
    footerAbout: '關於',
    footerChangelog: '更新紀錄',
    footerDocs: '文件',
    footerPrivacy: '隱私權',
    footerTerms: '服務條款',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: '法律資訊',
    eyebrowAbout: '關於',
    lastUpdated: '最後更新：{date}',
  },
  menu: {
    label: '語言',
  },
  notice: {
    onlyEnglish: '此頁面僅提供英文版本。',
    backHome: '前往繁體中文首頁',
  },
  landing: {
    actions: {
      download: '下載',
      downloadAria: '從 GitHub 下載 Beta 版',
      web: '網頁版（測試版）',
      demo: '試玩',
      watch: '觀看',
      watchAria: '觀看介紹影片',
    },
    intro: {
      title: '介紹',
      close: '關閉',
      frameTitle: 'Memlore — 小小人生，長久故事。',
    },
    openSource: {
      symbol: '公開打造。',
      title: '開放原始碼',
      text: '程式碼公開，讓你看清楚日記如何受到保護、你的資料如何被保存。Memlore 會一直免費，Beta 版只是為了維持專案運作而提供的額外功能。',
      github: '在 GitHub 上查看',
    },
    compare: {
      title: 'Memlore 與其他日記的比較。',
      text: '將 Memlore 與三款大家常用的日記 App 並列比較。',
      tableLabel: '日記比較表，每欄一款日記 App',
      compared: '比較項目',
      sourcesLead: '查看詳細資訊：',
      sourcesNote: '功能與方案可能有所變動。',
      levels: ['少數', '約一半', '大部分', '全部'],
      marks: {
        yes: '是',
        no: '否',
        soon: '即將推出',
        partial: '視情況而定或未說明',
      },
      rows: {
        'open-source': {
          label: '開放原始碼',
          description: '任何人都能閱讀存放日記的程式碼。',
        },
        password: {
          label: '開啟日記前必須輸入密碼',
          description: '這不是可以關閉的設定。沒有密碼，檔案就會維持加密。',
        },
        'your-key-only': {
          label: '只由你的密碼掌握',
          description:
            '四款都有加密。但只有 Memlore 不需要帳號、沒有廠商伺服器，也沒有任何能回到你日記的復原途徑。',
        },
        'local-first': {
          label: '本機優先 — 沒有廠商的日記伺服器',
          description: '日記存放在你的電腦上，離線也能使用。',
        },
        'own-cloud': {
          label: '透過你自己的雲端資料夾同步',
          description:
            'Memlore 使用你的 Google Drive 或 iCloud Drive。Journey 也支援 Google Drive。',
        },
        'extra-locks': {
          label: '第二道鎖與隱形保險庫',
          description: '有些日記保持上鎖，有些則完全不留存在的痕跡。',
        },
        'optional-ai': {
          label: '可選用的 AI 功能有多豐富',
          description:
            '標題、摘要、Go Deeper、Continue & Rewrite、Daily Chat、Ask Journal、記憶、人格、回顧、洞察、語意搜尋、情緒、時光機、圖像 — 本機、裝置端或使用你自己的金鑰。',
        },
        editor: {
          label: '不只能寫文字的編輯器',
          description: 'Markdown、數學式、程式碼區塊、斜線指令，以及頁面內的媒體。',
        },
        appearance: {
          label: '打造專屬於你的外觀',
          description:
            '三套設計系統，各有色彩、圓角、淺色或深色與表面設定 — 還能自訂面板配置與書寫字型。',
        },
        macos: { label: 'macOS App' },
        web: {
          label: '網頁版 App（測試版）',
          description: '在任何瀏覽器中閱讀與書寫日記，依然維持端對端加密。',
        },
        ios: { label: 'iOS App' },
        android: { label: 'Android App' },
        windows: { label: 'Windows App' },
        linux: { label: 'Linux App' },
        'beta-free': { label: 'Beta 期間所有現有功能皆免費' },
      },
    },
    platforms: {
      index: '平台',
      title: '支援多種平台',
      textWeb: '目前支援 macOS 與網頁版（測試版）。一起見證 Memlore 的成長。',
      textMac: '我們從 macOS 開始，花時間把體驗做到位。一起見證 Memlore 的成長。',
      web: '網頁版',
      download: '下載',
      open: '測試版',
      comingSoon: '即將推出',
      downloadAria: '從 GitHub 下載 Beta 版',
      openAria: '開啟網頁版 App',
    },
    footer: {
      titleLead: '平凡的日子，',
      titleTail: '也值得珍藏。',
    },
    hero: {
      mascotFollowAlt: 'Memlore 的狗狗吉祥物。牠的頭會跟著你的游標轉動。',
      mascotAlt: 'Memlore 的狗狗吉祥物。',
      portraitLead: '一個安放心情的地方。',
      portraitTail: '即使是平凡的日子。',
      openSource: '開放原始碼',
      free: '免費',
      titleLead: '小小人生，',
      titleTail: '長久故事。',
      descriptionLead: 'Memlore 是一本私人日記。',
      descriptionTail: '為了那些你想記住的日子，以及那些需要找個地方安放的想法。',
      meta: '無需帳號 · 在你的裝置上加密',
      metaWeb: '目前支援 macOS 與網頁版（測試版）',
      metaMac: '目前支援 macOS',
    },
    spec: {
      label: 'Memlore 是什麼',
      readSource: '閱讀原始碼',
      syncValue: '你的雲端',
      syncNote: 'Google Drive 或 iCloud Drive。',
      sizeNote: '安裝後',
      aiValue: '可選用',
      aiNote: '本機、裝置端或使用你自己的金鑰。',
      pluginsValue: '即將推出',
      pluginsNote: '只安裝你需要的。',
      terms: {
        license: '授權',
        version: '版本',
        sync: '同步',
        size: '大小',
        ai: 'AI',
        plugins: '外掛',
      },
    },
    demo: {
      index: '試玩',
      title: '親自感受一下。',
      subtitle: '使用虛構資料的 Memlore App 模型。',
      cue: '隨意點點看，操作就跟真正的 App 一樣。',
      chooseAppearance: '選擇外觀',
      openSeparately: '在新分頁開啟',
      frameTitle: '含虛構日記內容的 Memlore 互動試玩',
      posterAlt: 'Memlore 日記的模糊預覽，畫面中開啟了一篇範例日記',
      start: '開始試玩',
      loadingTitle: '正在開啟你的範例日記…',
      loadingText: '有些回憶正在慢慢展開。',
      slowTitle: '試玩載入得比較久。',
      slowText: '請再試一次載入，或在獨立分頁中開啟試玩。',
      tryAgain: '再試一次',
      openDemo: '開啟試玩',
      disclaimer: '範例資料。書寫、上鎖、同步與 AI 皆為模擬。',
      placeholderTitle: '此預覽需要更寬的視窗。',
      placeholderText:
        '實際的日記是桌面 App，因此無法在這裡執行。等 iOS 與 Android App 推出後，這裡將改為顯示它們的畫面。',
    },
    encrypt: {
      index: '功能',
      title: '沒有伺服器，沒有後門。我們也無法讀取。',
      text: '所有內容都會在你的裝置上用你的密碼加密 — 包括同步到你自己雲端的資料。中間沒有 Memlore 伺服器，沒有那組密碼也無法再進入。',
      content: '你的內容',
      password: '你的密碼',
      cloud: '你的雲端',
      noAccess: '無法存取',
      others: '其他人（包括我們）',
      unseen: '離開裝置前就已加密',
    },
    sync: {
      title: '你的雲端、你的帳號、你的金鑰。',
      text: '日記會先在你的裝置上加密，再透過你自己的 Google Drive 或 iCloud Drive 同步。我們從不持有你的檔案、帳號或金鑰。',
      thisDevice: '這台裝置',
      encrypted: '以你的密碼加密',
      ownCloud: '你自己的雲端',
      synced: '已同步',
      otherDevices: '你的其他裝置',
      unseen: '中間沒有 Memlore 伺服器',
    },
    locks: {
      title: '你可以用 3 種不同方式鎖住日記。',
      items: {
        app: {
          title: 'App 鎖',
          text: '日記只能用密碼或 Touch ID 開啟。這道鎖是必要的，可防止未經授權的存取。',
        },
        second: {
          title: '第二道鎖',
          text: '想讓某些日記保持私密，可以加上第二道鎖。能開啟 App 的其他人會知道有私密日記存在，但無法打開它們。',
        },
        invisible: {
          title: '隱形保險庫',
          text: '如果你需要某些日記完全隱形且私密，即使是能解鎖 App 的人，也不會知道這些日記的存在。',
        },
      },
    },
    editor: {
      title: '功能豐富的編輯器',
      text: '編輯器完整支援 Markdown、數學式、程式碼、媒體、@ 提及以及選用外掛。即使內容很長，依然反應迅速。',
      panes: {
        text: '文字',
        math: '數學式',
        code: '程式碼',
        media: '媒體',
        slash: '斜線指令',
        mention: '提及',
        markdown: 'Markdown',
        plugins: '更多外掛',
        request: '還需要更多？',
      },
    },
    emotions: {
      title: '情緒追蹤',
      text: '你的心情可以隨時間被記錄與分析。',
      prompt: '你現在感覺如何？',
      options: { bad: '不太好', neutral: '還好', good: '很好' },
    },
    locations: {
      title: '地圖上的日記',
      text: '日記與照片會標示在發生的地點。點開圖釘，就能回到那一頁。',
    },
    transfer: {
      title: '匯入與匯出',
      text: '你可以從其他平台將日記（包括媒體）匯入 Memlore，反之亦然，讓轉移過程順暢無縫。',
      formats: { backup: '備份', markdown: 'Markdown', plainText: '純文字' },
    },
    looks: {
      title: '打造專屬於你的外觀。',
      textLead: 'Signature、Clean 與 Clay — 先在上方的',
      demoLink: '試玩',
      textTail: '中試試看，然後繼續調整。',
      cards: {
        clay: { title: '星期二', line: '安靜的早晨' },
        signature: { title: '星期一', line: '入夜之後' },
        clean: { title: '筆記', line: '簡潔清晰' },
        lumen: { title: '夜晚', line: 'Foundry 深色' },
        'clay-dark': { title: '傍晚', line: '溫暖紙感' },
      },
      editorCard: {
        title: '長久故事。',
        line: '你書寫時用的字型。',
        font: 'Google Font · 對比',
      },
      items: {
        skins: {
          title: '三套設計系統',
          text: 'Signature、Clean 與 Clay。可在上方試玩中即時切換。',
        },
        knobs: {
          title: '再來是細節調整',
          text: '強調色、圓角半徑、淺色或深色，以及深色表面 — Deep、Soft 或 Lumen。',
        },
        layout: {
          title: '面板配置',
          text: '側邊欄與列表可放在左側、右側，或讓頁面置於中間。',
        },
        type: {
          title: '字型',
          text: 'App 的字型會跟隨主題。編輯器有自己的字型 — 內建字體或自訂 Google Font，還能調整大小與對比。',
        },
      },
    },
    talk: {
      title: '把話說出來，再把那一頁留下。',
      text: '關於今天的一段對話，儲存後就能成為一篇日記。在你選擇啟用前都保持關閉。',
      items: {
        daily: {
          title: 'Daily Chat',
          text: '直接在 Memlore 裡打字。準備好後，就把這段對話儲存為一篇日記。',
        },
        voice: { title: '語音模式', text: '用說的記錄今天，不必打字。' },
        mcp: {
          title: 'MCP',
          text: '在 ChatGPT、Claude、Gemini、Ollama 或你已在使用的其他 AI 中聊天。',
        },
      },
      figure: {
        daily: 'Daily Chat',
        you1: '散步很有幫助。',
        ai1: '有什麼讓你印象深刻？',
        you2: '街道好安靜。',
        ai2: '我會把這段留在頁面上。',
        voice: '語音',
        more: '更多',
        search: '搜尋日記',
        read: '閱讀一頁',
        append: '加到今天',
        into: '然後儲存為一篇日記',
      },
    },
    persona: {
      title: '打造第二個你。',
      text: 'Memlore 會根據你的寫作風格、你的回憶，以及你對自己的描述，建立一個像你一樣書寫的人格 — 用你的語氣接續一頁，或坐下來和它聊聊。在你選擇啟用前都保持關閉。',
      items: {
        style: { title: '你的寫作風格', text: '取樣自你已經寫下的頁面。' },
        memories: {
          title: '你的回憶',
          text: 'Memlore 認識的人物、地點與事實。',
        },
        words: {
          title: '你自己的話',
          text: '幾個問題的回答：你希望聽起來如何，以及你是誰。',
        },
      },
    },
    plugins: {
      title: '外掛，只在你需要時出現。',
      soon: '即將推出',
      text: '額外的工具以外掛形式提供。需要時再安裝，其餘的可以不裝。',
    },
    ai: {
      index: 'AI',
      title: '豐富的 AI 功能',
      text: 'AI 工具只有在你選擇啟用時才會開啟。Memlore 支援 100% 本機 AI，也支援使用你自己金鑰的雲端服務供應商。',
      items: {
        titles: {
          title: '智慧標題',
          text: '根據你剛寫好的日記，建議一個簡短的標題。',
        },
        summaries: {
          title: '重點與摘要',
          text: '可收合的主題、情緒與重要時刻回顧，隨日記一起儲存。',
        },
        deeper: {
          title: 'Go Deeper',
          text: '三個延伸反思提示，以卡片形式插入在編輯器下方。',
        },
        continue: {
          title: 'Continue & Rewrite',
          text: '從頁尾接續寫下日記，或改寫選取的段落 — 用你的語氣。',
        },
        chat: {
          title: 'Daily Chat',
          text: '關於今天的一段對話，儲存後就能成為一篇日記。',
        },
        ask: {
          title: 'Ask Journal',
          text: '你可以詢問 Memlore 已學到的回憶與日記內容。',
        },
        memories: {
          title: '記憶與人格',
          text: '根據你的日記與你提供的資訊，Memlore 可以打造第二個你，用你的語氣與風格書寫。',
        },
        reviews: {
          title: '回顧與洞察',
          text: '你可以用 AI 取得某段時間內書寫內容的統計資料。',
        },
        search: {
          title: '語意搜尋',
          text: '不只是關鍵字搜尋，而是以意義為基礎、可用自然語言自由表達的搜尋。',
        },
        emotion: {
          title: '情緒建議',
          text: '如果你啟用了情緒追蹤功能，AI 可以根據你寫下的日記建議你當下的情緒。',
        },
        time: {
          title: '時光機摘要',
          text: '把歷年同一天的內容，整合成一份回顧。',
        },
        image: {
          title: '圖像生成',
          text: '使用 AI 為你的日記產生封面圖片與內文插圖。',
        },
        coming: { title: '更多功能即將推出' },
        request: { title: '還需要更多？' },
        device: {
          title: '裝置端處理',
          text: 'Memlore 內建本機 AI，確保你的資料永遠 100% 私密，絕不離開你的裝置。',
        },
      },
    },
  },
}

export default zhHant

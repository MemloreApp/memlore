/** Japanese website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const ja: Messages = {
  meta: {
    homeTitle: 'Memlore — ささやかな日々を、ずっと残る物語に。',
    homeDescription:
      '思い出のためのプライベートな日記。Memlore は、書いて、振り返り、大切なことへ立ち返るためのオープンソースアプリです。',
  },
  socialImageAlt:
    'プライベートな日記 Memlore："ささやかな日々を、ずっと残る物語に。" の文字と、Signature・Clean・Clay テーマのアプリ画面、ローポリのゴールデンレトリバーのマスコット。',
  chrome: {
    skipToContent: 'コンテンツへスキップ',
    homeAria: 'Memlore ホーム',
    mainNavAria: 'メインナビゲーション',
    navDemo: 'デモ',
    navFeatures: '機能',
    navCompare: '比較',
    navChangelog: '更新履歴',
    navDocs: 'ドキュメント',
    downloadForMac: 'Mac 版をダウンロード',
    download: 'ダウンロード',
    downloadAria: 'GitHub からベータ版をダウンロード',
    closeMenu: 'メニューを閉じる',
    openMenu: 'メニューを開く',
    copyright: '© {year} Memlore. All rights reserved.',
    footerNavAria: '概要、更新履歴、ドキュメント、プライバシー、利用規約、llms.txt、GitHub',
    footerAbout: '概要',
    footerChangelog: '更新履歴',
    footerDocs: 'ドキュメント',
    footerPrivacy: 'プライバシー',
    footerTerms: '利用規約',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: '法的情報',
    eyebrowAbout: '概要',
    lastUpdated: '最終更新日：{date}',
  },
  menu: {
    label: '言語',
  },
  notice: {
    onlyEnglish: 'このページは英語でのみご覧いただけます。',
    backHome: '日本語のホームへ',
  },
  landing: {
    actions: {
      download: 'ダウンロード',
      downloadAria: 'GitHub からベータ版をダウンロード',
      web: 'Web（ベータ）',
      demo: 'デモ',
      watch: '動画を見る',
      watchAria: '紹介動画を見る',
    },
    intro: {
      title: '紹介',
      close: '閉じる',
      frameTitle: 'Memlore — ささやかな日々を、ずっと残る物語に。',
    },
    openSource: {
      symbol: 'オープンに開発。',
      title: 'オープンソース',
      text: '日記がどう守られ、データがどう扱われているかを、誰でも確かめられるようにオープンにしています。Memlore はずっと無料です。ベータは、プロジェクトを続けるための追加機能のためだけのものです。',
      github: 'GitHub で見る',
    },
    compare: {
      title: 'Memlore と他の日記アプリの比較。',
      text: 'すでに多くの人が使っている 3 つの日記アプリと Memlore を並べました。',
      tableLabel: '日記アプリの比較表（アプリごとに 1 列）',
      compared: '比較対象',
      sourcesLead: '詳しくはこちら：',
      sourcesNote: '機能やプランは変更される場合があります。',
      levels: ['少し', '半分ほど', 'ほとんど', 'すべて'],
      marks: {
        yes: 'あり',
        no: 'なし',
        soon: '近日対応',
        partial: '場合による、または記載なし',
      },
      rows: {
        'open-source': {
          label: 'オープンソース',
          description: '日記を扱うコードを誰でも読めます。',
        },
        password: {
          label: '日記を開く前にパスワードが必須',
          description:
            'オフにできる設定ではありません。パスワードがなければファイルは封じられたままです。',
        },
        'your-key-only': {
          label: 'あなたのパスワードだけが鍵',
          description:
            '4 つとも暗号化はしています。ただし、アカウント不要で、運営者のサーバーを持たず、日記に入り込む復旧手段も持たないのは Memlore だけです。',
        },
        'local-first': {
          label: 'ローカルファースト — 運営者の日記サーバーなし',
          description: '日記はあなたのマシンの中にあり、ネットワークがオフでも使えます。',
        },
        'own-cloud': {
          label: 'すでにお持ちのクラウドフォルダで同期',
          description:
            'Memlore はあなたの Google Drive または iCloud Drive を使います。Journey も Google Drive に対応しています。',
        },
        'extra-locks': {
          label: '第二のロックと見えない金庫',
          description:
            '閉じたままにできるエントリーも、存在の痕跡さえ残さないエントリーもあります。',
        },
        'optional-ai': {
          label: 'オプションの AI がどこまで使えるか',
          description:
            'タイトル、要約、Go Deeper、Continue & Rewrite、Daily Chat、Ask Journal、メモリー、ペルソナ、レビュー、インサイト、セマンティック検索、感情、タイムマシン、画像 — ローカル、オンデバイス、またはご自身の API キーで。',
        },
        editor: {
          label: 'テキスト以上を扱えるエディター',
          description: 'Markdown、数式、コードブロック、スラッシュコマンド、ページ内のメディア。',
        },
        appearance: {
          label: '自分好みの見た目に',
          description:
            '3 つのデザインシステムそれぞれで、色、角の丸み、ライトかダーク、サーフェスを選べます。さらにパネルレイアウトと、執筆用のフォントも。',
        },
        macos: { label: 'macOS アプリ' },
        web: {
          label: 'Web アプリ（ベータ）',
          description:
            'どのブラウザからでも日記を読み書きでき、エンドツーエンド暗号化もそのままです。',
        },
        ios: { label: 'iOS アプリ' },
        android: { label: 'Android アプリ' },
        windows: { label: 'Windows アプリ' },
        linux: { label: 'Linux アプリ' },
        'beta-free': { label: 'ベータ期間中は現在の全機能が無料' },
      },
    },
    platforms: {
      index: 'プラットフォーム',
      title: '複数のプラットフォームに対応',
      textWeb: '現在は macOS と Web（ベータ）に対応。Memlore の成長を見守ってください。',
      textMac:
        'まずは macOS から、じっくり時間をかけて心地よく仕上げています。Memlore の成長を見守ってください。',
      web: 'Web',
      download: 'ダウンロード',
      open: 'ベータ',
      comingSoon: '近日公開',
      downloadAria: 'GitHub からベータ版をダウンロード',
      openAria: 'Web アプリを開く',
    },
    footer: {
      titleLead: 'なんでもない日こそ、',
      titleTail: '残しておく価値がある。',
    },
    hero: {
      mascotFollowAlt: 'Memlore の犬のマスコット。頭がカーソルを追いかけます。',
      mascotAlt: 'Memlore の犬のマスコット。',
      portraitLead: '帰ってこられる場所。',
      portraitTail: 'なんでもない日にも。',
      openSource: 'オープンソース',
      free: '無料',
      titleLead: 'ささやかな日々を、',
      titleTail: 'ずっと残る物語に。',
      descriptionLead: 'Memlore はプライベートな日記です。',
      descriptionTail: '覚えておきたい日のために。どこかに置いておきたい想いのために。',
      meta: 'アカウント不要 · デバイス上で暗号化',
      metaWeb: '現在は macOS と Web（ベータ）に対応',
      metaMac: '現在は macOS に対応',
    },
    spec: {
      label: 'Memlore とは',
      readSource: 'ソースコードを読む',
      syncValue: 'あなたのクラウド',
      syncNote: 'Google Drive または iCloud Drive。',
      sizeNote: 'インストール後',
      aiValue: 'オプション',
      aiNote: 'ローカル、オンデバイス、またはご自身の API キー。',
      pluginsValue: '近日公開',
      pluginsNote: '必要なものだけをインストール。',
      terms: {
        license: 'ライセンス',
        version: 'バージョン',
        sync: '同期',
        size: 'サイズ',
        ai: 'AI',
        plugins: 'プラグイン',
      },
    },
    demo: {
      index: 'デモ',
      title: '実際に触ってみてください。',
      subtitle: '架空のデータを使った Memlore アプリのモックアップです。',
      cue: '自由にクリックしてみてください。本物のアプリと同じように動きます。',
      chooseAppearance: '外観を選ぶ',
      openSeparately: '別ウィンドウで開く',
      frameTitle: '架空の日記エントリーを使ったインタラクティブな Memlore デモ',
      posterAlt: 'サンプルのエントリーを開いた Memlore 日記のぼかしプレビュー',
      start: 'デモを始める',
      loadingTitle: 'サンプルの日記を開いています…',
      loadingText: '思い出をいくつか取り出しています。',
      slowTitle: 'デモの読み込みに少し時間がかかっています。',
      slowText: 'もう一度読み込むか、デモを別のタブで開いてください。',
      tryAgain: '再試行',
      openDemo: 'デモを開く',
      disclaimer: 'サンプルデータです。執筆、ロック、同期、AI はシミュレーションです。',
      placeholderTitle: 'このプレビューには、もっと広いウィンドウが必要です。',
      placeholderText:
        '実際の日記はデスクトップアプリのため、ここでは動作しません。iOS 版と Android 版が登場したら、その画面がここに表示されます。',
    },
    encrypt: {
      index: '機能',
      title: 'サーバーなし。バックドアなし。私たちにも読めません。',
      text: 'すべてはあなたのデバイス上で、あなたのパスワードによって暗号化されます。あなた自身のクラウドに同期されるデータも同じです。間に Memlore のサーバーはなく、パスワードなしで中に入る方法もありません。',
      content: 'あなたのコンテンツ',
      password: 'あなたのパスワード',
      cloud: 'あなたのクラウド',
      noAccess: 'アクセス不可',
      others: '他の人（私たちも）',
      unseen: 'デバイスを離れる前に暗号化',
    },
    sync: {
      title: 'あなたのクラウド。あなたのアカウント。あなたの鍵。',
      text: 'エントリーはデバイス上で暗号化され、あなた自身の Google Drive または iCloud Drive を通じて同期されます。私たちがあなたのファイル、アカウント、鍵を預かることはありません。',
      thisDevice: 'このデバイス',
      encrypted: 'あなたのパスワードで暗号化',
      ownCloud: 'あなた自身のクラウド',
      synced: '同期済み',
      otherDevices: 'あなたの他のデバイス',
      unseen: '間に Memlore のサーバーはありません',
    },
    locks: {
      title: 'エントリーは 3 つの方法でロックできます。',
      items: {
        app: {
          title: 'アプリロック',
          text: '日記はパスワードか Touch ID でのみ開きます。このロックは必須で、不正なアクセスから日記を守ります。',
        },
        second: {
          title: '第二のロック',
          text: '一部のエントリーを非公開にしたいときは、第二のロックを追加できます。アプリにアクセスできる人も、非公開のエントリーがあることはわかりますが、開くことはできません。',
        },
        invisible: {
          title: '見えない金庫',
          text: 'アプリのロックを解除できる人からも、エントリーを完全に見えない状態で非公開にしたいときに。そうしたエントリーがあることさえ気づかれません。',
        },
      },
    },
    editor: {
      title: '機能豊富なエディター',
      text: 'エディターは Markdown、数式、コード、メディア、@メンション、オプションのプラグインに完全対応。とても長い文章でも素早く反応します。',
      panes: {
        text: '文章',
        math: '数式',
        code: 'コード',
        media: 'メディア',
        slash: 'スラッシュコマンド',
        mention: 'メンション',
        markdown: 'Markdown',
        plugins: 'その他のプラグイン',
        request: 'もっと必要ですか？',
      },
    },
    emotions: {
      title: '感情の記録',
      text: '気分を記録し、時間の流れに沿って分析できます。',
      prompt: '今の気分は？',
      options: { bad: 'よくない', neutral: 'まあまあ', good: 'よい' },
    },
    locations: {
      title: '地図の上のエントリー',
      text: 'エントリーや写真は、それが起きた場所に置かれます。ピンを開けば、そのページに戻れます。',
    },
    transfer: {
      title: 'インポートとエクスポート',
      text: '他のサービスから Memlore へ、メディアも含めてエントリーをインポートでき、その逆も可能です。移行はスムーズに行えます。',
      formats: { backup: 'バックアップ', markdown: 'Markdown', plainText: 'プレーンテキスト' },
    },
    looks: {
      title: '自分好みの見た目に。',
      textLead: 'Signature、Clean、Clay — 上の',
      demoLink: 'デモ',
      textTail: 'で試してみてください。その先も、まだまだ。',
      cards: {
        clay: { title: '火曜日', line: '静かな朝' },
        signature: { title: '月曜日', line: '日が暮れてから' },
        clean: { title: 'メモ', line: 'シンプルで明快' },
        lumen: { title: '夜', line: 'Foundry のダーク' },
        'clay-dark': { title: '夕暮れ', line: 'あたたかな紙' },
      },
      editorCard: {
        title: 'ずっと残る物語。',
        line: 'あなたが書くための書体。',
        font: 'Google Font · コントラスト',
      },
      items: {
        skins: {
          title: '3 つのデザインシステム',
          text: 'Signature、Clean、Clay。上のデモでその場で切り替えられます。',
        },
        knobs: {
          title: 'さらに細かな調整',
          text: 'アクセントカラー、角の丸み、ライトかダーク、そしてダークのサーフェス — Deep、Soft、Lumen。',
        },
        layout: {
          title: 'パネルレイアウト',
          text: 'サイドバーとリストを左に、右に、あるいはページを中央に。',
        },
        type: {
          title: '書体',
          text: 'アプリの書体はスキンに合わせて変わります。エディターには専用のフォントがあり、内蔵の書体かカスタムの Google Font を選べるほか、サイズとコントラストも調整できます。',
        },
      },
    },
    talk: {
      title: '話しながら整理して、ページに残す。',
      text: 'その日についての会話は、保存すれば日記のエントリーになります。オプトインするまでオフのままです。',
      items: {
        daily: {
          title: 'Daily Chat',
          text: 'Memlore の中で入力し、準備ができたらスレッドをエントリーとして保存できます。',
        },
        voice: { title: '音声モード', text: '入力する代わりに、その日のことを話してください。' },
        mcp: {
          title: 'MCP',
          text: 'ChatGPT、Claude、Gemini、Ollama など、普段使っている AI でチャットできます。',
        },
      },
      figure: {
        daily: 'Daily Chat',
        you1: '散歩して気分が楽になった。',
        ai1: '何が心に残りましたか？',
        you2: '通りがとても静かだったこと。',
        ai2: 'それをページに残しておきますね。',
        voice: '音声',
        more: 'その他',
        search: 'エントリーを検索',
        read: 'ページを読む',
        append: '今日に追記',
        into: 'そしてエントリーとして保存',
      },
    },
    persona: {
      title: 'もう一人のあなたを。',
      text: 'あなたの文体、思い出、そしてあなた自身についての言葉から、Memlore はあなたのように書くペルソナを作ります。あなたの声でページを書き継いだり、腰を据えて語り合ったり。オプトインするまでオフのままです。',
      items: {
        style: { title: 'あなたの文体', text: 'すでに書いてきたページから学びます。' },
        memories: {
          title: 'あなたの思い出',
          text: 'Memlore が覚えた人、場所、事実。',
        },
        words: {
          title: 'あなた自身の言葉',
          text: 'どんなふうに書きたいか、そしてあなたが誰なのかについての、いくつかの答え。',
        },
      },
    },
    plugins: {
      title: 'プラグインは、必要なときだけ。',
      soon: '近日公開',
      text: '追加のツールはプラグインとして提供されます。必要なものだけをインストールし、それ以外は入れなくてかまいません。',
    },
    ai: {
      index: 'AI',
      title: '充実した AI 機能',
      text: 'AI ツールは、オプトインした場合にのみ有効になります。Memlore は 100% ローカルの AI に加え、ご自身の API キーを使ったホスト型プロバイダーにも対応しています。',
      items: {
        titles: {
          title: 'スマートタイトル',
          text: '書いたばかりのエントリーから、短いタイトルを提案します。',
        },
        summaries: {
          title: 'ハイライトと要約',
          text: 'テーマ、感情、印象的な瞬間を折りたたみ式でまとめ、エントリーと一緒に保存します。',
        },
        deeper: {
          title: 'Go Deeper',
          text: '振り返りを深める 3 つの問いかけを、エディターの下にカードとして挿入します。',
        },
        continue: {
          title: 'Continue & Rewrite',
          text: 'フッターからエントリーの続きを書いたり、選択した部分を書き直したり — あなたの声で。',
        },
        chat: {
          title: 'Daily Chat',
          text: 'その日についての会話を、保存すれば日記のエントリーにできます。',
        },
        ask: {
          title: 'Ask Journal',
          text: 'Memlore が学んだ思い出やエントリーについて質問できます。',
        },
        memories: {
          title: 'メモリーとペルソナ',
          text: 'エントリーとあなたが提供した情報をもとに、Memlore はあなたの声と文体で書くもう一人のあなたを作れます。',
        },
        reviews: {
          title: 'レビューとインサイト',
          text: 'AI を使って、特定の期間に書いた内容の統計を得られます。',
        },
        search: {
          title: 'セマンティック検索',
          text: 'キーワード検索だけでなく、自然な言葉で自由に表現できる、意味にもとづく検索です。',
        },
        emotion: {
          title: '感情の提案',
          text: '感情の記録機能を有効にすると、書いたエントリーをもとに、AI があなたの感じている感情を提案します。',
        },
        time: {
          title: 'タイムマシン要約',
          text: '年をまたいだ同じ日付を、ひとつのまとめに。',
        },
        image: {
          title: '画像生成',
          text: 'AI を使って、エントリーのカバー画像や本文中のイラストを生成します。',
        },
        coming: { title: 'さらに追加予定' },
        request: { title: 'もっと必要ですか？' },
        device: {
          title: 'オンデバイスでの処理',
          text: 'Memlore にはローカル AI が組み込まれており、データは常に 100% プライベートで、デバイスの外に出ることはありません。',
        },
      },
    },
  },
}

export default ja

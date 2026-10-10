/** Vietnamese website strings, translated from `en.ts`. */
import type { Messages } from './en.ts'

const vi: Messages = {
  meta: {
    homeTitle: 'Memlore — Một cuộc đời nhỏ. Một câu chuyện còn mãi.',
    homeDescription:
      'Cuốn nhật ký riêng tư cho những kỷ niệm của bạn. Khám phá Memlore, ứng dụng mã nguồn mở để viết, suy ngẫm và tìm lại những điều quan trọng.',
  },
  socialImageAlt:
    'Memlore, cuốn nhật ký riêng tư: "Một cuộc đời nhỏ. Một câu chuyện còn mãi." bên cạnh ứng dụng với các giao diện Signature, Clean và Clay, cùng linh vật chú chó golden retriever low-poly.',
  chrome: {
    skipToContent: 'Chuyển đến nội dung',
    homeAria: 'Trang chủ Memlore',
    mainNavAria: 'Điều hướng chính',
    navDemo: 'Demo',
    navFeatures: 'Tính năng',
    navCompare: 'So sánh',
    navChangelog: 'Nhật ký thay đổi',
    navDocs: 'Tài liệu',
    downloadForMac: 'Tải cho Mac',
    download: 'Tải về',
    downloadAria: 'Tải bản beta từ GitHub',
    closeMenu: 'Đóng menu',
    openMenu: 'Mở menu',
    copyright: '© {year} Memlore. Bảo lưu mọi quyền.',
    footerNavAria: 'Giới thiệu, nhật ký thay đổi, tài liệu, quyền riêng tư, điều khoản và GitHub',
    footerAbout: 'Giới thiệu',
    footerChangelog: 'Nhật ký thay đổi',
    footerDocs: 'Tài liệu',
    footerPrivacy: 'Quyền riêng tư',
    footerTerms: 'Điều khoản',
    footerGitHub: 'GitHub',
  },
  legal: {
    eyebrowLegal: 'Pháp lý',
    eyebrowAbout: 'Giới thiệu',
    lastUpdated: 'Cập nhật lần cuối {date}',
  },
  menu: {
    label: 'Ngôn ngữ',
  },
  notice: {
    onlyEnglish: 'Trang này chỉ có bằng tiếng Anh.',
    backHome: 'Về trang chủ tiếng Việt',
  },
  landing: {
    actions: {
      download: 'Tải về',
      downloadAria: 'Tải bản beta từ GitHub',
      web: 'Web',
      demo: 'Demo',
      watch: 'Xem',
      watchAria: 'Xem video giới thiệu',
    },
    intro: {
      title: 'Giới thiệu',
      close: 'Đóng',
      frameTitle: 'Memlore — Một cuộc đời nhỏ. Một câu chuyện còn mãi.',
    },
    openSource: {
      symbol: 'Làm ra một cách công khai.',
      title: 'Mã nguồn mở',
      text: 'Mở để bạn thấy cuốn nhật ký được bảo mật ra sao và dữ liệu của bạn được giữ thế nào. Memlore luôn miễn phí. Bản beta chỉ dành cho những phần bổ sung giúp dự án tiếp tục.',
      github: 'Xem trên GitHub',
    },
    compare: {
      title: 'Memlore so với các ứng dụng khác.',
      text: 'Memlore đặt cạnh ba ứng dụng nhật ký mà mọi người đang dùng.',
      tableLabel: 'Bảng so sánh các ứng dụng nhật ký, mỗi cột một ứng dụng',
      compared: 'So sánh',
      sourcesLead: 'Xem chi tiết:',
      sourcesNote: 'Tính năng và gói dịch vụ có thể thay đổi.',
      levels: ['Một vài', 'Khoảng một nửa', 'Phần lớn', 'Đầy đủ'],
      marks: {
        yes: 'Có',
        no: 'Không',
        soon: 'Sắp có',
        partial: 'Tùy trường hợp hoặc không có tài liệu',
      },
      rows: {
        'open-source': {
          label: 'Mã nguồn mở',
          description: 'Ai cũng có thể đọc mã nguồn đang giữ cuốn nhật ký.',
        },
        password: {
          label: 'Bắt buộc mật khẩu trước khi mở nhật ký',
          description:
            'Không phải một tùy chọn có thể tắt. Không có nó, các tệp vẫn bị niêm phong.',
        },
        'your-key-only': {
          label: 'Chỉ mật khẩu của bạn nắm giữ',
          description:
            'Cả bốn đều mã hóa. Chỉ Memlore không yêu cầu tài khoản, không có máy chủ của nhà cung cấp và không có cửa sau nào để khôi phục quyền vào nhật ký của bạn.',
        },
        'local-first': {
          label: 'Ưu tiên cục bộ — không có máy chủ nhật ký của nhà cung cấp',
          description: 'Nhật ký nằm trên máy của bạn và vẫn hoạt động khi ngắt mạng.',
        },
        'own-cloud': {
          label: 'Đồng bộ qua thư mục đám mây bạn đã có',
          description:
            'Memlore dùng Google Drive hoặc iCloud Drive của bạn. Journey cũng hỗ trợ Google Drive.',
        },
        'extra-locks': {
          label: 'Khóa thứ hai và kho vô hình',
          description:
            'Một số mục vẫn đóng kín, và một số không để lại dấu vết nào là chúng tồn tại.',
        },
        'optional-ai': {
          label: 'Lượng tính năng AI tùy chọn bạn có',
          description:
            'Tiêu đề, tóm tắt, Đào sâu, Viết tiếp & Viết lại, Trò chuyện hằng ngày, Hỏi nhật ký, ký ức, persona, đánh giá, thống kê, tìm kiếm ngữ nghĩa, cảm xúc, cỗ máy thời gian, hình ảnh — cục bộ, trên thiết bị hoặc bằng khóa API của riêng bạn.',
        },
        editor: {
          label: 'Trình soạn thảo chứa được nhiều hơn chữ',
          description:
            'Markdown, công thức toán, khối mã, lệnh gạch chéo và phương tiện ngay trong trang.',
        },
        appearance: {
          label: 'Tùy biến theo phong cách của bạn',
          description:
            'Ba hệ thống thiết kế, mỗi hệ có màu sắc, độ bo góc, sáng hoặc tối và bề mặt — cùng bố cục bảng và phông chữ viết do bạn chọn.',
        },
        macos: { label: 'Ứng dụng macOS' },
        web: {
          label: 'Ứng dụng web',
          description: 'Đọc và viết nhật ký từ bất kỳ trình duyệt nào, vẫn mã hóa đầu cuối.',
        },
        ios: { label: 'Ứng dụng iOS' },
        android: { label: 'Ứng dụng Android' },
        windows: { label: 'Ứng dụng Windows' },
        linux: { label: 'Ứng dụng Linux' },
        'beta-free': { label: 'Mọi tính năng hiện có đều miễn phí trong giai đoạn beta' },
      },
    },
    platforms: {
      index: 'Nền tảng',
      title: 'Hỗ trợ nhiều nền tảng',
      textWeb: 'Hiện có trên macOS và web. Hãy theo dõi Memlore lớn lên.',
      textMac:
        'Chúng tôi bắt đầu với macOS và dành thời gian để mọi thứ thật vừa vặn. Hãy theo dõi Memlore lớn lên.',
      web: 'Web',
      download: 'Tải về',
      open: 'Mở',
      comingSoon: 'Sắp ra mắt',
      downloadAria: 'Tải bản beta từ GitHub',
      openAria: 'Mở ứng dụng web',
    },
    footer: {
      titleLead: 'Những ngày bình thường',
      titleTail: 'cũng đáng để lưu giữ.',
    },
    hero: {
      mascotFollowAlt: 'Linh vật chú chó của Memlore. Đầu chú dõi theo con trỏ của bạn.',
      mascotAlt: 'Linh vật chú chó của Memlore.',
      portraitLead: 'Một nơi để dừng chân.',
      portraitTail: 'Kể cả vào những ngày bình thường.',
      openSource: 'Mã nguồn mở',
      free: 'Miễn phí',
      titleLead: 'Một cuộc đời nhỏ.',
      titleTail: 'Một câu chuyện còn mãi.',
      descriptionLead: 'Memlore là cuốn nhật ký riêng tư.',
      descriptionTail: 'Cho những ngày bạn muốn nhớ, và những suy nghĩ bạn cần gửi gắm ở đâu đó.',
      meta: 'Không cần tài khoản · Mã hóa trên thiết bị của bạn',
      metaWeb: 'Hiện có trên macOS và web',
      metaMac: 'Hiện có trên macOS',
    },
    spec: {
      label: 'Memlore là gì',
      readSource: 'Đọc mã nguồn',
      syncValue: 'Đám mây của bạn',
      syncNote: 'Google Drive hoặc iCloud Drive.',
      sizeNote: 'Sau khi cài đặt',
      aiValue: 'Tùy chọn',
      aiNote: 'Cục bộ, trên thiết bị hoặc bằng khóa API của riêng bạn.',
      pluginsValue: 'Sắp ra mắt',
      pluginsNote: 'Chỉ cài những gì bạn cần.',
      terms: {
        license: 'giấy phép',
        version: 'phiên bản',
        sync: 'đồng bộ',
        size: 'dung lượng',
        ai: 'ai',
        plugins: 'plugin',
      },
    },
    demo: {
      index: 'Demo',
      title: 'Trải nghiệm thử.',
      subtitle: 'Bản mô phỏng ứng dụng Memlore với dữ liệu giả.',
      cue: 'Cứ bấm thử. Nó hoạt động như ứng dụng thật.',
      chooseAppearance: 'Chọn giao diện',
      openSeparately: 'Mở riêng',
      frameTitle: 'Demo tương tác của Memlore với các mục nhật ký hư cấu',
      posterAlt: 'Ảnh xem trước làm mờ của nhật ký Memlore với một mục mẫu đang mở',
      start: 'Bắt đầu demo',
      loadingTitle: 'Đang mở cuốn nhật ký mẫu của bạn…',
      loadingText: 'Có vài kỷ niệm cần mở ra.',
      slowTitle: 'Demo đang tải lâu hơn một chút.',
      slowText: 'Hãy thử tải lại, hoặc mở demo trong một tab riêng.',
      tryAgain: 'Thử lại',
      openDemo: 'Mở demo',
      disclaimer: 'Dữ liệu mẫu. Việc viết, khóa, đồng bộ và AI đều là mô phỏng.',
      placeholderTitle: 'Bản xem trước này cần cửa sổ rộng hơn.',
      placeholderText:
        'Nhật ký thật là ứng dụng máy tính nên không thể chạy ở đây. Khi có ứng dụng iOS và Android, giao diện của chúng sẽ thay vào chỗ này.',
    },
    encrypt: {
      index: 'Tính năng',
      title: 'Không máy chủ. Không cửa sau. Chúng tôi không thể đọc được.',
      text: 'Mọi thứ được mã hóa trên thiết bị bằng mật khẩu của bạn — kể cả những gì đồng bộ lên đám mây của riêng bạn. Không có máy chủ Memlore nào ở giữa, và không có cách nào vào lại nếu thiếu mật khẩu đó.',
      content: 'Nội dung của bạn',
      password: 'Mật khẩu của bạn',
      cloud: 'Đám mây của bạn',
      noAccess: 'Không có quyền truy cập',
      others: 'Người khác (kể cả chúng tôi)',
      unseen: 'Được mã hóa trước khi rời thiết bị của bạn',
    },
    sync: {
      title: 'Đám mây của bạn. Tài khoản của bạn. Khóa của bạn.',
      text: 'Các mục được mã hóa trên thiết bị, rồi đồng bộ qua Google Drive hoặc iCloud Drive của chính bạn. Chúng tôi không bao giờ giữ tệp, tài khoản hay khóa của bạn.',
      thisDevice: 'Thiết bị này',
      encrypted: 'Mã hóa bằng mật khẩu của bạn',
      ownCloud: 'Đám mây của riêng bạn',
      synced: 'Đã đồng bộ',
      otherDevices: 'Các thiết bị khác của bạn',
      unseen: 'Không có máy chủ Memlore ở giữa',
    },
    locks: {
      title: 'Bạn có thể khóa các mục theo 3 cách khác nhau.',
      items: {
        app: {
          title: 'Khóa ứng dụng',
          text: 'Nhật ký chỉ mở bằng mật khẩu hoặc Touch ID. Khóa này là bắt buộc và bảo vệ nhật ký khỏi truy cập trái phép.',
        },
        second: {
          title: 'Khóa thứ hai',
          text: 'Để giữ riêng một số mục, hãy thêm khóa thứ hai. Người khác mở được ứng dụng sẽ biết có mục riêng tư, nhưng không thể mở chúng.',
        },
        invisible: {
          title: 'Kho vô hình',
          text: 'Nếu bạn cần các mục hoàn toàn vô hình và riêng tư, kể cả với người mở được ứng dụng, họ sẽ không biết những mục đó tồn tại.',
        },
      },
    },
    editor: {
      title: 'Trình soạn thảo giàu tính năng',
      text: 'Trình soạn thảo hỗ trợ đầy đủ Markdown, công thức toán, mã, phương tiện, @-nhắc đến và các plugin tùy chọn. Phản hồi nhanh, kể cả với nội dung rất dài.',
      panes: {
        text: 'Chữ',
        math: 'Toán',
        code: 'Mã',
        media: 'Phương tiện',
        slash: 'Lệnh gạch chéo',
        mention: 'Nhắc đến',
        markdown: 'Markdown',
        plugins: 'Thêm plugin',
        request: 'Cần thêm?',
      },
    },
    emotions: {
      title: 'Theo dõi cảm xúc',
      text: 'Tâm trạng của bạn có thể được theo dõi và phân tích theo thời gian.',
      prompt: 'Bạn đang cảm thấy thế nào?',
      options: { bad: 'Không ổn', neutral: 'Bình thường', good: 'Tốt' },
    },
    locations: {
      title: 'Các mục trên bản đồ',
      text: 'Các mục và ảnh nằm đúng nơi chúng diễn ra. Mở một ghim để quay lại trang đó.',
    },
    transfer: {
      title: 'Nhập và xuất',
      text: 'Bạn có thể nhập các mục (kể cả phương tiện) từ nền tảng khác vào Memlore, và ngược lại. Việc chuyển đổi diễn ra liền mạch.',
      formats: { backup: 'Bản sao lưu', markdown: 'Markdown', plainText: 'Văn bản thuần' },
    },
    looks: {
      title: 'Tùy biến theo phong cách của bạn.',
      textLead: 'Signature, Clean và Clay — hãy thử chúng trong ',
      demoLink: 'demo',
      textTail: ' ở trên. Rồi tùy chỉnh tiếp.',
      cards: {
        clay: { title: 'Thứ Ba', line: 'Một buổi sáng yên tĩnh' },
        signature: { title: 'Thứ Hai', line: 'Khi trời tối' },
        clean: { title: 'Ghi chú', line: 'Đơn giản và rõ ràng' },
        lumen: { title: 'Đêm', line: 'Tối kiểu xưởng đúc' },
        'clay-dark': { title: 'Buổi tối', line: 'Giấy ấm' },
      },
      editorCard: {
        title: 'Một câu chuyện còn mãi.',
        line: 'Kiểu chữ bạn viết.',
        font: 'Google Font · độ tương phản',
      },
      items: {
        skins: {
          title: 'Ba hệ thống thiết kế',
          text: 'Signature, Clean và Clay. Chuyển đổi trực tiếp trong demo ở trên.',
        },
        knobs: {
          title: 'Rồi đến các tùy chỉnh',
          text: 'Màu nhấn, độ bo góc, sáng hoặc tối, và bề mặt tối — Deep, Soft hoặc Lumen.',
        },
        layout: {
          title: 'Bố cục bảng',
          text: 'Thanh bên và danh sách ở bên trái, bên phải, hoặc kẹp trang viết ở giữa.',
        },
        type: {
          title: 'Kiểu chữ',
          text: 'Phông chữ ứng dụng đi theo giao diện. Trình soạn thảo có phông riêng — phông tích hợp sẵn hoặc một Google Font tùy chọn, cùng cỡ chữ và độ tương phản.',
        },
      },
    },
    talk: {
      title: 'Cứ trò chuyện. Rồi giữ lại trang viết.',
      text: 'Một cuộc trò chuyện về ngày hôm nay có thể trở thành mục nhật ký khi bạn lưu lại. Luôn tắt cho đến khi bạn chọn bật.',
      items: {
        daily: {
          title: 'Trò chuyện hằng ngày',
          text: 'Gõ ngay trong Memlore. Khi sẵn sàng, lưu cuộc trò chuyện thành một mục.',
        },
        voice: { title: 'Chế độ giọng nói', text: 'Kể về ngày của bạn thay vì gõ.' },
        mcp: {
          title: 'MCP',
          text: 'Trò chuyện trong ChatGPT, Claude, Gemini, Ollama hoặc AI khác bạn đang dùng.',
        },
      },
      figure: {
        daily: 'Trò chuyện hằng ngày',
        you1: 'Đi dạo giúp ích thật.',
        ai1: 'Điều gì còn đọng lại với bạn?',
        you2: 'Con phố yên tĩnh đến lạ.',
        ai2: 'Mình sẽ giữ điều đó cho trang viết.',
        voice: 'Giọng nói',
        more: 'Thêm',
        search: 'Tìm các mục',
        read: 'Đọc một trang',
        append: 'Thêm vào hôm nay',
        into: 'Rồi lưu thành một mục',
      },
    },
    persona: {
      title: 'Tạo một bản thể thứ hai.',
      text: 'Từ văn phong, ký ức và cách bạn mô tả bản thân, Memlore tạo một persona viết giống bạn — để viết tiếp trang nhật ký bằng giọng của bạn, hoặc ngồi xuống trò chuyện cùng nó. Luôn tắt cho đến khi bạn chọn bật.',
      items: {
        style: { title: 'Văn phong của bạn', text: 'Lấy mẫu từ những trang bạn đã viết.' },
        memories: {
          title: 'Ký ức của bạn',
          text: 'Những con người, địa điểm và sự kiện Memlore đã học được.',
        },
        words: {
          title: 'Lời của chính bạn',
          text: 'Vài câu trả lời về cách bạn muốn thể hiện — và bạn là ai.',
        },
      },
    },
    plugins: {
      title: 'Plugin, chỉ khi bạn cần.',
      soon: 'Sắp ra mắt',
      text: 'Các công cụ bổ sung đến dưới dạng plugin. Cài khi bạn cần, và bỏ qua phần còn lại.',
    },
    ai: {
      index: 'AI',
      title: 'Bộ tính năng AI phong phú',
      text: 'Các công cụ AI chỉ bật khi bạn chọn. Memlore hỗ trợ AI chạy cục bộ 100%, cũng như các nhà cung cấp trực tuyến bằng khóa API của riêng bạn.',
      items: {
        titles: {
          title: 'Tiêu đề thông minh',
          text: 'Gợi ý một tiêu đề ngắn từ mục bạn vừa viết.',
        },
        summaries: {
          title: 'Điểm nhấn và tóm tắt',
          text: 'Bản tóm lược có thể thu gọn về chủ đề, cảm xúc và khoảnh khắc, được lưu cùng mục.',
        },
        deeper: {
          title: 'Đào sâu',
          text: 'Ba câu hỏi gợi mở để suy ngẫm thêm, chèn thành thẻ bên dưới trình soạn thảo.',
        },
        continue: {
          title: 'Viết tiếp & Viết lại',
          text: 'Viết tiếp mục từ chân trang, hoặc viết lại đoạn đã chọn — bằng giọng của bạn.',
        },
        chat: {
          title: 'Trò chuyện hằng ngày',
          text: 'Một cuộc trò chuyện về ngày hôm nay có thể trở thành mục nhật ký khi bạn lưu lại.',
        },
        ask: {
          title: 'Hỏi nhật ký',
          text: 'Bạn có thể hỏi về những ký ức và mục nhật ký mà Memlore đã học được.',
        },
        memories: {
          title: 'Ký ức và Persona',
          text: 'Dựa trên các mục và thông tin bạn cung cấp, Memlore có thể tạo một bản thể thứ hai viết bằng giọng và văn phong của bạn.',
        },
        reviews: {
          title: 'Đánh giá và Thống kê',
          text: 'Bạn có thể dùng AI để xem thống kê những gì bạn đã viết trong một khoảng thời gian.',
        },
        search: {
          title: 'Tìm kiếm ngữ nghĩa',
          text: 'Không chỉ tìm theo từ khóa, mà tìm theo ý nghĩa, diễn đạt tự do bằng ngôn ngữ tự nhiên.',
        },
        emotion: {
          title: 'Gợi ý cảm xúc',
          text: 'Nếu bạn bật tính năng theo dõi cảm xúc, AI có thể gợi ý cảm xúc của bạn dựa trên các mục bạn đã viết.',
        },
        time: {
          title: 'Tóm tắt cỗ máy thời gian',
          text: 'Cùng một ngày trên lịch qua nhiều năm, gộp lại thành một bản tóm lược.',
        },
        image: {
          title: 'Tạo hình ảnh',
          text: 'Dùng AI để tạo ảnh bìa và hình minh họa trong mục nhật ký.',
        },
        coming: { title: 'Còn nhiều nữa' },
        request: { title: 'Cần thêm?' },
        device: {
          title: 'Xử lý trên thiết bị',
          text: 'Memlore tích hợp sẵn AI cục bộ để dữ liệu của bạn luôn riêng tư 100% và không bao giờ rời khỏi thiết bị.',
        },
      },
    },
  },
}

export default vi

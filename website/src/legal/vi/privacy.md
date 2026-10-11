---
sourceHash: 320fef71a80d
title: Memlore — Chính sách quyền riêng tư
description: Cách Memlore đối xử với nhật ký của bạn: nó ở lại trên thiết bị của bạn, không có máy chủ Memlore, không thu thập dữ liệu sử dụng, cùng đám mây và AI tùy chọn do bạn kiểm soát.
updated: 11 tháng 10, 2026
---

# Chính sách quyền riêng tư

Memlore là app nhật ký riêng tư. Trang này giải thích ứng dụng và trang web này làm gì với thông tin — và những gì chúng không bao giờ làm.

## Chúng tôi là ai

Memlore được làm ra bởi [Anh-Thi Dinh](https://dinhanhthi.com). Đây là một ứng dụng nhật ký mã nguồn mở. Câu hỏi: [contact@memlore.app](mailto:contact@memlore.app).

## Những gì chúng tôi không thu thập

Không có máy chủ Memlore và không có tài khoản Memlore. Ứng dụng không theo dõi bạn.

- Không thu thập dữ liệu sử dụng (telemetry)
- Không phân tích
- Không quảng cáo
- Không pixel theo dõi

## Nhật ký trên thiết bị của bạn

Nhật ký của bạn nằm trên thiết bị của bạn, trong một cơ sở dữ liệu cục bộ được mã hóa. Chúng tôi không thể đọc nó.

## Đồng bộ đám mây tùy chọn

Đồng bộ luôn tắt cho đến khi bạn bật. Bạn chọn một nơi — Google Drive hoặc iCloud Drive của bạn. Không có máy chủ Memlore ở giữa.

Các mục, phương tiện và cài đặt được mã hóa trên thiết bị trước khi tải lên. Một danh sách đồng bộ nhỏ và sổ đăng ký thiết bị — ID, dấu thời gian, cờ xóa và tên thiết bị của bạn, không phải nội dung nhật ký — được lưu dưới dạng JSON để các thiết bị khác của bạn biết cần tải gì về.

## Đồng bộ Google Drive tùy chọn

Nếu bạn chọn Google Drive, bạn kết nối tài khoản Google của chính mình. Memlore chỉ yêu cầu phạm vi [drive.appdata](https://www.googleapis.com/auth/drive.appdata). Các tệp đồng bộ nằm trong thư mục Dữ liệu ứng dụng ẩn của Google Drive — không hiển thị trên drive.google.com — và Memlore không thể đọc các tệp Drive khác của bạn.

Refresh token, email tài khoản Google và hạn mức lưu trữ Drive của bạn chỉ nằm trong cơ sở dữ liệu được mã hóa trên thiết bị này, để ứng dụng có thể hiển thị tài khoản nào đang được kết nối. Chúng được giữ cho đến khi bạn ngắt kết nối, rồi bị xóa khỏi cơ sở dữ liệu cục bộ. Access token chỉ nằm trong bộ nhớ, không bao giờ được ghi ra đĩa và biến mất khi ứng dụng đóng.

Ngắt kết nối trong ứng dụng không xóa các tệp đã có trong thư mục Dữ liệu ứng dụng ẩn của bạn. Để xóa bản sao phía Google đó, hãy mở Google Drive → Cài đặt → Quản lý ứng dụng → Memlore → Ngắt kết nối khỏi Drive.

Dữ liệu người dùng Google chỉ được dùng để vận hành tính năng đồng bộ Drive mà bạn đã bật. Không ai ở Memlore đọc dữ liệu người dùng Google của bạn. Không có máy chủ Memlore nào để dữ liệu đó đến. Memlore không:

- Bán dữ liệu đó, hoặc chuyển nó cho các nhà môi giới dữ liệu hay đơn vị bán lại thông tin
- Dùng dữ liệu đó cho quảng cáo, bao gồm quảng cáo nhắm mục tiêu, cá nhân hóa hoặc dựa trên sở thích
- Dùng dữ liệu đó để phát triển, cải thiện hoặc huấn luyện các mô hình AI hay ML tổng quát hoặc không cá nhân hóa
- Dùng dữ liệu đó để đánh giá mức độ tín nhiệm tín dụng, cho vay hoặc bất kỳ quyết định nào khác không liên quan đến các tính năng của ứng dụng
- Chuyển dữ liệu đó cho bên thứ ba, trừ khi cần để vận hành đồng bộ Drive trong chính tài khoản Google của bạn, hoặc khi pháp luật yêu cầu

Việc Memlore sử dụng và chuyển giao cho bất kỳ ứng dụng nào khác thông tin nhận được từ các API của Google sẽ tuân thủ [Chính sách dữ liệu người dùng của Dịch vụ API Google](https://developers.google.com/terms/api-services-user-data-policy), bao gồm các yêu cầu về Sử dụng giới hạn.

## iCloud Drive tùy chọn

Nếu bạn chọn iCloud Drive (trên máy Mac), Memlore ghi vào một thư mục Memlore trong iCloud Drive của bạn — chính iCloud Drive bạn vẫn thấy trong Finder.

Memlore không đăng nhập Apple thay bạn và không lưu mật khẩu Apple hay token iCloud. Nó dùng phiên iCloud Drive sẵn có trên máy Mac này.

Cùng các dữ liệu đã mã hóa và danh sách đồng bộ JSON mô tả ở trên được đưa vào thư mục đó. Apple không nhận được nhật ký của bạn ở dạng văn bản rõ. Các điều khoản iCloud của Apple được áp dụng.

Bạn có thể ngắt kết nối trong ứng dụng. Việc ngắt kết nối không xóa thư mục Memlore trong iCloud Drive. Hãy tự xóa thư mục đó nếu bạn muốn bỏ bản sao trên đám mây.

## AI tùy chọn

AI luôn tắt cho đến khi bạn chọn bật và chấp nhận một thông báo quyền riêng tư. Bạn chọn nhà cung cấp — cục bộ hoặc trên thiết bị, hoặc một nhà cung cấp trực tuyến.

Nếu bạn chọn nhà cung cấp trực tuyến, văn bản bạn gửi sẽ đến nhà cung cấp đó. Memlore không vận hành các dịch vụ đó và không thấy lưu lượng này.

## Bản đồ, địa điểm và giọng nói tùy chọn

Bản đồ, mã hóa địa lý và chuyển giọng nói thành văn bản chỉ chạy khi bạn bật. Chúng kết nối với nhà cung cấp bạn chọn — ví dụ Nominatim/OpenStreetMap, Mapbox, MapTiler, Apple MapKit hoặc nhà cung cấp chuyển giọng nói thành văn bản của bạn.

## Cập nhật ứng dụng

Ứng dụng có thể yêu cầu siêu dữ liệu bản phát hành từ GitHub để báo cho bạn khi có bản cập nhật. Việc kiểm tra đó không phải là thu thập dữ liệu sử dụng.

## Memlore Web (web.memlore.app)

Memlore Web là một ứng dụng đồng hành tùy chọn trên trình duyệt, cho phép bạn đọc nhật ký Memlore hiện có từ trình duyệt web và tạo các chỉnh sửa mà ứng dụng máy tính của bạn sẽ nhập vào.

- **Những gì được lưu cục bộ trong trình duyệt:** Memlore Web chỉ lưu một bộ nhớ đệm được mã hóa trong IndexedDB của trình duyệt. Các khóa mã hóa chính được giữ trong bộ nhớ WebAssembly và bị xóa ngay khi bạn khóa kho hoặc đóng tab. Để việc tải lại trang không hỏi lại mật khẩu, tab đang mở còn giữ một bản sao đã niêm phong của khóa chính, cùng với khóa dùng một lần để mở nó, trong bộ nhớ phiên (session storage) của tab đó. Ứng dụng chỉ dùng nó để tải lại tab đó, cho đến khi bạn khóa hoặc hết thời gian tự động khóa; khi khóa, bản sao này bị xóa. Trình duyệt có thể giữ bộ nhớ phiên của một tab trên đĩa sau khi tab đóng (để khôi phục tab), và giới hạn thời gian do ứng dụng áp dụng chứ không phải do lớp mã hóa, nên bất kỳ ai sao chép hồ sơ trình duyệt trước khi bạn khóa đều có thể mở nhật ký. Hãy khóa kho trước khi rời một máy tính dùng chung. Các mục nhật ký của bạn chỉ được lưu trên đĩa dưới dạng bản mã hóa AES-256-GCM; văn bản chưa mã hóa không bao giờ được lưu trong bộ nhớ trình duyệt.
- **Cloudflare Worker:** Một Cloudflare Worker tạm thời tại `web.memlore.app/api/*` xử lý việc trao đổi token OAuth 2.0 PKCE với Google để bí mật của ứng dụng được bảo vệ. Worker không bao giờ thấy, phân tích hay ghi nhật ký cụm từ khôi phục chính, khóa mã hóa hay nội dung nhật ký của bạn, và không duy trì cơ sở dữ liệu lâu dài hay nhật ký truy cập nào của token.
- **Hạ tầng lưu trữ:** Memlore Web được lưu trữ trên Cloudflare Pages. Như mọi máy chủ web, Cloudflare xử lý các header yêu cầu HTTP tiêu chuẩn và địa chỉ IP chỉ nhằm giảm thiểu DDoS và phân phối nội dung.
- **Phạm vi Google Drive:** Memlore Web chỉ kết nối với phạm vi giới hạn `drive.appdata` của Google Drive (dữ liệu ứng dụng ẩn). Nó không thể xem, đọc hay sửa bất kỳ tài liệu, ảnh hay bảng tính cá nhân nào trên Google Drive của bạn.
- **Ô bản đồ (tùy chọn, tắt theo mặc định):** Trang bản đồ trên web trước tiên liệt kê các địa điểm của bạn mà không liên hệ với nhà cung cấp bản đồ nào. Chỉ sau khi bạn bật ô bản đồ bằng khóa API MapTiler của chính mình, trình duyệt mới tải ô bản đồ từ MapTiler, và MapTiler khi đó nhận được vùng bản đồ bạn xem cùng địa chỉ IP của bạn. Khóa API của bạn được lưu mã hóa trong trình duyệt này. Bạn có thể ngừng dùng ô bản đồ bất cứ lúc nào.
- **Không phân tích:** Memlore Web không chứa công cụ theo dõi phân tích, mã quảng cáo, cookie theo dõi hay thu thập dữ liệu hành vi.
- **Cách xóa mọi thứ:** Bạn có thể xóa mọi dấu vết trên web bất cứ lúc nào:
  1. Trong cài đặt trình duyệt, xóa dữ liệu trang web của web.memlore.app. Thao tác này xóa mọi thứ Memlore Web đã lưu trong trình duyệt đó (bộ nhớ đệm được mã hóa, các chỉnh sửa chưa gửi và khóa được bọc bằng mật khẩu). Nút **Xóa bộ nhớ đệm** trong cài đặt Memlore Web chỉ xóa ảnh và video đã lưu đệm.
  2. Trong ứng dụng Memlore trên máy tính, mở Cài đặt → Bảo mật → Hành động bảo mật → Thiết bị đã kết nối và xóa thiết bị web.
  3. Thu hồi quyền truy cập Google Drive tại [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Trang web này

Trang web giới thiệu này không đặt cookie phân tích và không thu thập dữ liệu nhật ký. Bản demo tương tác chỉ dùng dữ liệu mẫu.

Nút Tải về là ngoại lệ duy nhất, và đáng để nói rõ. Nó đi qua dl.memlore.app, nơi đếm lượt tải rồi chuyển bạn đến tệp trên GitHub. Những gì được ghi lại là thời điểm, phiên bản ứng dụng và quốc gia mà Cloudflare suy ra từ kết nối. Không lưu địa chỉ IP và không đặt cookie. Việc này chỉ xảy ra khi bạn tải ứng dụng, không bao giờ trong lúc bạn dùng nó — bản thân ứng dụng vẫn không gửi gì cả, không bao giờ.

## Thay đổi

Chính sách này có thể thay đổi. Ngày ở đầu trang cho biết lần cập nhật gần nhất.

## Cách liên hệ với chúng tôi

Câu hỏi về quyền riêng tư: [contact@memlore.app](mailto:contact@memlore.app).

Trang này là bản dịch. Nếu có khác biệt, [bản tiếng Anh](/privacy) được ưu tiên áp dụng.

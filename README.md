# SangLive

SangLive là ứng dụng livestream YouTube tối ưu CPU: trình duyệt làm UI điều khiển, FFmpeg đọc camera Windows trực tiếp bằng DirectShow và đẩy RTMP lên YouTube.

## Chạy local

Máy đã có Node.js 20 LTS có thể cài bằng một lệnh:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://raw.githubusercontent.com/thsangyk-oss/sanglive/main/install-from-github.ps1 | iex"
```

Hoặc clone thủ công:

```powershell
git clone https://github.com/thsangyk-oss/sanglive.git
cd sanglive
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Sau khi cài xong, Desktop sẽ có shortcut `SangLive` với logo app.

Bấm shortcut đó để:

- Nếu backend đang online ở port `8788`, chỉ mở frontend.
- Nếu backend offline hoặc port `8788` bị treo, dừng process đang chiếm port rồi start backend mới.
- Mở frontend `http://localhost:8788`.

Có thể chạy thủ công bằng:

```bat
start.bat
```

## OAuth YouTube

Sao chép `.env.example` thành `.env`, rồi điền Google OAuth credentials:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:8788/auth/callback
```

## Preset

- Tư vấn: `720p30`, `2000 kbps`
- Phẫu thuật: `1080p60`, `5000 kbps`

## Log debug

Mỗi lần bấm live, app tạo một file log riêng trong thư mục:

```text
logs/
```

Tên file có dạng:

```text
live-YYYY-MM-DDTHH-mm-ss-sssZ-camera.log
```

Log gồm cấu hình start, FFmpeg stderr, restart/fallback encoder và lý do stop/error.

## Lưu ý

- Cần chạy trên Windows có camera DirectShow.
- Nên chọn `Encoder = Auto GPU nếu có` để dùng NVENC/QSV/AMF nếu máy hỗ trợ.
- Nếu camera không mở được `1080p60`, chọn preset Tư vấn hoặc Custom `1080p30`.
- SangLive không có canvas preview để giảm CPU tối đa.

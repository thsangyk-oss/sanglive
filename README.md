# XAlive Lite

XAlive Lite là bản giảm tải CPU: trình duyệt chỉ làm UI điều khiển, FFmpeg đọc camera Windows trực tiếp bằng DirectShow và đẩy RTMP lên YouTube.

## Chạy Local

Máy đã có Node.js 20 LTS có thể cài bằng một lệnh:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://raw.githubusercontent.com/thsangyk-oss/xalive-lite/main/install-from-github.ps1 | iex"
```

Hoặc clone thủ công:

```powershell
git clone https://github.com/thsangyk-oss/xalive-lite.git
cd xalive-lite
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Sau khi cài xong, Desktop sẽ có shortcut `XAlive Lite` với logo app.

Bấm shortcut đó để:

- Nếu backend đang online ở port `4111`, chỉ mở frontend.
- Nếu backend offline hoặc port `4111` bị treo, dừng process đang chiếm port rồi start backend mới.
- Mở frontend `http://localhost:4111`.

Có thể chạy thủ công bằng:

```bat
start.bat
```

## OAuth YouTube

Sao chép `.env.example` thành `.env`, rồi điền Google OAuth credentials:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:4111/auth/callback
```

## Preset

- Tư vấn: `720p30`, `2000 kbps`
- Phẫu thuật: `1080p60`, `5000 kbps`

## Log Debug

Mỗi lần bấm live, app tạo một file log riêng trong thư mục:

```text
logs/
```

Tên file có dạng:

```text
live-YYYY-MM-DDTHH-mm-ss-sssZ-camera.log
```

Log gồm cấu hình start, FFmpeg stderr, restart/fallback encoder và lý do stop/error.

## Lưu Ý

- Cần chạy trên Windows có camera DirectShow.
- Nên chọn `Encoder = Auto GPU nếu có` để dùng NVENC/QSV/AMF nếu máy hỗ trợ.
- Nếu camera không mở được `1080p60`, chọn preset Tư vấn hoặc Custom `1080p30`.
- Bản Lite không có canvas preview để giảm CPU tối đa.

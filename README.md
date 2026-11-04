# Qt Developer Pack cho Orca

Bộ 3 plugin Orca cho dev Qt / QML / PySide6 / PyQt (Python và C++). Dùng nội bộ trong team,
**repo private, không đăng lên danh mục công khai của Orca**.

| Plugin | Loại | Cần duyệt quyền | Nội dung |
| --- | --- | --- | --- |
| **Qt Developer Syntax** (`qt-dev-syntax`) | `data` | Không | Tô màu `.qss`, `.qrc`, `.ui`, `.qtd`, `.qdoc`, `pysidedeploy.spec`, qmake (`.pro/.pri/.prf`), `.cmake`, `CMakeCache.txt`, `requirements.txt` |
| **Qt Developer Icons** (`qt-dev-icons`) | `data` | Không | Icon Material (~470 loại file) + icon Qt cho `.qml`, `.ui`, `.qrc`, `.qss`, `qmldir`, QDoc, PySide6 deploy; icon thư mục `qml/`, `ui/`, `resources/`, `translations/`… Có bản sáng và tối |
| **Qt Developer Tools** (`qt-dev-tools`) | `trusted-worker` | **Có** | Panel "Qt Tools" liệt kê file Qt của workspace với nút Designer / uic / rcc / qmllint / Preview / Format / Linguist / lrelease / CMake configure + build / qmake / Run; 8 lệnh trong Command Palette; `qmlformat` tự chạy khi lưu `.qml`; phím tắt `Ctrl+Shift+B` = CMake build |

**Cài kèm:** plugin chính thức **QML Syntax** (`stablyai.orca-qml`) từ Settings → Plugins để tô màu `.qml` và `qmldir`.
Python, C++ và `CMakeLists.txt` thì Orca đã tô màu sẵn.

**Không làm được** (giới hạn của Orca, không phải của bộ này): Ctrl+Click đi tới định nghĩa, gợi ý code, báo lỗi
khi gõ. Orca không có language server và plugin không thêm được. Cần những thứ đó thì mở dự án bằng VS Code.

![Panel Qt Tools](docs/panel-files.png)

## Cài cho thành viên team

Yêu cầu: Orca ≥ 1.4.248, đã bật plugin (Settings → Plugins → Turn on plugins), git trên máy đã đăng nhập
GitHub và có quyền đọc repo `tungvu-vms/orca-qt-pack`.

1. Orca → **Settings → Plugins → Marketplaces → Add** → dán
   `https://github.com/tungvu-vms/orca-qt-pack.git`, ref `main`.
2. Trong danh sách plugin của marketplace "Qt Developer Pack (team)", cài cả 3.
3. **Qt Developer Tools** sẽ hỏi duyệt quyền: chạy code Node.js, đọc workspace, mở file, mở terminal chạy lệnh,
   hiện thông báo, đọc setting riêng. Duyệt thì mới chạy.
4. **Settings → Appearance → Icon theme** → *Qt Developer Icons* (hoặc bản Light với theme sáng).
5. Mở panel **Qt Tools** (icon cờ lê ở thanh bên phải).

### Cấu hình (Settings → Plugins → Qt Developer Tools)

| Setting | Mặc định | Ghi chú |
| --- | --- | --- |
| Qt bin folder | trống | Trống thì tìm trên PATH rồi `C:\Qt\<bản mới nhất>\*\bin` |
| Python binding | PySide6 | PySide6 / PyQt6 / PyQt5 / C++. Quyết định `uic`/`rcc` sinh code gì |
| Python interpreter | trống | Trống thì dùng `.venv`/`venv` của workspace, rồi `python` trên PATH |
| Format QML on save | bật | Chạy `qmlformat`, giữ nguyên kiểu xuống dòng của file |
| CMake generator / build type | Ninja / Debug | Dùng cho *Configure* |

## Phát triển

```sh
npm install                      # typescript, @types/node, vscode-textmate (chỉ để kiểm tra, không nằm trong plugin)
npx tsc -p plugins/qt-tools      # kiểm tra kiểu (Orca chỉ bỏ kiểu, không kiểm tra)
orca plugin test plugins/qt-tools
orca plugin check plugins/qt-tools
orca plugin validate plugins/qt-syntax
node tools/tokenize-check.mjs plugins/qt-syntax samples/*   # chạy từ thư mục có node_modules
orca plugin dev load plugins/<tên>   # nạp thử vào Orca của mình
```

- **Đừng để gì khác vào thư mục `plugins/<tên>/`** (`node_modules`, file `.d.ts`, file build…). Orca băm toàn bộ
  thư mục; thêm file sau khi duyệt sẽ làm worker không khởi động ("content hash mismatch").
  Kiểu của Orca nằm ở `types/orca/` (lấy từ stablyai/orca commit `295b828bd1`).
- `tools/normalize-syntaxes.mjs`: chuẩn hóa grammar lấy từ VS Code cho bộ kiểm tra khắt khe hơn của Orca.
- `tools/build-icon-theme.mjs`: ghép icon Qt vào theme Material, cắt bớt cho vừa giới hạn 512 mục của Orca.

### Phát hành bản mới

1. Sửa plugin, **tăng `version`** trong `orca-plugin.json` của plugin đó, commit.
2. `node tools/build-catalog.mjs --url https://github.com/tungvu-vms/orca-qt-pack.git --owner tungvu-vms`
3. Commit `orca-catalog.json`, push. Orca của team tự cập nhật (plugin `trusted-worker` thêm quyền mới sẽ hỏi duyệt lại).

Mỗi release ghim vào commit cuối cùng đã sửa thư mục plugin, kèm `contentHash`. Orca từ chối cài nếu nội dung khác.

## Nguồn và giấy phép

| Thành phần | Nguồn | Giấy phép |
| --- | --- | --- |
| Grammar qss, qrc, ui, qt-ts, qtd, qdoc, pysidedeploy; icon Qt | Extension Qt cho VS Code (qt-labs/vscodeext) 1.16.0 | LGPL-3.0 (`LICENSE-Qt-LGPL-3.0.txt`) |
| Grammar CMake, CMakeCache | microsoft/vscode-cmake-tools 1.24.42 | MIT |
| Grammar pip-requirements | microsoft/vscode-python 2026.10.0 | MIT |
| Grammar XML, INI, Java (phụ thuộc) | microsoft/vscode 1.143.1 | MIT |
| Icon Material + theme gốc | stablyai/orca-plugins `material-icons` (Material Extensions) | MIT |
| Grammar qmake, code của Qt Developer Tools, các script | Tự viết | MIT |

Các grammar của Qt được chép nguyên văn, chỉ chuẩn hóa định dạng JSON (bỏ comment, đổi cặp ngoặc thành object,
bỏ khóa capture không phải số) để Orca nhận.

# Chiếm Cứ Điểm

Game đấu giá quân lệnh + trả lời câu hỏi để chiếm 30 ô đất trên bản đồ, dành cho 6 đội chơi.

## Cài đặt & chạy

```bash
npm install
npm start
```

Mặc định chạy tại `http://localhost:3000`. Để đổi cổng hoặc mật khẩu host:

```bash
PORT=8080 HOST_PASSWORD="mat_khau_cua_ban" npm start
```

Triển khai lên server thật (VPS, Render, Railway...) thì deploy y như một app Node.js/Express bình thường — không cần database, mọi thứ giữ trong bộ nhớ của tiến trình server (reset khi restart server).

## Các đường dẫn

- `/` — trang chọn vai trò (đội chơi / ban tổ chức)
- `/team.html?team=t1` — panel riêng cho từng đội (t1..t6), mỗi đội mở trên điện thoại của mình
- `/host.html` — bảng điều khiển ban tổ chức (cần mật khẩu, mặc định `admin123`)
- `/screen.html` — màn hình chiếu cho cả lớp xem (mở trên máy chiếu/TV, không cần đăng nhập)

## Chỉnh 30 câu hỏi

Sửa file `data/questions.json`. Câu hỏi thứ N (đếm từ 1) sẽ tương ứng với ô đất số N trên bản đồ (bản đồ 5 hàng x 6 cột, đánh số 1-30 trái sang phải, trên xuống dưới). Mỗi câu có 4 đáp án, `correctIndex` là chỉ số đáp án đúng (0=A, 1=B, 2=C, 3=D).

## Luật chơi đã cài đặt

- 6 đội, mỗi đội bắt đầu với 100 quân lệnh.
- Mỗi vòng: các đội đấu giá bí mật (nhập số quân lệnh, ẩn với đội khác cho tới khi đủ 6 đội đặt, hoặc host bấm "buộc mở kết quả").
- Đội đặt cao nhất thắng, bị trừ đúng số đã đặt; đội nào **đặt 0** thì bị phạt 5 quân lệnh (dù thắng hay thua).
- Đội thắng chọn 1 ô đất trống bất kỳ → câu hỏi trắc nghiệm hiện ra (chỉ đội đó thấy & trả lời) → đúng thì chiếm ô, sai thì ô bỏ trống, chuyển vòng tiếp.
- Sở hữu 3 ô liền nhau theo hàng ngang hoặc dọc → mỗi ô trong chuỗi đó cộng thêm 10 sao (tự động tính lại mỗi khi bảng đất thay đổi).
- 30 ô đất có giá trị sao khác nhau (10/15/20 sao), xáo trộn ngẫu nhiên mỗi khi bắt đầu trận mới.
- 5 ô đặc biệt (ẩn danh tính cho tới khi bị chiếm thành công), vị trí ngẫu nhiên mỗi ván:
  - **Kho báu** (2 ô): tự động x2 số sao của ô đó.
  - **Xóa đất** (2 ô): đội chiếm được chọn 1 ô bất kỳ của đối thủ để xóa quyền sở hữu (ô đó trở lại trống).
  - **Đổi đất** (1 ô): đội chiếm được chọn 2 ô đã có chủ bất kỳ trên bàn để hoán đổi chủ sở hữu.
- Kết thúc khi cả 30 ô đều có chủ — đội nhiều sao nhất thắng.

## Có thể tùy chỉnh thêm (nói mình biết nếu bạn muốn)

- Thêm đồng hồ đếm ngược cho vòng đấu giá / trả lời.
- Lưu trạng thái vào file/DB để không mất khi restart server.
- Hiệu ứng âm thanh, animation khi chiếm đất.
- Đổi tỉ lệ sao (10/15/20), số ô đặc biệt, mức phạt đặt 0 quân.
- Đổi layout bản đồ thành hình dạng khác (vd bản đồ Việt Nam) thay vì lưới 5x6.

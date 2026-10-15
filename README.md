# GitHub Task Board — Backend

Backend của đồ án: hệ thống quản lý công việc nhóm phát triển phần mềm, đồng bộ hai chiều với GitHub Issues, có AI hỗ trợ.

**Công nghệ:** NestJS 12 · TypeScript · PostgreSQL (Supabase) + pgvector · Prisma 7 · Octokit · Socket.io · Gemini API

Frontend nằm ở repo `github-task-board-fe`, gọi các API ở phần "API" bên dưới.

## Chạy dự án

Cần Node.js 20.19 trở lên (hoặc 22.12 trở lên) và đã làm xong phần chuẩn bị (database Supabase, GitHub OAuth App, khóa Gemini).

```bash
npm install
cp .env.example .env     # rồi điền giá trị, xem chú thích trong file
npm run db:push          # tạo các bảng trong database theo prisma/schema.prisma
npm run db:vector-index  # tạo chỉ mục tìm kiếm vector (chạy một lần)
npm run start:dev        # backend chạy tại http://localhost:4000
```

Nếu `db:vector-index` báo lỗi, mở **SQL Editor** trên Supabase, dán nội dung file `prisma/sql/pgvector-index.sql` rồi bấm Run (chỉ mục chỉ giúp tìm nhanh hơn khi có nhiều issue, thiếu nó chức năng vẫn chạy đúng).

Các lệnh khác: `npm test`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm run db:studio` (xem dữ liệu bằng giao diện).

### Nhận webhook khi code ở máy cá nhân

GitHub không gửi được webhook tới `localhost`, nên dùng smee.io làm trạm chuyển tiếp:

1. Vào https://smee.io/new để lấy một địa chỉ kênh, điền vào `WEBHOOK_URL` trong `.env`.
2. Chạy ở một terminal khác: `npx smee-client --url <địa-chỉ-kênh> --target http://localhost:4000/webhooks/github`

## Cấu trúc thư mục

```
src/
├── main.ts                 # Khởi động: CORS, cookie, kiểm tra dữ liệu, Socket.io
├── app.module.ts           # Ghép các module lại
├── config/                 # Đọc và kiểm tra biến môi trường (env.ts)
├── prisma/                 # Kết nối database
├── auth/                   # Đăng nhập GitHub OAuth, phiên đăng nhập (cookie JWT)
├── access/                 # Kiểm tra quyền: thành viên hay owner của repository
├── github/                 # Mọi lời gọi tới GitHub API (Octokit)
├── repositories/           # Danh sách repo, kết nối repo (nhãn chuẩn, webhook, lấy issue cũ)
├── issues/                 # Xem, tạo, sửa, đổi cột issue; đồng bộ với GitHub
├── webhooks/               # Nhận thay đổi từ GitHub
├── realtime/               # Socket.io: đẩy thay đổi xuống trình duyệt
├── dashboard/              # Thống kê theo thành viên và theo tuần
├── ai/                     # Báo cáo tuần, phát hiện issue trùng (Gemini + pgvector)
└── common/                 # Hằng số, hàm dùng chung, guard, bộ lọc lỗi
prisma/
├── schema.prisma           # Các bảng: User, Repository, Issue, WeeklySummary
└── sql/pgvector-index.sql  # Chỉ mục vector
```

Mỗi module có cấu trúc `controller` (nhận request) → `service` (xử lý) → `Prisma` hoặc `GithubService` (dữ liệu). Controller không chứa logic.

## Cách hệ thống hoạt động

### Đăng nhập và phân quyền

Đăng nhập bằng GitHub OAuth. Backend lưu token GitHub (đã mã hóa AES-256-GCM) và đặt cookie `httpOnly` chứa phiên đăng nhập. Không có tài khoản admin riêng:

| Việc | Ai làm được |
| --- | --- |
| Xem board, issue, dashboard; tạo, sửa issue; kéo thẻ | Mọi thành viên của repo |
| Kết nối repo, bấm tạo báo cáo AI | Owner (người có quyền admin trên repo GitHub) |

Quyền lấy trực tiếp từ GitHub và được kiểm tra lại ở backend mỗi lần thao tác, không chỉ dựa vào việc ẩn nút trên giao diện.

### Đồng bộ hai chiều với GitHub

- **Từ app sang GitHub:** backend gọi GitHub trước (bằng token của chính người dùng), lấy kết quả GitHub trả về rồi mới lưu vào database và báo cho các trình duyệt.
- **Từ GitHub sang app:** GitHub gửi webhook, backend kiểm tra chữ ký, lưu vào database và báo cho các trình duyệt.
- **Chống vòng lặp:** thay đổi do app gây ra sẽ dội lại qua webhook. Backend so sánh nội dung với bản đang lưu, giống nhau thì bỏ qua, nên không báo lại và không lặp vô hạn. Webhook đến muộn (cũ hơn dữ liệu đang lưu) cũng bị bỏ qua.
- **Lần đầu kết nối repo:** lấy toàn bộ issue có sẵn, tạo các nhãn chuẩn (`bug`, `enhancement`, `task`) nếu repo chưa có, đăng ký webhook.

### Cột Kanban lưu thế nào trên GitHub

GitHub chỉ có 2 trạng thái (mở và đóng) nên hệ thống quy ước:

| Cột | Trên GitHub |
| --- | --- |
| Cần làm | Issue đang mở |
| Đang làm | Issue đang mở và có nhãn `in progress` |
| Hoàn thành | Issue đã đóng |

Nhãn `in progress` do hệ thống tự tạo và được ẩn khỏi danh sách nhãn trả cho giao diện.

### Phát hiện issue trùng

1. Nội dung issue (tiêu đề và mô tả) được đổi thành vector 768 chiều bằng Gemini Embedding, lưu trong cột `embedding` (pgvector). Việc này chạy nền sau khi kết nối repo và mỗi khi nội dung issue đổi.
2. Khi tạo issue mới, backend đổi nội dung đang gõ thành vector rồi để pgvector chọn tối đa 3 issue gần giống nhất (độ giống từ `DUPLICATE_MIN_SIMILARITY` trở lên).
3. LLM đọc nội dung chữ của issue mới và các ứng viên, kết luận có trùng không kèm lý do. Số issue LLM trả về mà không nằm trong danh sách ứng viên sẽ bị loại.

Nếu không có ứng viên nào đủ giống thì không gọi LLM, để tiết kiệm lượt gọi của gói miễn phí.

### Báo cáo tuần

Backend lấy dữ liệu từ database (issue đã xong trong tuần, đang làm, chưa bắt đầu, ai phụ trách), gửi cho LLM viết thành một đoạn văn. Chỉ owner được bấm tạo; báo cáo tạo xong thì mọi thành viên đọc được.

## API

Lỗi trả về dạng `{ "statusCode": ..., "message": "..." }`. Mọi API (trừ đăng nhập và webhook) cần cookie đăng nhập.

| Method | Đường dẫn | Mục đích | Quyền |
| --- | --- | --- | --- |
| GET | `/auth/github` | Bắt đầu đăng nhập (chuyển sang GitHub) | |
| GET | `/auth/github/callback` | GitHub chuyển về đây, đặt cookie | |
| GET | `/auth/me` | Người dùng hiện tại (401 nếu chưa đăng nhập) | |
| POST | `/auth/logout` | Đăng xuất | |
| GET | `/repositories` | Repo của người dùng, kèm `isConnected`, `canManage` | |
| GET | `/repositories/:repoId` | Chi tiết một repo | |
| POST | `/repositories/:repoId/connect` | Kết nối repo | Owner |
| GET | `/repositories/:repoId/issues` | Toàn bộ issue | Thành viên |
| GET | `/repositories/:repoId/issues/:number` | Chi tiết issue | Thành viên |
| POST | `/repositories/:repoId/issues` | Tạo issue (tạo trên GitHub) | Thành viên |
| PATCH | `/repositories/:repoId/issues/:number` | Sửa tiêu đề, mô tả, nhãn, người được giao | Thành viên |
| PATCH | `/repositories/:repoId/issues/:number/status` | Đổi cột, body `{ "status": "todo" \| "in_progress" \| "done" }` | Thành viên |
| GET | `/repositories/:repoId/dashboard?weekStart=` | Thống kê theo tuần | Thành viên |
| GET | `/repositories/:repoId/ai/weekly-summary` | Báo cáo gần nhất (404 nếu chưa có) | Thành viên |
| POST | `/repositories/:repoId/ai/weekly-summary` | Tạo báo cáo mới | Owner |
| POST | `/repositories/:repoId/ai/duplicate-check` | Kiểm tra trùng, body `{ title, body? }` | Thành viên |
| POST | `/webhooks/github` | Nhận webhook của GitHub (kiểm tra chữ ký) | |

### Socket.io

Cùng cổng với backend, cần cookie đăng nhập (người chưa đăng nhập bị từ chối kết nối). Client gửi `repo:subscribe` / `repo:unsubscribe` kèm `repoId` để vào hoặc rời phòng của repo (chỉ thành viên mới vào được). Server đẩy xuống `issue:created`, `issue:updated` (`{ repoId, issue }`) và `issue:deleted` (`{ repoId, number }`).

## Kiểm thử

```bash
npm test
```

Các test chạy ngay, không cần database hay mạng: kiểm tra logic chia tuần, suy ra cột Kanban, mã hóa token, đọc cấu hình, đăng nhập, phân quyền owner, nhận webhook (chữ ký, chống vòng lặp, webhook đến muộn), Socket.io (chặn người chưa đăng nhập, phòng theo repo).

Test tích hợp với database thật (gồm các câu SQL pgvector) mặc định bị bỏ qua. Chạy bằng một database **riêng cho test** (test sẽ xóa dữ liệu trong đó), đã chạy `db:push`:

```bash
TEST_DATABASE_URL="postgresql://..." npm test -- integration
```

## Lưu ý

- Gói Gemini miễn phí có giới hạn số lần gọi và nội dung gửi qua có thể được Google dùng để cải thiện sản phẩm, nên chỉ dùng repo demo hoặc repo công khai. Cần kiểm tra lại gói miễn phí hiện tại có áp dụng cho model embedding không; nếu không thì chức năng phát hiện trùng cần khóa có thanh toán hoặc đổi sang model embedding chạy trên máy.
- Khi đổi `GEMINI_EMBEDDING_MODEL` sang model khác, các vector đã lưu không còn so sánh được với nhau; cần đặt cột `embedding` của bảng `Issue` về `NULL` để hệ thống tạo lại.
- Quyền GitHub xin khi đăng nhập là `repo` (đọc và ghi issue, đăng ký webhook, gồm cả repo riêng tư). Đây là quyền rộng; nếu muốn hẹp hơn có thể chuyển sang GitHub App ở giai đoạn sau.
- Khi chạy thật với frontend và backend khác tên miền, đặt `NODE_ENV=production` để cookie dùng `SameSite=None; Secure` (cần HTTPS).

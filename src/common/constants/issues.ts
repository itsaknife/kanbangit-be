/** Nhãn dùng để biểu diễn cột "Đang làm" trên GitHub (GitHub chỉ có 2 trạng thái open/closed). */
export const IN_PROGRESS_LABEL = 'in progress';

/** Bộ nhãn chuẩn, tự tạo trên repository nếu chưa có. */
export const STANDARD_LABELS = [
  { name: 'bug', color: 'd73a4a', description: 'Lỗi cần sửa' },
  { name: 'enhancement', color: 'a2eeef', description: 'Cải tiến chức năng' },
  { name: 'task', color: '0e8a16', description: 'Công việc cần làm' },
] as const;

export const IN_PROGRESS_LABEL_DEFINITION = {
  name: IN_PROGRESS_LABEL,
  color: 'fbca04',
  description: 'Đang thực hiện (dùng cho bảng Kanban)',
} as const;

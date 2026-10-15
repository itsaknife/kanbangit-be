import { IsOptional, Matches } from 'class-validator';

export class GenerateSummaryDto {
  /** Ngày trong tuần cần báo cáo (yyyy-MM-dd). Bỏ trống = tuần này. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'weekStart phải có dạng yyyy-MM-dd' })
  weekStart?: string;
}

import {
  IsUUID,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PlanningDto } from './planning.dto.js';

export class CreateIssueDto extends PlanningDto {
  @IsUUID()
  trackerId!: string;
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(65000)
  body?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  /** Tên tài khoản GitHub của người được giao. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assignees?: string[];

  /** Hạn hoàn thành nội bộ của Kanbangit, không đồng bộ sang GitHub. */
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

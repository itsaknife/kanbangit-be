import {
  IsUUID,
  ValidateIf,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateIssueDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  trackerId?: string;
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(65000)
  body?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assignees?: string[];

  /** Hạn hoàn thành nội bộ của Kanbangit, không đồng bộ sang GitHub. */
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

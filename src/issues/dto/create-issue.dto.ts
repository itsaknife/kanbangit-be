import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateIssueDto {
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
}

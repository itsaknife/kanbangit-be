import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
export class CreateWorklogDto {
  @IsISO8601({ strict: true }) startAt!: string;
  @IsISO8601({ strict: true }) endAt!: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsUUID() memberId?: string;
}
export class UpdateWorklogDto {
  @IsISO8601({ strict: true }) startAt!: string;
  @IsISO8601({ strict: true }) endAt!: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
}
export class WorklogQuery {
  @IsOptional() @IsUUID() issueId?: string;
  @IsOptional() @IsUUID() memberId?: string;
  @IsOptional() @IsIn(['all', 'week', 'month', 'custom']) period?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

import { IsEnum, IsInt, IsOptional, IsUUID, Min, Max, Matches } from 'class-validator';
import { IssueStatus } from '../../generated/prisma/client.js';

export class PlanningDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate?: string | null;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(5256000) estimateMinutes?: number | null;
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsUUID() assigneeId?: string | null;
  @IsOptional() @IsEnum(IssueStatus) status?: IssueStatus;
}

export class ParentDto {
  @IsUUID() parentId!: string;
}

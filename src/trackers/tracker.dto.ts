import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  ValidateIf,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
export class CreateTrackerDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;
  @Matches(/^[A-Z][A-Z0-9]{1,11}$/) prefix!: string;
  @Matches(/^#[0-9a-fA-F]{6}$/) color!: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(10000)
  displayOrder?: number;
}
export class UpdateTrackerDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @Matches(/^[A-Z][A-Z0-9]{1,11}$/)
  prefix?: string;
  @ValidateIf((_object, value) => value !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) color?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(10000)
  displayOrder?: number;
}
export class ActiveTrackerDto {
  @IsBoolean() isActive!: boolean;
}
export class ChangeIssueTrackerDto {
  @IsUUID() trackerId!: string;
}

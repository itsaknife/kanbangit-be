import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class DuplicateCheckDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  body?: string;
}

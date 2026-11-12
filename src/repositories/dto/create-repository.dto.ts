import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateRepositoryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(350)
  description?: string;

  @IsIn(['PUBLIC', 'PRIVATE'])
  visibility!: 'PUBLIC' | 'PRIVATE';
}

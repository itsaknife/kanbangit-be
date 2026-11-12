import { IsString, IsUUID, Matches } from 'class-validator';
export class ImportRepositoryDto {
  @IsString() @Matches(/^[1-9]\d*$/) githubId!: string;
}
export class TransferOwnerDto {
  @IsUUID() memberId!: string;
}

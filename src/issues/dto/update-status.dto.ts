import { IsIn } from 'class-validator';
import { IssueStatus } from '../../generated/prisma/client.js';

export class UpdateStatusDto {
  @IsIn(Object.values(IssueStatus))
  status!: IssueStatus;
}

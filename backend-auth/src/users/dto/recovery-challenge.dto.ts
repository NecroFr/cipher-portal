import { IsString, IsNotEmpty } from 'class-validator';

export class RecoveryChallengeDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}

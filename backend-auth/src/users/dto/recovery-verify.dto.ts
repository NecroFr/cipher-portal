import { IsString, IsNotEmpty, IsObject } from 'class-validator';

export class RecoveryVerifyDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  /**
   * Map of 1-based word index → submitted word.
   * Example: { "4": "table", "11": "house" }
   */
  @IsObject()
  words: Record<number, string>;
}

import { IsString, IsInt, Min, Max, IsNotEmpty } from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsInt()
  @Min(1)
  @Max(150)
  age: number;
}

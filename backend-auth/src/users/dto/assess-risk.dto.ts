import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsNumber,
  IsLatitude,
  IsLongitude,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

export class GeoDto {
  @IsNumber()
  @IsLatitude()
  lat: number;

  @IsNumber()
  @IsLongitude()
  lon: number;

  @IsString()
  @IsNotEmpty()
  country: string;
}

export class AssessRiskDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  /**
   * Client's best-effort IP address.
   * Made optional so that browsers behind NAT / CGNAT or
   * when the geo-IP lookup fails can still call this endpoint
   * without a validation error. The safe-score engine treats
   * a missing IP as a neutral signal (no VPN deduction, etc.)
   */
  @IsString()
  @IsOptional()
  currentIp?: string;

  /**
   * Best-effort geo context.  Optional — the frontend collects
   * this from ipapi.co; if that call fails the field is omitted
   * and the safe-score engine skips geo-based rules.
   */
  @ValidateNested()
  @Type(() => GeoDto)
  @IsOptional()
  currentGeo?: GeoDto;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  browserExtensions?: string[];

  @IsString()
  @IsOptional()
  userAgent?: string;
}

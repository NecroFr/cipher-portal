import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeoLocation {
  lat: number;
  lon: number;
  country: string;
}

export interface AssessmentContext {
  userId: string;
  currentIp?: string;
  currentGeo?: GeoLocation;
  browserExtensions: string[];
  userAgent: string;
  hasPasskeyRegistered: boolean;
}

export interface SafeScoreBreakdown {
  finalScore: number;
  deductions: Record<string, number>;
  flags: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Known VPN / Tor / public-cloud IPv4 CIDR ranges (mock list).
 * In production replace with a live feed (e.g. MaxMind, ipinfo.io, AbuseIPDB).
 */
const SUSPICIOUS_CIDRS: Array<{ base: number; mask: number; label: string }> = [
  // Tor exit nodes (illustrative ranges)
  cidr('185.220.101.0/24', 'Tor'),
  cidr('185.220.102.0/23', 'Tor'),
  // Common datacenter / VPN ranges
  cidr('104.16.0.0/12', 'Cloudflare/VPN'),
  cidr('198.41.128.0/17', 'Cloudflare/VPN'),
  cidr('10.0.0.0/8', 'PrivateNet'),
  cidr('172.16.0.0/12', 'PrivateNet'),
  cidr('192.168.0.0/16', 'PrivateNet'),
];

/**
 * Extension IDs / names known to be used for debugging, scraping, or
 * credential interception.  Case-insensitive substring match.
 */
const SUSPICIOUS_EXTENSIONS: string[] = [
  'react devtools',
  'vue devtools',
  'redux devtools',
  'metamask',        // crypto wallet — not inherently malicious, but flag it
  'grammarly',       // reads page content
  'lastpass',        // password manager — potential autofill abuse
  'dashlane',
  'web scraper',
  'tampermonkey',
  'greasemonkey',
  'requestly',
  'modheader',
];

const MAX_TRAVEL_SPEED_KMH = 800; // commercial aircraft upper bound

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SafeScoreService {
  private readonly logger = new Logger(SafeScoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluates a composite "Safe Score" for a login attempt.
   *
   * Base score is 100 — deductions are applied per rule.
   * Final value is clamped [0, 100].  If the user has no registered passkey
   * the score is additionally capped at 75 (Moderate tier).
   *
   * @returns A score between 0 and 100 (higher = safer).
   */
  async evaluateSafeScore(ctx: AssessmentContext): Promise<number> {
    const { finalScore } = await this.evaluateWithBreakdown(ctx);
    return finalScore;
  }

  /**
   * Same as `evaluateSafeScore` but also returns per-rule deductions and
   * human-readable flags — useful for audit logs and debugging.
   */
  async evaluateWithBreakdown(
    ctx: AssessmentContext,
  ): Promise<SafeScoreBreakdown> {
    let score = 100;
    const deductions: Record<string, number> = {};
    const flags: string[] = [];

    // ── Collect rule results for the log table ────────────────────────────
    const ruleResults: Array<{
      rule: string;
      triggered: boolean;
      detail: string;
      deduction: number;
    }> = [];

    // Fetch last 10 login events for this user (most recent first)
    const recentEvents = await this.prisma.loginEvent.findMany({
      where: { userId: ctx.userId },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });

    // ── Rule 1: Recent Failed Attempts ────────────────────────────────────
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentFailures = recentEvents.filter(
      (e) => !e.successful && new Date(e.timestamp) >= oneHourAgo,
    );
    if (recentFailures.length >= 3) {
      let pts = 10;
      if (recentFailures.length >= 6) pts += 15;
      score -= pts;
      deductions['recentFailedAttempts'] = pts;
      flags.push(`${recentFailures.length} failed logins in the last hour`);
      ruleResults.push({
        rule: 'Recent Failed Attempts',
        triggered: true,
        detail: `${recentFailures.length} failures in last hour (threshold ≥3)`,
        deduction: pts,
      });
    } else {
      ruleResults.push({
        rule: 'Recent Failed Attempts',
        triggered: false,
        detail: `${recentFailures.length} failure(s) in last hour — OK`,
        deduction: 0,
      });
    }

    // ── Rule 2: Novel Country ─────────────────────────────────────────────
    if (ctx.currentGeo) {
      const successfulEvents = recentEvents.filter((e) => e.successful);
      const seenCountries = new Set(
        successfulEvents.map((e) => this._parseCountry(e.location)),
      );

      if (seenCountries.size > 0 && !seenCountries.has(ctx.currentGeo.country)) {
        const pts = 20;
        score -= pts;
        deductions['novelCountry'] = pts;
        flags.push(`First login from country: ${ctx.currentGeo.country}`);
        ruleResults.push({
          rule: 'Novel Country',
          triggered: true,
          detail: `${ctx.currentGeo.country} not in history [${[...seenCountries].join(', ')}]`,
          deduction: pts,
        });
      } else {
        ruleResults.push({
          rule: 'Novel Country',
          triggered: false,
          detail: seenCountries.size === 0
            ? 'No login history yet — rule skipped'
            : `${ctx.currentGeo.country} matches known history [${[...seenCountries].join(', ')}]`,
          deduction: 0,
        });
      }

      // ── Rule 3: Impossible Travel ───────────────────────────────────────
      const lastSuccess = successfulEvents[0];
      if (lastSuccess) {
        const lastGeo = this._parseGeo(lastSuccess.location);
        if (lastGeo) {
          const distKm = this._haversineKm(lastGeo, ctx.currentGeo);
          const elapsedHours =
            (Date.now() - new Date(lastSuccess.timestamp).getTime()) /
            (1000 * 60 * 60);
          const speedKmh = elapsedHours > 0 ? distKm / elapsedHours : Infinity;
          if (speedKmh > MAX_TRAVEL_SPEED_KMH) {
            const pts = 20;
            score -= pts;
            deductions['impossibleTravel'] = pts;
            flags.push(
              `Impossible travel detected: ${Math.round(speedKmh)} km/h from last login location`,
            );
            ruleResults.push({
              rule: 'Impossible Travel',
              triggered: true,
              detail: `${Math.round(distKm)} km in ${elapsedHours.toFixed(2)}h = ${Math.round(speedKmh)} km/h (limit: ${MAX_TRAVEL_SPEED_KMH} km/h)`,
              deduction: pts,
            });
          } else {
            ruleResults.push({
              rule: 'Impossible Travel',
              triggered: false,
              detail: `${Math.round(distKm)} km in ${elapsedHours.toFixed(2)}h = ${Math.round(speedKmh)} km/h — OK`,
              deduction: 0,
            });
          }
        } else {
          ruleResults.push({ rule: 'Impossible Travel', triggered: false, detail: 'Last location unparseable — skipped', deduction: 0 });
        }
      } else {
        ruleResults.push({ rule: 'Impossible Travel', triggered: false, detail: 'No prior successful login — skipped', deduction: 0 });
      }
    } else {
      ruleResults.push({ rule: 'Novel Country',     triggered: false, detail: 'No geo context provided — skipped', deduction: 0 });
      ruleResults.push({ rule: 'Impossible Travel', triggered: false, detail: 'No geo context provided — skipped', deduction: 0 });
    }

    if (ctx.currentIp) {
      const vpnLabel = this._matchCidr(ctx.currentIp);
      const isNovelCountry = !!deductions['novelCountry'];

      if (vpnLabel || isNovelCountry) {
        const pts = 20;
        score -= pts;
        deductions['vpnOrTorDetected'] = pts;
        const reason = vpnLabel
          ? `VPN detected (${vpnLabel})`
          : `Inferred from Novel Country detection`;

        flags.push(reason);
        ruleResults.push({
          rule: 'VPN / Tor / Cloud IP',
          triggered: true,
          detail: reason,
          deduction: pts,
        });
      } else {
        ruleResults.push({
          rule: 'VPN / Tor / Cloud IP',
          triggered: false,
          detail: `No VPN detected`,
          deduction: 0,
        });
      }
    } else {
      ruleResults.push({ rule: 'VPN / Tor / Cloud IP', triggered: false, detail: 'No IP provided — skipped', deduction: 0 });
    }

    // ── Rule 5: Suspicious Browser Extensions ────────────────────────────
    const suspiciousFound = ctx.browserExtensions.filter((ext) =>
      SUSPICIOUS_EXTENSIONS.some((s) =>
        ext.toLowerCase().includes(s.toLowerCase()),
      ),
    );
    if (suspiciousFound.length > 0) {
      const pts = 5;
      score -= pts;
      deductions['suspiciousExtensions'] = pts;
      flags.push(`Suspicious extensions: ${suspiciousFound.join(', ')}`);
      ruleResults.push({
        rule: 'Suspicious Extensions',
        triggered: true,
        detail: `Detected: ${suspiciousFound.join(', ')}`,
        deduction: pts,
      });
    } else {
      ruleResults.push({
        rule: 'Suspicious Extensions',
        triggered: false,
        detail: ctx.browserExtensions.length === 0
          ? 'None detected'
          : `Checked ${ctx.browserExtensions.length} extension(s) — all clean`,
        deduction: 0,
      });
    }

    // ── Rule 6: No Passkey — Cap at 75 ───────────────────────────────────
    if (!ctx.hasPasskeyRegistered && score > 75) {
      const cappedFrom = score;
      score = 75;
      deductions['noPasskeyCap'] = 0; // not a deduction — a ceiling
      flags.push('No passkey registered — score capped at 75 (Moderate)');
      ruleResults.push({
        rule: 'No Passkey Cap',
        triggered: true,
        detail: `Score was ${cappedFrom} — capped to 75 (no registered passkey)`,
        deduction: cappedFrom - 75,
      });
    } else {
      ruleResults.push({
        rule: 'No Passkey Cap',
        triggered: false,
        detail: ctx.hasPasskeyRegistered
          ? 'Passkey registered — no cap applied'
          : `Score ${score} ≤ 75 — cap not needed`,
        deduction: 0,
      });
    }

    // ── Rule 7: Trust Decay — penalise inactivity ────────────────────────
    // Deduct 1pt for every 4 complete days since the last successful login,
    // up to a maximum of 25 points.  Brand-new accounts (no history) are
    // unaffected so the first login is never unfairly penalised.
    const DECAY_DAYS_PER_POINT = 4;  // 1 point lost per N idle days
    const MAX_DECAY_PTS        = 25; // cap so long absence can't push score to 0 alone
    const lastSuccessForDecay  = recentEvents.find((e) => e.successful);
    if (lastSuccessForDecay) {
      const idleDays = Math.floor(
        (Date.now() - new Date(lastSuccessForDecay.timestamp).getTime()) /
        (1000 * 60 * 60 * 24),
      );
      const decayPts = Math.min(
        Math.floor(idleDays / DECAY_DAYS_PER_POINT),
        MAX_DECAY_PTS,
      );
      if (decayPts > 0) {
        score -= decayPts;
        deductions['trustDecay'] = decayPts;
        flags.push(`Trust decay: ${idleDays} idle days → -${decayPts} pts`);
        ruleResults.push({
          rule: 'Trust Decay (idle)',
          triggered: true,
          detail: `${idleDays} days idle ÷ ${DECAY_DAYS_PER_POINT} = -${decayPts} pts (max ${MAX_DECAY_PTS})`,
          deduction: decayPts,
        });
      } else {
        ruleResults.push({
          rule: 'Trust Decay (idle)',
          triggered: false,
          detail: `${idleDays} idle day(s) — below ${DECAY_DAYS_PER_POINT}-day threshold`,
          deduction: 0,
        });
      }
    } else {
      ruleResults.push({
        rule: 'Trust Decay (idle)',
        triggered: false,
        detail: 'No prior successful login — decay skipped',
        deduction: 0,
      });
    }

    const finalScore = Math.max(0, Math.min(100, score));

    // ── Emit rich structured log ──────────────────────────────────────────
    const W_RULE = 26;
    const W_STATUS = 9;
    const W_DEDUCT = 9;
    const W_DETAIL = 52;
    const totalWidth = W_RULE + W_STATUS + W_DEDUCT + W_DETAIL + 7; // +7 for separators

    const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
    const padL = (s: string, n: number) => s.slice(0, n).padStart(n);
    const line = '─'.repeat(totalWidth);
    const dline = '═'.repeat(totalWidth);

    const header = [
      `╔${dline}╗`,
      `║  🔐 SAFE SCORE — ${ctx.userId.padEnd(totalWidth - 19)}║`,
      `╠${dline}╣`,
      `║  IP : ${(ctx.currentIp ?? 'n/a').padEnd(20)}  ` +
        `Geo : ${ctx.currentGeo ? `${ctx.currentGeo.country} (${ctx.currentGeo.lat.toFixed(2)},${ctx.currentGeo.lon.toFixed(2)})` : 'n/a'}`.padEnd(totalWidth - 30) + `║`,
      `║  UA : ${(ctx.userAgent ?? 'n/a').slice(0, totalWidth - 8).padEnd(totalWidth - 8)}║`,
      `║  Extensions : ${(ctx.browserExtensions.join(', ') || 'none').slice(0, totalWidth - 17).padEnd(totalWidth - 17)}║`,
      `║  Passkey    : ${(ctx.hasPasskeyRegistered ? '✅ Registered' : '❌ Not registered').padEnd(totalWidth - 17)}║`,
      `╠${dline}╣`,
      `║  ${'RULE'.padEnd(W_RULE)} │ ${'STATUS'.padEnd(W_STATUS)} │ ${padL('DEDUCT', W_DEDUCT)} │ ${'DETAIL'.padEnd(W_DETAIL)} ║`,
      `║  ${line}║`,
    ];

    const rows = ruleResults.map((r) => {
      const statusStr = r.triggered ? '⚠ FIRED' : '✓ PASS';
      const deductStr = r.triggered ? `-${r.deduction}`.padStart(W_DEDUCT) : '—'.padStart(W_DEDUCT);
      return `║  ${pad(r.rule, W_RULE)} │ ${pad(statusStr, W_STATUS)} │ ${deductStr} │ ${pad(r.detail, W_DETAIL)} ║`;
    });

    const totalDeducted = Object.values(deductions).reduce((a, b) => a + b, 0);
    const flowLabel =
      finalScore >= 80 ? '✅ HIGH  — Passkey direct' :
      finalScore >= 40 ? '⚠️  MODERATE — Secondary verify' :
                         '🚨 LOW   — Notification only';

    const footer = [
      `║  ${line}║`,
      `║  ${'Base score'.padEnd(W_RULE)} │ ${''.padEnd(W_STATUS)} │ ${padL('+100', W_DEDUCT)} │ ${'Starting value'.padEnd(W_DETAIL)} ║`,
      `║  ${'Total deductions'.padEnd(W_RULE)} │ ${''.padEnd(W_STATUS)} │ ${padL(`-${totalDeducted}`, W_DEDUCT)} │ ${'Sum of all triggered rules'.padEnd(W_DETAIL)} ║`,
      `║  ${'FINAL SCORE'.padEnd(W_RULE)} │ ${''.padEnd(W_STATUS)} │ ${padL(`${finalScore}`, W_DEDUCT)} │ ${flowLabel.padEnd(W_DETAIL)} ║`,
      `╚${dline}╝`,
    ];

    const fullLog = [...header, ...rows, ...footer].join('\n');
    this.logger.log('\n' + fullLog);

    return { finalScore, deductions, flags };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Haversine formula — great-circle distance between two lat/lon points in km.
   */
  private _haversineKm(a: GeoLocation, b: GeoLocation): number {
    const R = 6371; // Earth radius in km
    const dLat = this._toRad(b.lat - a.lat);
    const dLon = this._toRad(b.lon - a.lon);
    const sinDlat = Math.sin(dLat / 2);
    const sinDlon = Math.sin(dLon / 2);
    const h =
      sinDlat * sinDlat +
      Math.cos(this._toRad(a.lat)) *
        Math.cos(this._toRad(b.lat)) *
        sinDlon * sinDlon;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  private _toRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  /**
   * Match an IPv4 string against SUSPICIOUS_CIDRS.
   * Returns the label of the first matching range, or null.
   */
  private _matchCidr(ip: string): string | null {
    const ipNum = this._ipToNumber(ip);
    if (ipNum === null) return null;
    for (const { base, mask, label } of SUSPICIOUS_CIDRS) {
      if ((ipNum & mask) === base) return label;
    }
    return null;
  }

  private _ipToNumber(ip: string): number | null {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
      return null;
    return (
      ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>>
      0
    );
  }

  /**
   * Parse a country code from a stored location string.
   * Stored format (from LoginEvent): "lat,lon,COUNTRY"  e.g. "51.5,-0.12,GB"
   */
  private _parseCountry(location: string): string {
    return location.split(',')[2]?.trim() ?? '';
  }

  /**
   * Parse lat/lon from a stored location string.
   * Returns null if the format is unrecognised.
   */
  private _parseGeo(location: string): GeoLocation | null {
    const parts = location.split(',');
    if (parts.length < 3) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const country = parts[2]?.trim() ?? '';
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon, country };
  }
}

// ─── CIDR Helper (module-level) ───────────────────────────────────────────────

function cidr(
  notation: string,
  label: string,
): { base: number; mask: number; label: string } {
  const [ipStr, prefixStr] = notation.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const ipParts = ipStr.split('.').map(Number);
  const base =
    (((ipParts[0] << 24) |
      (ipParts[1] << 16) |
      (ipParts[2] << 8) |
      ipParts[3]) >>>
      0) & mask;
  return { base, mask, label };
}

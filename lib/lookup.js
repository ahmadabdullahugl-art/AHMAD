import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

const MULTI_LABEL_SUFFIXES = new Set([
  'ac.uk', 'co.in', 'co.jp', 'co.nz', 'co.uk', 'com.au', 'com.br', 'com.mx',
  'com.sg', 'net.au', 'org.au', 'org.uk'
]);
const COMPANY_NAME_NOISE = new Set(['AND', 'CO', 'COMPANY', 'CORP', 'CORPORATION', 'INC', 'INCORPORATED', 'LLC', 'LP', 'LTD', 'LIMITED', 'THE']);

function normalizeCompanyName(value) {
  return String(value ?? '').normalize('NFKD').toUpperCase()
    .replace(/\b(?:[A-Z]\.\s*){2,}/g, (initials) => `${initials.replace(/[.\s]/g, '')} `)
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function getCompanyNameTokens(value) {
  return normalizeCompanyName(value).split(/\s+/)
    .filter((token) => token.length > 1 && !COMPANY_NAME_NOISE.has(token));
}

export function companyNamesMatch(expected, actual) {
  const expectedTokens = getCompanyNameTokens(expected);
  const actualTokens = new Set(getCompanyNameTokens(actual));
  if (!expectedTokens.length || !actualTokens.size) return false;
  const shared = expectedTokens.filter((token) => actualTokens.has(token)).length;
  return shared > 0 && shared / expectedTokens.length >= 0.8;
}

export function parseDomain(input) {
  const value = String(input ?? '').trim();
  if (!value || value.length > 2048) throw new Error('Enter a company website domain.');

  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error('Enter a valid domain, such as example.com.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Enter a domain without a port or sign-in details.');
  }

  const hostname = domainToASCII(url.hostname.replace(/\.$/, '').replace(/^www\./i, '').toLowerCase());
  if (!hostname || isIP(hostname) || hostname === 'localhost' || !hostname.includes('.')) {
    throw new Error('Enter a public company domain, such as example.com.');
  }

  const labels = hostname.split('.');
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) {
    throw new Error('Enter a valid domain, such as example.com.');
  }

  return hostname;
}

export function parseCompanyName(input) {
  const companyName = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (companyName.length < 2 || !/\p{L}/u.test(companyName)) {
    throw new Error('Enter a company name with at least two characters.');
  }
  if (companyName.length > 120) throw new Error('Company names must be 120 characters or fewer.');
  return companyName;
}

export function parseCarrierIdentifier(input, kind) {
  const prefix = kind === 'MC' ? '(?:MC\\s*[-:#]?\\s*)?' : '(?:(?:USDOT|US\\s*DOT|DOT)\\s*[-:#]?\\s*)?';
  const value = String(input ?? '').trim();
  const match = value.match(new RegExp(`^${prefix}(\\d{1,10})$`, 'i'));
  if (!match || !['MC', 'DOT'].includes(kind)) {
    throw new Error(`Enter a valid ${kind === 'MC' ? 'MC' : 'DOT'} number.`);
  }
  const number = match[1].replace(/^0+/, '') || '0';
  if (kind === 'MC' && number.length < 4) throw new Error('Enter a valid MC number.');
  return number;
}

export function extractIdentifiers(html, foundOn) {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&');
  const found = new Map();

  for (const [kind, pattern] of [
    ['MC', /\bMC\s*(?:(?:NO\.?|NUMBER|#)\s*)?[-:#]?\s*(\d{4,8})\b/gi],
    ['DOT', /\b(?:USDOT|US\s*DOT|DOT)\s*(?:(?:NO\.?|NUMBER|#)\s*)?[-:#]?\s*(\d{5,9})\b/gi]
  ]) {
    for (const match of text.matchAll(pattern)) {
      const number = match[1];
      found.set(`${kind}:${number}`, { kind, number, foundOn });
    }
  }

  return [...found.values()];
}

export function parseSaferSnapshot(html) {
  if (/RECORD NOT FOUND|No records matching/i.test(html)) return null;

  const stripMarkup = (value) => value.replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, ' ').trim();
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) ?? [];
  const getValue = (label) => {
    const row = rows.find((candidate) => stripMarkup(candidate).toLowerCase().includes(label.toLowerCase()));
    const cell = row?.match(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/i)?.[1];
    return cell ? stripMarkup(cell) : '';
  };

  const titleName = html.match(/<title\b[^>]*>SAFER Web - Company Snapshot\s+([^<]+)<\/title/i)?.[1] ?? '';
  const dotNumber = getValue('USDOT Number:').replace(/\D/g, '');
  const mcCell = getValue('MC/MX/FF Number(s):');
  const mcNumbers = [...mcCell.matchAll(/\bMC\s*[-:]?\s*(\d+)\b/gi)].map((match) => match[1].replace(/^0+/, ''));
  const authorityStatus = getValue('Operating Authority Status:');

  if (!dotNumber && !mcNumbers.length) return null;
  return {
    legalName: stripMarkup(titleName),
    dotNumber,
    mcNumbers,
    phoneNumber: getValue('Phone:') || null,
    authorityStatus,
    brokerAuthorized: !/NOT AUTHORIZED|OUT-OF-SERVICE/i.test(authorityStatus) &&
      /AUTHORIZED FOR/i.test(authorityStatus) && /\bBroker of\b/i.test(authorityStatus)
  };
}

export function applySaferVerification(match, snapshot) {
  if (!snapshot) return { ...match, saferVerified: false, saferStatus: 'not found' };
  const sameDot = snapshot.dotNumber === match.dotNumber;
  const sameMc = snapshot.mcNumbers.includes(match.docketNumber.slice(2));
  const sameName = companyNamesMatch(match.legalName || match.dbaName, snapshot.legalName);
  if (!sameDot || !sameMc) return { ...match, saferVerified: false, saferStatus: 'ID mismatch' };
  if (!sameName) return { ...match, saferVerified: false, saferStatus: 'Company name mismatch' };

  return {
    ...match,
    legalName: snapshot.legalName || match.legalName,
    phoneNumber: snapshot.phoneNumber || match.phoneNumber,
    saferVerified: snapshot.brokerAuthorized,
    saferStatus: snapshot.brokerAuthorized ? 'SAFER confirmed' : 'No broker authority'
  };
}

export function matchFmcsaRecords(companyName, records, websiteIdentifiers = []) {
  const targetTokens = getCompanyNameTokens(companyName);
  const normalizeId = (number) => String(number ?? '').replace(/\D/g, '').replace(/^0+/, '') || '0';
  const websiteNumbers = new Set(websiteIdentifiers.map((item) => `${item.kind}:${normalizeId(item.number)}`));
  if (!targetTokens.length && !websiteNumbers.size) return [];

  const matches = records.flatMap((record) => {
    if (String(record.status_code ?? '').toUpperCase() !== 'A' || !record.legal_name && !record.dba_name) return [];

    const legalName = String(record.legal_name ?? '').trim();
    const dbaName = String(record.dba_name ?? '').trim();
    const nameCandidates = [legalName, dbaName].map((name) => {
      const tokens = getCompanyNameTokens(name);
      const sharedCount = targetTokens.filter((token) => tokens.includes(token)).length;
      const coverage = sharedCount / targetTokens.length;
      const precision = tokens.length ? sharedCount / tokens.length : 0;
      return { score: coverage && precision ? (2 * coverage * precision) / (coverage + precision) : 0, coverage };
    });
    const bestNameMatch = nameCandidates.sort((left, right) => right.score - left.score)[0];

    const dotNumber = String(record.dot_number ?? '').replace(/^0+/, '') || '0';
    const dockets = [1, 2, 3].flatMap((number) => {
      const prefix = String(record[`docket${number}prefix`] ?? '').trim().toUpperCase();
      const docket = String(record[`docket${number}`] ?? '').trim();
      return prefix === 'MC' && /^\d+$/.test(docket) ? [`MC${docket}`] : [];
    });
    const verifiedDockets = dockets.filter((docket) => websiteNumbers.has(`MC:${normalizeId(docket.slice(2))}`) || websiteNumbers.has(`DOT:${normalizeId(dotNumber)}`));
    if (!verifiedDockets.length && (bestNameMatch.coverage < 0.6 || bestNameMatch.score < 0.55)) return [];

    return dockets.map((docketNumber) => {
      const websiteNumberVerified = verifiedDockets.includes(docketNumber);
      const websiteEvidence = websiteIdentifiers.find((item) =>
        item.kind === 'MC' && normalizeId(item.number) === normalizeId(docketNumber.slice(2)) ||
        item.kind === 'DOT' && normalizeId(item.number) === normalizeId(dotNumber));
      return {
        docketNumber,
        dotNumber,
        phoneNumber: String(record.phone ?? '').trim() || null,
        legalName,
        dbaName,
        websiteSourceUrl: websiteEvidence?.foundOn ?? null,
        websiteNumberVerified,
        matchStrength: websiteNumberVerified ? 'verified' : targetTokens.length === 1 || bestNameMatch.score < 0.9 ? 'possible' : 'strong',
        matchScore: websiteNumberVerified ? 1 : bestNameMatch.score
      };
    });
  });

  const uniqueMatches = new Map();
  for (const match of matches) {
    const key = `${match.docketNumber}:${match.dotNumber}`;
    if (!uniqueMatches.has(key) || uniqueMatches.get(key).matchScore < match.matchScore) uniqueMatches.set(key, match);
  }
  return [...uniqueMatches.values()].sort((left, right) => right.matchScore - left.matchScore ||
    left.legalName.localeCompare(right.legalName)).slice(0, 8);
}

export function mergeFmcsaMatches(...groups) {
  const merged = new Map();
  for (const match of groups.flat()) {
    const key = `${match.docketNumber}:${match.dotNumber}`;
    const existing = merged.get(key);
    const priority = (item) => Number(Boolean(item.websiteNumberVerified)) * 2 + Number(Boolean(item.saferVerified)) + (item.matchScore ?? 0);
    if (!existing || priority(match) > priority(existing)) merged.set(key, match);
  }
  return [...merged.values()].sort((left, right) =>
    Number(Boolean(right.websiteNumberVerified)) - Number(Boolean(left.websiteNumberVerified)) ||
    (right.matchScore ?? 0) - (left.matchScore ?? 0) || left.legalName.localeCompare(right.legalName)).slice(0, 8);
}

export function getOrganizationDomain(hostname) {
  const labels = hostname.split('.');
  const suffix = labels.slice(-2).join('.');
  const count = MULTI_LABEL_SUFFIXES.has(suffix) ? 3 : 2;
  return labels.length > count ? labels.slice(-count).join('.') : hostname;
}

export function inspectSpf(records) {
  const record = records.find((value) => /^v=spf1(?:\s|$)/i.test(value)) ?? null;
  const issues = [];
  if (!record) {
    return { status: 'fail', record: null, policy: null, dnsLookups: null, issues: ['No SPF record found for this domain.'] };
  }

  const tokens = record.trim().split(/\s+/).slice(1);
  const all = tokens.find((token) => /^[+~?-]?all$/i.test(token));
  const redirect = tokens.some((token) => /^redirect=/i.test(token));
  const policy = all ? `${all[0] || '+'}all` : redirect ? 'redirect' : null;
  const dnsLookups = tokens.filter((token) => /^(?:include:|a(?::|$)|mx(?::|$)|exists:|redirect=)/i.test(token)).length;
  let status = 'pass';

  if (dnsLookups > 10) {
    status = 'fail';
    issues.push(`The record has ${dnsLookups} DNS-based mechanisms; SPF permits at most 10 lookups.`);
  }
  if (!all && !redirect) {
    status = status === 'fail' ? status : 'warn';
    issues.push('The record does not end with an all or redirect policy.');
  } else if (all && !['-all', '+all'].includes(policy)) {
    status = status === 'fail' ? status : 'warn';
    issues.push(`${policy} does not explicitly reject unauthorized senders.`);
  } else if (policy === '+all') {
    status = 'fail';
    issues.push('+all authorizes any sender.');
  }

  return { status, record, policy, dnsLookups, issues };
}

export function inspectDmarc(record, foundAt = null) {
  if (!record) {
    return {
      status: 'fail', record: null, foundAt: null, policy: null,
      subdomainPolicy: null, pct: null, reporting: false,
      issues: ['No DMARC record found for this domain or its organizational domain.']
    };
  }

  const tags = new Map(record.split(';').map((part) => part.trim().split('=').map((value) => value.trim())).filter((part) => part.length === 2));
  const policyValue = tags.get('p')?.toLowerCase() ?? null;
  const valid = /^dmarc1$/i.test(tags.get('v') ?? '') && ['none', 'quarantine', 'reject'].includes(policyValue);
  const policy = valid ? policyValue : null;
  const issues = [];
  let status = 'pass';

  if (!valid) {
    status = 'fail';
    issues.push('The DMARC record is missing a valid version or policy tag.');
  } else if (policy === 'none') {
    status = 'warn';
    issues.push('The policy is monitoring-only and does not ask receivers to quarantine or reject spoofed mail.');
  }

  const pctValue = Number.parseInt(tags.get('pct') ?? '100', 10);
  const pct = Number.isFinite(pctValue) ? Math.min(100, Math.max(0, pctValue)) : 100;
  if (valid && pct < 100) {
    status = status === 'fail' ? status : 'warn';
    issues.push(`The policy applies to ${pct}% of messages.`);
  }

  return {
    status, record, foundAt, policy,
    subdomainPolicy: tags.get('sp')?.toLowerCase() ?? null,
    pct, reporting: Boolean(tags.get('rua') || tags.get('ruf')), issues
  };
}

export function getEmailVerdict(spf, dmarc) {
  if (spf.status === 'pass' && dmarc.status === 'pass') return 'protected';
  if (!spf.record && !dmarc.record) return 'exposed';
  if (spf.status === 'fail' && dmarc.status === 'fail') return 'exposed';
  return 'partial';
}
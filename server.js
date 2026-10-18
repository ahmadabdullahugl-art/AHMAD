import { createServer } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { lookup as lookupAddress } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySaferVerification, companyNamesMatch, extractIdentifiers, getCompanyNameTokens, matchFmcsaRecords, mergeFmcsaMatches,
  parseCarrierIdentifier, parseCompanyName, parseDomain, parseSaferSnapshot
} from './lib/lookup.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4173;
const CACHE_TTL = 10 * 60 * 1000;
const FMCSA_API = 'https://data.transportation.gov/resource/az4n-8mr2.json';
const FMCSA_DATASET_URL = 'https://data.transportation.gov/Trucking-and-Motorcoaches/Company-Census-File/az4n-8mr2';
const SAFER_QUERY_URL = 'https://safer.fmcsa.dot.gov/query.asp';
const cache = new Map();

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [first, second] = octets;
    return !(first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 168 || (second === 0 && [0, 2].includes(octets[2])))) ||
      (first === 198 && (second === 18 || second === 19 || (second === 51 && octets[2] === 100))) ||
      (first === 203 && second === 0 && octets[2] === 113));
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return isPublicAddress(mapped);
  }
  return !(normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
    normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff'));
}

async function assertPublicHost(hostname) {
  const addresses = await lookupAddress(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('That domain does not resolve exclusively to public web addresses.');
  }
  return addresses;
}

function isAllowedHost(hostname, originalHost) {
  return hostname === originalHost || hostname === `www.${originalHost}` ||
    (originalHost.startsWith('www.') && hostname === originalHost.slice(4));
}

async function readResponse(response, limit = 900_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) throw new Error('Page exceeded the scan size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchCompanyPage(target, originalHost) {
  let current = target;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!['http:', 'https:'].includes(current.protocol) || !isAllowedHost(current.hostname, originalHost) || current.port && !['80', '443'].includes(current.port)) {
      throw new Error('The website redirected outside the supplied domain.');
    }
    const addresses = await assertPublicHost(current.hostname);
    const client = current.protocol === 'https:' ? https : http;
    const response = await new Promise((resolve, reject) => {
      const request = client.request(current, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'BrokerIdFinder/1.0' },
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
        signal: AbortSignal.timeout(7000)
      }, resolve);
      request.on('error', reject);
      request.end();
    });

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location || redirects === 3) throw new Error('The website redirected too many times.');
      current = new URL(location, current);
      continue;
    }

    const contentType = response.headers['content-type'] ?? '';
    if (response.statusCode < 200 || response.statusCode >= 300 || !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      response.resume();
      return { status: response.statusCode, url: current.href, html: '' };
    }
    return { status: response.statusCode, url: current.href, html: await readResponse(response) };
  }
  throw new Error('The website could not be reached.');
}

function decodeText(value) {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;|&#160;/gi, ' ').trim();
}

function getPageTitle(html) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  return title ? decodeText(title.replace(/<[^>]+>/g, ' ')).slice(0, 140) : '';
}

function getCompanyName(html, hostname) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const key = tag.match(/(?:property|name)=["'](?:og:site_name|application-name)["']/i);
    const content = tag.match(/content=["']([^"']+)["']/i);
    if (key && content) return decodeText(content[1]).slice(0, 120);
  }

  const blocks = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/^.*?>|<\/script\s*>$/gi, '');
    try {
      const data = JSON.parse(json);
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        if (item.legalName && /organization|corporation|localbusiness/i.test(JSON.stringify(item['@type'] ?? ''))) {
          return String(item.legalName).slice(0, 120);
        }
        if (item.name && /organization|corporation|localbusiness/i.test(JSON.stringify(item['@type'] ?? ''))) {
          return String(item.name).slice(0, 120);
        }
        queue.push(...(Array.isArray(item['@graph']) ? item['@graph'] : []));
      }
    } catch {
      continue;
    }
  }

  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1];
  return decodeText((heading ?? '').replace(/<[^>]+>/g, ' ')) || getPageTitle(html).split(/[|–—-]/)[0].trim() || hostname;
}

function getRelevantLinks(html, base, originalHost) {
  const links = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  const pageTerms = /about|contact|broker|carrier|authority|agreement|legal|terms|privacy|company/i;
  for (const match of html.matchAll(pattern)) {
    const href = decodeText(match[1] ?? match[2] ?? match[3] ?? '');
    if (!href || href.startsWith('#') || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol !== base.protocol || !isAllowedHost(url.hostname, originalHost) || !pageTerms.test(url.pathname)) continue;
      url.hash = '';
      url.search = '';
      if (!links.includes(url.href)) links.push(url.href);
    } catch {
      continue;
    }
  }
  return links.slice(0, 7);
}

async function searchFmcsaByCompanyName(companyName) {
  const searchTerms = getCompanyNameTokens(companyName);
  if (!searchTerms.length) return [];
  const nameCondition = searchTerms.map((term) => `(upper(legal_name) like '%${term}%' OR upper(dba_name) like '%${term}%')`).join(' AND ');
  const url = new URL(FMCSA_API);
  url.searchParams.set('$where', nameCondition);
  url.searchParams.set('$select', 'dot_number,legal_name,dba_name,phone,status_code,docket1prefix,docket1,docket2prefix,docket2,docket3prefix,docket3');
  url.searchParams.set('$limit', '1000');

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`FMCSA returned HTTP ${response.status}.`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('FMCSA returned an unexpected response.');
  return matchFmcsaRecords(companyName, rows);
}

async function searchFmcsaByWebsiteIdentifiers(companyName, websiteIdentifiers) {
  const conditions = [];
  for (const item of websiteIdentifiers) {
    const number = String(item.number ?? '').replace(/\D/g, '').replace(/^0+/, '') || '0';
    if (!number) continue;
    if (item.kind === 'MC') {
      const docketFields = [1, 2, 3].map((index) => `(docket${index}prefix='MC' AND docket${index}='${number}')`);
      conditions.push(`(${docketFields.join(' OR ')})`);
    } else if (item.kind === 'DOT') {
      conditions.push(`dot_number=${Number(number)}`);
    }
  }
  if (!conditions.length) return [];

  const url = new URL(FMCSA_API);
  url.searchParams.set('$where', conditions.join(' OR '));
  url.searchParams.set('$select', 'dot_number,legal_name,dba_name,phone,status_code,docket1prefix,docket1,docket2prefix,docket2,docket3prefix,docket3');
  url.searchParams.set('$limit', '1000');

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`FMCSA returned HTTP ${response.status}.`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('FMCSA returned an unexpected response.');
  return matchFmcsaRecords(companyName, rows, websiteIdentifiers);
}

async function searchFmcsaIdentifier(kind, number) {
  const url = new URL(FMCSA_API);
  if (kind === 'MC') {
    const docketFields = [1, 2, 3].map((index) => `(docket${index}prefix='MC' AND docket${index}='${number}')`);
    url.searchParams.set('$where', docketFields.join(' OR '));
  } else {
    url.searchParams.set('$where', `dot_number=${Number(number)}`);
  }
  url.searchParams.set('$select', 'dot_number,legal_name,dba_name,phone,status_code,docket1prefix,docket1,docket2prefix,docket2,docket3prefix,docket3');
  url.searchParams.set('$limit', '20');

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`FMCSA returned HTTP ${response.status}.`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('FMCSA returned an unexpected response.');
  return rows.flatMap((row) => matchFmcsaRecords(row.legal_name || row.dba_name || '', [row], [{ kind, number }]));
}

async function getSaferSnapshot(kind, number) {
  const form = new URLSearchParams({
    query_type: 'queryCarrierSnapshot',
    query_param: kind === 'MC' ? 'MC_MX' : 'USDOT',
    query_string: number
  });
  const response = await fetch(SAFER_QUERY_URL, {
    method: 'POST',
    headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`SAFER returned HTTP ${response.status}.`);
  return parseSaferSnapshot(await response.text());
}

async function verifySaferMatches(matches) {
  const results = [...matches];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < results.length) {
      const index = nextIndex;
      nextIndex += 1;
      const match = results[index];
      try {
        results[index] = {
          ...applySaferVerification(match, await getSaferSnapshot('DOT', match.dotNumber)),
          saferCheckedAt: new Date().toISOString(),
          saferSourceUrl: 'https://safer.fmcsa.dot.gov/CompanySnapshot.aspx'
        };
      } catch {
        results[index] = {
          ...match, saferVerified: false, saferStatus: 'SAFER unavailable',
          saferCheckedAt: new Date().toISOString(),
          saferSourceUrl: 'https://safer.fmcsa.dot.gov/CompanySnapshot.aspx'
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, results.length) }, worker));
  return results;
}

async function verifyWebsiteIdentifiers(companyName, identifiers) {
  const results = [...identifiers];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < results.length) {
      const index = nextIndex;
      nextIndex += 1;
      const identifier = results[index];
      const number = identifier.number.replace(/^0+/, '') || '0';
      try {
        const snapshot = await getSaferSnapshot(identifier.kind, number);
        const exactIdentifier = snapshot && (identifier.kind === 'MC'
          ? snapshot.mcNumbers.includes(number)
          : snapshot.dotNumber === number);
        const sameCompany = snapshot && companyNamesMatch(companyName, snapshot.legalName);
        const verified = Boolean(exactIdentifier && sameCompany && snapshot.brokerAuthorized);
        results[index] = {
          ...identifier,
          verificationStatus: verified ? 'verified' : !snapshot ? 'not found in SAFER' : !exactIdentifier ? 'identifier conflict' : !sameCompany ? 'company name conflict' : 'no broker authority',
          checkedAt: new Date().toISOString(),
          saferSourceUrl: 'https://safer.fmcsa.dot.gov/CompanySnapshot.aspx',
          saferLegalName: snapshot?.legalName ?? null
        };
      } catch {
        results[index] = {
          ...identifier,
          verificationStatus: 'SAFER unavailable',
          checkedAt: new Date().toISOString(),
          saferSourceUrl: 'https://safer.fmcsa.dot.gov/CompanySnapshot.aspx'
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, results.length) }, worker));
  return results;
}

async function lookupDomain(hostname) {
  await assertPublicHost(hostname);
  const now = Date.now();
  const cached = cache.get(hostname);
  if (cached && now - cached.time < CACHE_TTL) return { ...cached.result, cached: true };

  const notes = [
    'FMCSA records are matched by the company name published on this domain; the dataset has no domain field.',
    'Only active FMCSA company registrations are included; confirm broker authority in SAFER.'
  ];
  let home;
  try {
    home = await fetchCompanyPage(new URL(`https://${hostname}/`), hostname);
  } catch (httpsError) {
    try {
      home = await fetchCompanyPage(new URL(`http://${hostname}/`), hostname);
    } catch {
      throw new Error(`Could not read the company website: ${httpsError.message}`);
    }
  }

  const homeUrl = new URL(home.url);
  const linkedPages = getRelevantLinks(home.html, homeUrl, hostname);
  const fallbackPaths = ['/contact', '/about', '/terms', '/terms-and-conditions', '/broker-carrier-agreement', '/carrier-agreement', '/carriers'];
  const agreementLinks = linkedPages.filter((href) => /agreement|terms|contract/i.test(new URL(href).pathname));
  const generalLinks = linkedPages.filter((href) => !agreementLinks.includes(href)).slice(0, 3);
  const fallbackUrls = fallbackPaths.map((path) => new URL(path, homeUrl).href);
  const pageUrls = [...new Set([...agreementLinks, ...generalLinks, ...fallbackUrls])].slice(0, 7);
  const subpages = await Promise.all(pageUrls.map(async (href) => {
    try { return await fetchCompanyPage(new URL(href), hostname); }
    catch { return null; }
  }));
  const pages = [home, ...subpages.filter((page) => page?.html)];
  const companyName = pages.map((page) => getCompanyName(page.html, hostname)).find((name) => name !== hostname) ?? hostname;
  const websiteIdentifiers = [...new Map(pages.flatMap((page) => extractIdentifiers(page.html, page.url))
    .map((item) => [`${item.kind}:${item.number}`, item])).values()];
  const [websiteIdMatches, reverseNameMatches] = await Promise.all([
    searchFmcsaByWebsiteIdentifiers(companyName, websiteIdentifiers),
    searchFmcsaByCompanyName(companyName)
  ]);
  const fmcsaMatches = await verifySaferMatches(mergeFmcsaMatches(websiteIdMatches, reverseNameMatches));
  const websiteMentions = await verifyWebsiteIdentifiers(companyName, websiteIdentifiers);
  const websiteConflicts = websiteMentions.filter((item) => item.verificationStatus !== 'verified');
  if (!fmcsaMatches.length) notes.push('No FMCSA MC broker records matched the company name found on the website.');

  const lookedUpAt = new Date().toISOString();
  const result = {
    lookupType: 'domain',
    domain: hostname,
    companyName,
    fmcsaMatches,
    scannedPages: pages.length,
    reverseSearchTerm: companyName,
    reverseSearchMatches: reverseNameMatches.length,
    verifiedWebsiteNumbers: fmcsaMatches.filter((match) => match.websiteNumberVerified && match.saferVerified).length,
    websiteMentions,
    websiteConflicts,
    checkedAt: lookedUpAt,
    fmcsaSource: { name: 'FMCSA Company Census File', url: FMCSA_DATASET_URL, updateFrequency: 'Daily' },
    primaryDot: fmcsaMatches[0]?.dotNumber ?? null,
    notes,
    lookedUpAt,
    createdAt: lookedUpAt,
    cached: false
  };
  cache.set(hostname, { time: Date.now(), result });
  return result;
}

async function lookupCompanyName(companyName) {
  const cacheKey = `company:${companyName.toLocaleLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { ...cached.result, cached: true };

  const fmcsaMatches = await verifySaferMatches(await searchFmcsaByCompanyName(companyName));
  const notes = [
    'FMCSA records are matched by legal or DBA name; similar names may refer to different businesses.',
    'Only active FMCSA company registrations are included; confirm broker authority in SAFER.'
  ];
  if (!fmcsaMatches.length) notes.push('No FMCSA MC broker records matched this company name.');

  const lookedUpAt = new Date().toISOString();
  const result = {
    lookupType: 'company',
    domain: null,
    companyName,
    fmcsaMatches,
    fmcsaSource: { name: 'FMCSA Company Census File', url: FMCSA_DATASET_URL, updateFrequency: 'Daily' },
    primaryDot: fmcsaMatches[0]?.dotNumber ?? null,
    notes,
    lookedUpAt,
    createdAt: lookedUpAt,
    cached: false
  };
  cache.set(cacheKey, { time: Date.now(), result });
  return result;
}

async function lookupIdentifier(kind, number) {
  const cacheKey = `identifier:${kind}:${number}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { ...cached.result, cached: true };

  const fmcsaMatches = await verifySaferMatches(await searchFmcsaIdentifier(kind, number));
  const companyName = fmcsaMatches[0]?.legalName || `${kind} ${number}`;
  const notes = ['Exact FMCSA census lookup; SAFER confirms broker authority per result.'];
  if (!fmcsaMatches.length) notes.push(`No active FMCSA company record was found for this ${kind} number.`);

  const lookedUpAt = new Date().toISOString();
  const result = {
    lookupType: 'identifier',
    identifierKind: kind,
    identifierNumber: number,
    domain: null,
    companyName,
    fmcsaMatches,
    fmcsaSource: { name: 'FMCSA Company Census File', url: FMCSA_DATASET_URL, updateFrequency: 'Daily' },
    primaryDot: fmcsaMatches[0]?.dotNumber ?? null,
    notes,
    lookedUpAt,
    createdAt: lookedUpAt,
    cached: false
  };
  cache.set(cacheKey, { time: Date.now(), result });
  return result;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function serveStatic(pathname, response) {
  let requested;
  try { requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch { response.writeHead(400).end(); return; }
  const target = resolve(PUBLIC_DIR, `.${requested}`);
  if (!target.startsWith(`${PUBLIC_DIR}${sep}`)) { response.writeHead(403).end(); return; }
  try {
    const info = await stat(target);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404).end();
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/lookup' && request.method === 'GET') {
    try {
      const name = url.searchParams.get('name');
      if (name !== null) {
        sendJson(response, 200, await lookupCompanyName(parseCompanyName(name)));
        return;
      }
      const mc = url.searchParams.get('mc');
      if (mc !== null) {
        sendJson(response, 200, await lookupIdentifier('MC', parseCarrierIdentifier(mc, 'MC')));
        return;
      }
      const dot = url.searchParams.get('dot');
      if (dot !== null) {
        sendJson(response, 200, await lookupIdentifier('DOT', parseCarrierIdentifier(dot, 'DOT')));
        return;
      }
      const domain = parseDomain(url.searchParams.get('domain'));
      sendJson(response, 200, await lookupDomain(domain));
    } catch (error) {
      const clientError = /Enter a |public company domain|port or sign-in|Company names must|valid (?:MC|DOT) number/.test(error.message);
      sendJson(response, clientError ? 400 : 502, { error: error.message || 'Lookup failed.' });
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  await serveStatic(url.pathname, response);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Broker ID Finder is running at http://localhost:${PORT}`);
});
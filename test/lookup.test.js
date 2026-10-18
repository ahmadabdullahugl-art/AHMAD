import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySaferVerification, companyNamesMatch, extractIdentifiers, getCompanyNameTokens, getEmailVerdict, getOrganizationDomain, inspectDmarc,
  inspectSpf, matchFmcsaRecords, mergeFmcsaMatches, parseCarrierIdentifier, parseCompanyName, parseDomain, parseSaferSnapshot
} from '../lib/lookup.js';

test('normalizes company URLs to a public hostname', () => {
  assert.equal(parseDomain('https://www.example.com/about'), 'example.com');
  assert.throws(() => parseDomain('http://127.0.0.1'), /public company domain/);
  assert.throws(() => parseDomain('example.com:8080'), /without a port/);
});

test('validates and normalizes direct company-name searches', () => {
  assert.equal(parseCompanyName('  C.H.   Robinson  '), 'C.H. Robinson');
  assert.throws(() => parseCompanyName('A'), /at least two characters/);
  assert.throws(() => parseCompanyName('123456'), /at least two characters/);
  assert.throws(() => parseCompanyName('x'.repeat(121)), /120 characters or fewer/);
});

test('accepts direct MC and DOT identifiers with optional prefixes', () => {
  assert.equal(parseCarrierIdentifier('MC-00131029', 'MC'), '131029');
  assert.equal(parseCarrierIdentifier('USDOT 002211804', 'DOT'), '2211804');
  assert.throws(() => parseCarrierIdentifier('not-a-number', 'MC'), /valid MC number/);
  assert.throws(() => parseCarrierIdentifier('12', 'MC'), /valid MC number/);
});

test('normalizes dotted company initials for FMCSA search terms', () => {
  assert.deepEqual(getCompanyNameTokens('C.H. Robinson'), ['CH', 'ROBINSON']);
  assert.deepEqual(getCompanyNameTokens('C. H. Robinson Company LLC'), ['CH', 'ROBINSON']);
});

test('compares legal names without treating unrelated shared terms as a match', () => {
  assert.equal(companyNamesMatch('Summit Logistics Group', 'SUMMIT LOGISTICS GROUP LLC'), true);
  assert.equal(companyNamesMatch('Summit Logistics Group', 'Blue Summit Logistics LLC'), false);
});

test('extracts distinct MC and USDOT candidates with their source', () => {
  const candidates = extractIdentifiers(
    '<p>MC Number: 123456, MC-123456, USDOT 7654321 and DOT No. 7654321</p>',
    'https://example.com/about'
  );
  assert.deepEqual(candidates.map(({ kind, number }) => `${kind}:${number}`), ['MC:123456', 'DOT:7654321']);
  assert.equal(candidates[0].foundOn, 'https://example.com/about');
});

test('matches company names to active census records and excludes inactive or weak matches', () => {
  const matches = matchFmcsaRecords('C.H. Robinson', [
    { dot_number: '02211804', phone: '952-937-8500', status_code: 'A', docket1prefix: 'MC', docket1: '131029', legal_name: 'CH ROBINSON COMPANY LLC', dba_name: 'C.H. ROBINSON WORLDWIDE' },
    { dot_number: '02213842', phone: '952-937-8500', status_code: 'A', docket1prefix: 'MC', docket1: '200852', legal_name: 'C H ROBINSON COMPANY CANADA LTD', dba_name: 'LA COMPAGNIE C H ROBINSON CANADA LTEE' },
    { dot_number: '00000000', status_code: 'A', docket1prefix: 'FF', docket1: '002008', legal_name: 'CH ROBINSON COMPANY' },
    { dot_number: '00073105', status_code: 'I', docket1prefix: 'MC', docket1: '025440', legal_name: 'ROBINSON EDWIN' },
    { dot_number: '02231994', status_code: 'A', docket1prefix: 'MC', docket1: '481616', legal_name: 'CH ROBINSON FREIGHT SERVICES LTD' }
  ]);

  assert.deepEqual(matches.map((match) => match.docketNumber), ['MC131029', 'MC481616']);
  assert.equal(matches[0].matchStrength, 'strong');
  assert.equal(matches[0].dotNumber, '2211804');
  assert.equal(matches[0].phoneNumber, '952-937-8500');
  assert.equal(matches[1].matchStrength, 'possible');
});

test('merges name-reverse results with exact website-ID matches without losing evidence', () => {
  const merged = mergeFmcsaMatches(
    [{ docketNumber: 'MC131029', dotNumber: '2211804', legalName: 'CH ROBINSON COMPANY LLC', matchScore: 0.9 }],
    [{ docketNumber: 'MC131029', dotNumber: '2211804', legalName: 'CH ROBINSON COMPANY LLC', websiteNumberVerified: true, websiteSourceUrl: 'https://example.com/carriers', matchScore: 1 }]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].websiteNumberVerified, true);
  assert.equal(merged[0].websiteSourceUrl, 'https://example.com/carriers');
});

test('verifies an exact website MC even when the extracted company name is weak', () => {
  const matches = matchFmcsaRecords('Logistics Home', [
    { dot_number: '2211804', phone: '9529378500', status_code: 'A', docket1prefix: 'MC', docket1: '131029', legal_name: 'CH ROBINSON COMPANY LLC' }
  ], [{ kind: 'MC', number: '00131029', foundOn: 'https://example.com/carriers' }]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].docketNumber, 'MC131029');
  assert.equal(matches[0].websiteNumberVerified, true);
  assert.equal(matches[0].matchStrength, 'verified');
  assert.equal(matches[0].websiteSourceUrl, 'https://example.com/carriers');
});

test('parses official SAFER MC, DOT, phone, and broker authorization fields', () => {
  const snapshot = parseSaferSnapshot(`
    <title>SAFER Web - Company Snapshot CH ROBINSON COMPANY LLC</title>
    <tr><th>USDOT Number:</th><td>2211804&nbsp;</td></tr>
    <tr><th>Operating Authority Status:</th><td>AUTHORIZED FOR:<br>Broker of Property (Except Household Goods)</td></tr>
    <tr><th>MC/MX/FF Number(s):</th><td><a>MC-131029</a></td></tr>
    <tr><th>Phone:</th><td>(952) 937-8500</td></tr>
  `);

  assert.equal(snapshot.dotNumber, '2211804');
  assert.deepEqual(snapshot.mcNumbers, ['131029']);
  assert.equal(snapshot.phoneNumber, '(952) 937-8500');
  assert.equal(snapshot.brokerAuthorized, true);
  assert.equal(parseSaferSnapshot('<title>SAFER Web - Company Snapshot RECORD NOT FOUND</title>'), null);
});

test('only marks a matching MC and DOT as verified when SAFER confirms broker authority', () => {
  const match = { docketNumber: 'MC131029', dotNumber: '2211804', phoneNumber: '9529378500', legalName: 'CH ROBINSON COMPANY LLC' };
  const verified = applySaferVerification(match, {
    dotNumber: '2211804', mcNumbers: ['131029'], phoneNumber: '(952) 937-8500',
    legalName: 'CH ROBINSON COMPANY LLC', brokerAuthorized: true
  });

  assert.equal(verified.saferVerified, true);
  assert.equal(verified.saferStatus, 'SAFER confirmed');
  assert.equal(verified.phoneNumber, '(952) 937-8500');
  assert.equal(applySaferVerification(match, { dotNumber: '2211804', mcNumbers: [], brokerAuthorized: false }).saferVerified, false);
  assert.equal(applySaferVerification(match, {
    dotNumber: '2211804', mcNumbers: ['131029'], legalName: 'BLUE SUMMIT LOGISTICS LLC', brokerAuthorized: true
  }).saferStatus, 'Company name mismatch');
});

test('uses a registrable parent for common multi-label public suffixes', () => {
  assert.equal(getOrganizationDomain('portal.example.co.uk'), 'example.co.uk');
  assert.equal(getOrganizationDomain('mail.example.com'), 'example.com');
});

test('scores SPF and DMARC enforcement without overstating monitoring policy', () => {
  const spf = inspectSpf(['v=spf1 include:_spf.example.com -all']);
  const strictDmarc = inspectDmarc('v=DMARC1; p=reject; rua=mailto:dmarc@example.com', 'example.com');
  const monitoringDmarc = inspectDmarc('v=DMARC1; p=none');

  assert.equal(spf.status, 'pass');
  assert.equal(spf.dnsLookups, 1);
  assert.equal(strictDmarc.status, 'pass');
  assert.equal(monitoringDmarc.status, 'warn');
  assert.equal(getEmailVerdict(spf, strictDmarc), 'protected');
  assert.equal(getEmailVerdict(inspectSpf([]), inspectDmarc(null)), 'exposed');
});
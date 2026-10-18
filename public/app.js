const form = document.querySelector('#lookup-form');
const input = document.querySelector('#domain-input');
const searchButton = document.querySelector('#search-button');
const lookupError = document.querySelector('#lookup-error');
const welcomeState = document.querySelector('#welcome-state');
const resultToolbar = document.querySelector('#result-toolbar');
const resultsLayout = document.querySelector('#results-layout');
const inputLabel = document.querySelector('#input-label');
const helpText = document.querySelector('#domain-help-text');
const exampleButton = document.querySelector('.example-link');
const identifierKind = document.querySelector('#identifier-kind');
const recentPanel = document.querySelector('#recent-panel');
const recentList = document.querySelector('#recent-list');
const RECENT_LOOKUPS_KEY = 'broker-id-finder-history';
let searchMode = 'domain';
let recentLookups = loadRecentLookups();

document.querySelector('#today-label').textContent = new Intl.DateTimeFormat('en', {
  month: 'short', day: '2-digit', year: 'numeric'
}).format(new Date()).toUpperCase();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function loadRecentLookups() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_LOOKUPS_KEY) || '[]');
    return Array.isArray(saved) ? saved.slice(0, 12) : [];
  } catch {
    return [];
  }
}

function renderRecentLookups() {
  recentPanel.hidden = recentLookups.length === 0;
  recentList.innerHTML = recentLookups.map((item, index) => {
    const label = item.domain || (item.lookupType === 'identifier' ? `${item.identifierKind}-${item.identifierNumber}` : item.companyName);
    const primary = item.fmcsaMatches?.[0];
    const detail = primary ? `${primary.docketNumber} · ${primary.saferVerified ? 'SAFER verified' : primary.saferStatus}` : 'No MC match';
    return `<button class="recent-item" type="button" data-recent-index="${index}"><span class="recent-item-name">${escapeHtml(label)}</span><span class="recent-item-detail">${escapeHtml(detail)}</span></button>`;
  }).join('');
}

function saveRecentLookup(result) {
  const saved = {
    lookupType: result.lookupType,
    identifierKind: result.identifierKind,
    identifierNumber: result.identifierNumber,
    domain: result.domain,
    companyName: result.companyName,
    fmcsaMatches: (result.fmcsaMatches ?? []).map(({ docketNumber, dotNumber, phoneNumber, legalName, dbaName, matchStrength, websiteNumberVerified, websiteSourceUrl, saferVerified, saferStatus, saferCheckedAt, saferSourceUrl }) => ({
      docketNumber, dotNumber, phoneNumber, legalName, dbaName, matchStrength, websiteNumberVerified,
      websiteSourceUrl, saferVerified, saferStatus, saferCheckedAt, saferSourceUrl
    })),
    websiteMentions: result.websiteMentions ?? [],
    fmcsaSource: result.fmcsaSource,
    lookedUpAt: result.lookedUpAt,
    cached: true
  };
  const key = getLookupKey(saved);
  recentLookups = [saved, ...recentLookups.filter((item) => getLookupKey(item) !== key)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_LOOKUPS_KEY, JSON.stringify(recentLookups));
  } catch {
    recentLookups = recentLookups.slice(0, 12);
  }
  renderRecentLookups();
}

function getLookupKey(item) {
  if (item.lookupType === 'identifier') return `identifier:${item.identifierKind}:${item.identifierNumber}`.toLowerCase();
  return `${item.lookupType}:${item.domain || item.companyName}`.toLowerCase();
}

function saferUrl(kind, number) {
  const params = new URLSearchParams({
    query_param: kind === 'MC' ? 'MC_MX' : 'USDOT',
    query_string: number,
    query_type: 'queryCarrierSnapshot',
    searchtype: 'ANY'
  });
  return `https://safer.fmcsa.dot.gov/CompanySnapshot.aspx?${params}`;
}

function renderFmcsaMatch(match) {
  const phone = match.phoneNumber ? formatPhoneNumber(match.phoneNumber) : 'Not listed';
  const phoneValue = match.phoneNumber ? `<a href="tel:${escapeHtml(match.phoneNumber.replace(/[^+\d]/g, ''))}">${escapeHtml(phone)}</a>` : escapeHtml(phone);
  const truckCodexSearch = new URL('https://www.google.com/search');
  truckCodexSearch.searchParams.set('q', `site:truckcodex.com ${match.docketNumber}`);
  const checkedAt = match.saferCheckedAt ? new Date(match.saferCheckedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable';
  const websiteSource = match.websiteSourceUrl ? `<a class="evidence-link" href="${escapeHtml(match.websiteSourceUrl)}" target="_blank" rel="noreferrer">Website evidence ↗</a>` : '';
  const statusLabel = match.saferVerified ? 'SAFER VERIFIED' : match.saferStatus?.toUpperCase() || 'NOT VERIFIED';
  return `<article class="identifier-row fmcsa-row">
    <div class="fmcsa-fields">
      <div class="fmcsa-field"><span>MC</span><strong>${escapeHtml(match.docketNumber)}</strong></div>
      <div class="fmcsa-field"><span>DOT</span><strong>${escapeHtml(match.dotNumber)}</strong></div>
      <div class="fmcsa-field phone-field"><span>PHONE</span><strong>${phoneValue}</strong></div>
    </div>
    <div class="fmcsa-match-detail"><span class="registered-name">${escapeHtml(match.legalName || match.dbaName || 'Registered carrier')}</span>${websiteSource}</div>
    <div class="match-actions"><span class="safer-status ${match.saferVerified ? 'is-verified' : ''}">${escapeHtml(statusLabel)}</span><span class="match-checked-date">Checked ${escapeHtml(checkedAt)}</span><a class="verify-link" href="${saferUrl('MC', match.docketNumber.replace(/^MC/i, ''))}" target="_blank" rel="noreferrer">FMCSA SAFER ↗</a><a class="verify-link truckcodex-link" href="${truckCodexSearch.href}" target="_blank" rel="noreferrer">TruckCodex ↗</a></div>
  </article>`;
}

function renderWebsiteConflict(item) {
  const labels = {
    'SAFER unavailable': 'SAFER unavailable',
    'not found in SAFER': 'No SAFER record',
    'identifier conflict': 'MC/DOT mismatch',
    'company name conflict': 'Legal name mismatch',
    'no broker authority': 'No broker authority'
  };
  const status = labels[item.verificationStatus] ?? item.verificationStatus;
  const checkedAt = item.checkedAt ? new Date(item.checkedAt).toLocaleDateString() : 'Date unavailable';
  return `<div class="conflict-row"><span class="conflict-id">${escapeHtml(item.kind)}-${escapeHtml(item.number)}</span><a href="${escapeHtml(item.foundOn)}" target="_blank" rel="noreferrer">Website source ↗</a><a href="${saferUrl(item.kind, item.number)}" target="_blank" rel="noreferrer">SAFER ↗</a><span class="conflict-status">${escapeHtml(status)}</span><span class="conflict-date">${escapeHtml(checkedAt)}</span></div>`;
}

function formatPhoneNumber(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return value;
}

function renderResult(result) {
  const host = result.domain;
  const companyName = result.companyName || host;
  const lookupLabel = result.lookupType === 'identifier'
    ? `${result.identifierKind} ${result.identifierNumber} SEARCH`
    : host || 'FMCSA NAME SEARCH';
  document.querySelector('#result-domain').textContent = lookupLabel;
  document.querySelector('#company-name').textContent = companyName;
  document.querySelector('#company-avatar').textContent = companyName.trim().charAt(0).toUpperCase();
  document.querySelector('.company-info .mini-label').textContent = result.lookupType === 'identifier' ? 'DIRECT ID LOOKUP' : host ? 'WEBSITE NAME' : 'COMPANY NAME SEARCH';
  const website = document.querySelector('#company-domain-link');
  website.hidden = !host;
  if (host) {
    website.href = `https://${host}`;
    website.textContent = host;
  }
  const timestamp = new Date(result.lookedUpAt);
  document.querySelector('#scan-time').textContent = `${host ? 'LOOKED UP' : 'SEARCHED'} ${timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const fmcsaMatches = result.fmcsaMatches ?? [];
  document.querySelector('#identifier-count').textContent = String(fmcsaMatches.length).padStart(2, '0');
  document.querySelector('#identifier-list').innerHTML = fmcsaMatches.map(renderFmcsaMatch).join('');
  document.querySelector('#empty-identifiers').hidden = fmcsaMatches.length !== 0;
  const conflicts = (result.websiteMentions ?? []).filter((item) => item.verificationStatus !== 'verified');
  document.querySelector('#evidence-conflicts').hidden = conflicts.length === 0;
  document.querySelector('#conflict-list').innerHTML = conflicts.map(renderWebsiteConflict).join('');
  const source = document.querySelector('#fmcsa-source');
  if (result.fmcsaSource) {
    source.href = result.fmcsaSource.url;
    source.textContent = `${result.fmcsaSource.name} · updated daily ↗`;
  }
  const reverseSearchNote = document.querySelector('#reverse-search-note');
  reverseSearchNote.hidden = result.lookupType !== 'domain';
  if (result.lookupType === 'domain') {
    reverseSearchNote.textContent = `FMCSA reverse name search: “${result.reverseSearchTerm || companyName}” · ${result.reverseSearchMatches ?? 0} name matches`;
  }

  document.querySelector('#result-state').textContent = result.cached ? 'CACHED LOOKUP' : 'LOOKUP COMPLETE';
  welcomeState.hidden = true;
  resultToolbar.hidden = false;
  resultsLayout.hidden = false;
}

function setSearchMode(mode) {
  searchMode = mode;
  const isCompanySearch = mode === 'company';
  const isIdentifierSearch = mode === 'identifier';
  input.value = '';
  document.querySelector('#search-title').textContent = isCompanySearch ? 'Search by company name' : isIdentifierSearch ? 'Look up an MC or DOT number' : 'Search by company domain';
  inputLabel.textContent = isCompanySearch ? 'Company name' : isIdentifierSearch ? 'Carrier identifier' : 'Company domain';
  input.name = isCompanySearch ? 'name' : isIdentifierSearch ? identifierKind.value.toLowerCase() : 'domain';
  input.autocomplete = isCompanySearch ? 'organization' : isIdentifierSearch ? 'off' : 'url';
  input.placeholder = isCompanySearch ? 'C.H. Robinson' : isIdentifierSearch ? identifierKind.value === 'MC' ? 'MC-123456' : 'USDOT 1234567' : 'example.com';
  input.closest('.domain-input-wrap').classList.toggle('has-identifier-kind', isIdentifierSearch);
  identifierKind.hidden = !isIdentifierSearch;
  document.querySelector('.input-suffix').textContent = isCompanySearch ? 'COMPANY' : isIdentifierSearch ? 'NUMBER' : 'DOMAIN';
  helpText.textContent = isCompanySearch ? 'Searches company legal and DBA names in FMCSA.' : isIdentifierSearch ? 'Looks up this exact identifier, then confirms it with SAFER.' : 'No protocol needed. Example:';
  exampleButton.hidden = isCompanySearch || isIdentifierSearch;
  searchButton.querySelector('span').textContent = isCompanySearch ? 'Search company' : isIdentifierSearch ? 'Verify number' : 'Find MC numbers';
  document.querySelectorAll('.mode-button').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function lookup(value) {
  searchButton.disabled = true;
  searchButton.querySelector('span').textContent = searchMode === 'company' ? 'Searching FMCSA' : searchMode === 'identifier' ? 'Checking SAFER' : 'Looking up domain';
  searchButton.classList.add('is-loading');
  lookupError.hidden = true;
  try {
    const parameter = searchMode === 'company' ? 'name' : searchMode === 'identifier' ? identifierKind.value.toLowerCase() : 'domain';
    const response = await fetch(`/api/lookup?${parameter}=${encodeURIComponent(value)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Lookup failed.');
    renderResult(result);
    saveRecentLookup(result);
  } catch (error) {
    lookupError.textContent = error.message || 'Lookup failed. Please check the domain and try again.';
    lookupError.hidden = false;
  } finally {
    searchButton.disabled = false;
    searchButton.querySelector('span').textContent = searchMode === 'company' ? 'Search company' : searchMode === 'identifier' ? 'Verify number' : 'Find MC numbers';
    searchButton.classList.remove('is-loading');
  }
}

document.querySelectorAll('.mode-button').forEach((button) => {
  button.addEventListener('click', () => setSearchMode(button.dataset.mode));
});

recentList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-recent-index]');
  if (!button) return;
  const result = recentLookups[Number(button.dataset.recentIndex)];
  if (!result) return;
  setSearchMode(result.lookupType === 'identifier' ? 'identifier' : result.lookupType === 'company' ? 'company' : 'domain');
  if (result.lookupType === 'identifier') {
    identifierKind.value = result.identifierKind;
    setSearchMode('identifier');
    input.value = result.identifierNumber;
  } else {
    input.value = result.domain || result.companyName;
  }
  renderResult(result);
});

document.querySelector('#clear-history').addEventListener('click', () => {
  recentLookups = [];
  try { localStorage.removeItem(RECENT_LOOKUPS_KEY); } catch {}
  renderRecentLookups();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (input.value.trim()) lookup(input.value.trim());
});

document.querySelectorAll('[data-domain]').forEach((button) => {
  button.addEventListener('click', () => {
    input.value = button.dataset.domain;
    input.focus();
  });
});

identifierKind.addEventListener('change', () => {
  if (searchMode !== 'identifier') return;
  input.name = identifierKind.value.toLowerCase();
  input.placeholder = identifierKind.value === 'MC' ? 'MC-123456' : 'USDOT 1234567';
});

document.querySelector('#new-search').addEventListener('click', () => {
  input.value = '';
  resultToolbar.hidden = true;
  resultsLayout.hidden = true;
  welcomeState.hidden = false;
  input.focus();
});

renderRecentLookups();